import type { EvidenceRecord, ForecastTask, InformationPolicy } from "./contracts.js";

export const MARKET_PRICE_SOURCE_CLASSES = new Set([
  "prediction_market_price",
  "benchmark_supplied_prior"
] as const);

function hostname(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

function matchesDomain(host: string, domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^\./, "");
  return host === normalized || host.endsWith(`.${normalized}`);
}

export function validatePolicyForTask(task: ForecastTask, policy: InformationPolicy): void {
  if (new Date(policy.asOfUtc).getTime() !== new Date(task.asOfUtc).getTime()) {
    throw new Error(`Policy as-of ${policy.asOfUtc} does not match task as-of ${task.asOfUtc}.`);
  }
  if (task.origin.benchmark === "prophet-arena" && policy.suppliedMarketStats !== "anchor") {
    throw new Error("Prophet Arena jobs must explicitly anchor supplied market statistics.");
  }
  if (
    task.origin.benchmark === "forecastbench" &&
    task.origin.source &&
    ["dbnomics", "fred", "yfinance", "acled", "wikipedia"].includes(task.origin.source) &&
    policy.predictionMarket === "anchor"
  ) {
    throw new Error("ForecastBench dataset questions cannot use prediction-market anchors.");
  }
}

export function validateEvidence(record: EvidenceRecord, policy: InformationPolicy): void {
  const cutoff = new Date(policy.asOfUtc).getTime();
  const times = [record.publishedAtUtc, record.observedValueAtUtc].filter(
    (value): value is string => value !== undefined
  );
  for (const value of times) {
    if (new Date(value).getTime() > cutoff) {
      throw new Error(`Evidence ${record.id} is after the cutoff: ${value} > ${policy.asOfUtc}`);
    }
  }

  const host = hostname(record.url);
  if (policy.blockedDomains?.some((domain) => matchesDomain(host, domain))) {
    throw new Error(`Evidence ${record.id} comes from blocked domain ${host}.`);
  }
  if (policy.allowedDomains && !policy.allowedDomains.some((domain) => matchesDomain(host, domain))) {
    throw new Error(`Evidence ${record.id} is outside the policy domain allowlist.`);
  }

  if (record.sourceClass === "prediction_market_price") {
    const allowed = policy.predictionMarket === "observe" || policy.predictionMarket === "anchor";
    if (!allowed) throw new Error(`Policy ${policy.id} forbids prediction-market prices.`);
  }
  if (record.sourceClass === "benchmark_supplied_prior" && policy.suppliedMarketStats === "deny") {
    throw new Error(`Policy ${policy.id} forbids supplied market statistics.`);
  }
  if (record.sourceClass === "financial_market_data" && policy.financialMarketData === "deny") {
    throw new Error(`Policy ${policy.id} forbids financial-market data.`);
  }
}

export function futureXPolicy(asOfUtc: string): InformationPolicy {
  return {
    id: "futurex-live-web-v1",
    asOfUtc,
    web: "allow",
    predictionMarket: "observe",
    suppliedMarketStats: "deny",
    financialMarketData: "allow",
    postCutoffEvidence: "reject"
  };
}

export function forecastBenchMarketPolicy(asOfUtc: string): InformationPolicy {
  return {
    id: "forecastbench-market-anchor-v1",
    asOfUtc,
    web: "allow",
    predictionMarket: "anchor",
    suppliedMarketStats: "deny",
    financialMarketData: "allow",
    postCutoffEvidence: "reject"
  };
}

export function forecastBenchDatasetPolicy(asOfUtc: string): InformationPolicy {
  return {
    id: "forecastbench-dataset-v1",
    asOfUtc,
    web: "allow",
    predictionMarket: "deny",
    suppliedMarketStats: "deny",
    financialMarketData: "allow",
    postCutoffEvidence: "reject"
  };
}

export function prophetArenaPolicy(asOfUtc: string): InformationPolicy {
  return {
    id: "prophet-arena-market-anchor-v1",
    asOfUtc,
    web: "allow",
    predictionMarket: "observe",
    suppliedMarketStats: "anchor",
    financialMarketData: "allow",
    postCutoffEvidence: "reject"
  };
}

export function strictMarketBlindPolicy(asOfUtc: string): InformationPolicy {
  return {
    id: "strict-market-blind-v1",
    asOfUtc,
    web: "allow",
    predictionMarket: "resolution_metadata_only",
    suppliedMarketStats: "deny",
    financialMarketData: "allow",
    postCutoffEvidence: "reject"
  };
}

