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
  /**
   * Per-task overrides merged over forecastOptions. Exists so spend can follow
   * a benchmark's own weighting instead of being uniform across every task.
   */
  forecastOptionsFor?: (task: ForecastTask) => Parameters<ForecastEngine["forecast"]>[2];
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
      const forecastOptions = { ...(options.forecastOptions ?? {}), ...(options.forecastOptionsFor?.(task) ?? {}) };
      if (fallback !== undefined) forecastOptions.fallback = fallback;
      let result: ForecastResult;
      try {
        result = await engine.forecast(task, policyFor(task), forecastOptions);
      } catch (error) {
        // One pathological task must not reject Promise.all and abandon the
        // other 79. Where a fallback answer is available the batch degrades to
        // it and says so; without one there is nothing to submit for this task
        // and the failure is genuinely fatal.
        if (fallback === undefined) throw error;
        result = {
          schemaVersion: "raven-gonna-test.forecast-result.v1",
          taskId: task.taskId,
          answer: fallback,
          trials: [],
          model: engine.modelId,
          strategyId: "batch-fallback",
          policyId: policyFor(task).id,
          generatedAtUtc: new Date().toISOString(),
          fallbackUsed: true,
          warnings: [`Forecast threw; substituted fallback answer: ${error instanceof Error ? error.message : String(error)}`]
        };
      }
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
