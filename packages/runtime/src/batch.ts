import type {
  ForecastAnswer,
  ForecastResult,
  ForecastTask,
  InformationPolicy
} from "@raven-gonna-test/forecast-core";
import { ForecastEngine } from "@raven-gonna-test/forecast-core";
import { writeJsonAtomic } from "./artifacts.js";

export interface BatchOptions {
  concurrency: number;
  checkpointPath?: string;
  checkpointEvery?: number;
  checkpointIdentity?: Record<string, string | number | boolean>;
  resumeResults?: ReadonlyMap<string, ForecastResult>;
  forecastOptions?: Parameters<ForecastEngine["forecast"]>[2];
  fallbackFor?: (task: ForecastTask) => ForecastAnswer | undefined;
  onProgress?: (completed: number, total: number, task: ForecastTask, result: ForecastResult) => void;
}

export async function runForecastBatch(
  tasks: readonly ForecastTask[],
  engine: ForecastEngine,
  policyFor: (task: ForecastTask) => InformationPolicy,
  options: BatchOptions
): Promise<ForecastResult[]> {
  const resultById = new Map(options.resumeResults ?? []);
  const pending = tasks.filter((task) => !resultById.has(task.taskId));
  let next = 0;
  let completed = resultById.size;
  let checkpointChain = Promise.resolve();

  const writeCheckpoint = async (): Promise<void> => {
    if (!options.checkpointPath) return;
    const ordered = tasks.flatMap((candidate) => {
      const value = resultById.get(candidate.taskId);
      return value ? [value] : [];
    });
    await writeJsonAtomic(options.checkpointPath, {
      schemaVersion: "raven-gonna-test.checkpoint.v1",
      updatedAtUtc: new Date().toISOString(),
      identity: options.checkpointIdentity ?? {},
      completed: ordered.length,
      total: tasks.length,
      results: ordered
    });
  };

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      const task = pending[index];
      if (!task) return;
      const fallback = options.fallbackFor?.(task);
      const forecastOptions = { ...(options.forecastOptions ?? {}) };
      if (fallback !== undefined) forecastOptions.fallback = fallback;
      const result = await engine.forecast(task, policyFor(task), forecastOptions);
      resultById.set(task.taskId, result);
      completed += 1;
      options.onProgress?.(completed, tasks.length, task, result);
      const checkpointEvery = options.checkpointEvery ?? 25;
      if (options.checkpointPath && (completed % checkpointEvery === 0 || completed === tasks.length)) {
        checkpointChain = checkpointChain.then(writeCheckpoint);
        await checkpointChain;
      }
    }
  }

  const count = Math.max(1, Math.min(options.concurrency, pending.length || 1));
  await Promise.all(Array.from({ length: count }, () => worker()));
  if (options.checkpointPath) {
    checkpointChain = checkpointChain.then(writeCheckpoint);
    await checkpointChain;
  }
  return tasks.map((task) => {
    const result = resultById.get(task.taskId);
    if (!result) throw new Error(`Missing batch result for ${task.taskId}.`);
    return result;
  });
}
