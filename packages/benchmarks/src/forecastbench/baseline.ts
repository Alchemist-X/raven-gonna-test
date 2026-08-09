import type { ForecastAnswer } from "@raven-gonna-test/forecast-core";
import type { ForecastBenchExpandedTask } from "./adapter.js";
import { forecastBenchQuestionKey } from "./adapter.js";

export interface ForecastBenchBaseline {
  probability: number;
  reason: string;
}

function clip(value: number): number {
  return Math.max(0.01, Math.min(0.99, value));
}

export function sourceBaseline(
  item: ForecastBenchExpandedTask,
  freshMarketProbabilityByQuestion?: ReadonlyMap<string, number>
): ForecastBenchBaseline {
  if (item.category === "market") {
    const fresh = freshMarketProbabilityByQuestion?.get(forecastBenchQuestionKey(item.source, item.id));
    if (fresh !== undefined && Number.isFinite(fresh) && fresh >= 0 && fresh <= 1) {
      return { probability: clip(fresh), reason: "fresh-market-probability" };
    }
    const frozen = Number(item.question.freeze_datetime_value);
    if (Number.isFinite(frozen) && frozen >= 0 && frozen <= 1) {
      return { probability: clip(frozen), reason: "forecastbench-freeze-value" };
    }
    return { probability: 0.5, reason: "market-uninformative-fallback" };
  }
  const text = item.question.question.toLocaleLowerCase();
  switch (item.source) {
    case "acled":
      return text.includes("ten times")
        ? { probability: 0.01, reason: "acled-10x-historical-prior" }
        : { probability: 0.23, reason: "acled-increase-historical-prior" };
    case "dbnomics":
      return { probability: 0.56, reason: "dbnomics-source-prior" };
    case "fred":
      return { probability: 0.42, reason: "fred-source-prior" };
    case "yfinance":
      return { probability: 0.5, reason: "yfinance-random-walk-prior" };
    case "wikipedia":
      if (text.includes("vaccine have been developed")) return { probability: 0.01, reason: "wikipedia-vaccine-prior" };
      if (text.includes("elo rating") && text.includes("at least 1% higher")) return { probability: 0.01, reason: "wikipedia-elo-1pct-prior" };
      if (text.includes("fide ranking") && text.includes("as high or higher")) return { probability: 0.68, reason: "wikipedia-fide-rank-prior" };
      if (text.includes("still hold the world record")) return { probability: 0.99, reason: "wikipedia-record-retention-prior" };
      return { probability: 0.5, reason: "wikipedia-unknown-template" };
    default:
      return { probability: 0.5, reason: "unknown-source-prior" };
  }
}

export function baselineAnswer(item: ForecastBenchExpandedTask): ForecastAnswer {
  return { kind: "binary", pYes: sourceBaseline(item).probability };
}

