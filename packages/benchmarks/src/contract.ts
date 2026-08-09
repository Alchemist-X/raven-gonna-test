import type { ForecastResult, ForecastTask, InformationPolicy } from "@raven-gonna-test/forecast-core";

export interface ValidationReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
  stats: Record<string, number | string | boolean | null>;
}

export interface BenchmarkAdapter<RawInput, Submission> {
  parseInput(raw: RawInput): ForecastTask[];
  policyFor(task: ForecastTask): InformationPolicy;
  serialize(results: ForecastResult[]): Submission;
  validate(submission: Submission): ValidationReport;
}

