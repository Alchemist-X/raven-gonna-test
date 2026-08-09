import { describe, expect, it } from "vitest";
import { loadPredictorConfig } from "./config.js";
import { OpenAICompatiblePredictor } from "./openai-compatible.js";

describe("runtime configuration", () => {
  it("loads Foresight-compatible defaults without leaking secrets", () => {
    const config = loadPredictorConfig({ PREDICTOR_API_KEY: "secret" });
    expect(config.baseUrl).toBe("https://api.lightningrod.ai/v1/openai");
    expect(config.model).toBe("foresight-v4");
  });

  it("rejects plain HTTP for non-local providers", () => {
    expect(() => loadPredictorConfig({
      PREDICTOR_API_KEY: "secret",
      PREDICTOR_BASE_URL: "http://provider.example/v1"
    })).toThrow(/HTTPS/);
  });
});

describe("OpenAICompatiblePredictor", () => {
  it("sends Foresight extensions and extracts citations", async () => {
    let body: Record<string, unknown> | undefined;
    const fetchFn: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        model: "foresight-v4",
        choices: [{
          message: {
            content: "<answer>0.62</answer>",
            annotations: [{ url: "https://example.com/source" }]
          }
        }],
        usage: { total_tokens: 100 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new OpenAICompatiblePredictor({
      baseUrl: "https://example.com/v1/openai",
      apiKey: "secret",
      model: "foresight-v4",
      timeoutMs: 1000,
      trials: 1,
      concurrency: 1,
      reasoningEffort: "medium",
      researchSources: ["perplexity"]
    }, fetchFn);
    const result = await client.generate({
      task: {
        taskId: "q",
        origin: { benchmark: "forecastbench", roundId: "r", externalId: "q", source: "manifold" },
        kind: "binary_probability",
        prompt: "Will it happen?",
        asOfUtc: "2026-08-16T00:00:00.000Z",
        resolution: { criteria: "YES if it happens" },
        metadata: {}
      },
      policy: {
        id: "test",
        asOfUtc: "2026-08-16T00:00:00.000Z",
        web: "allow",
        predictionMarket: "anchor",
        suppliedMarketStats: "deny",
        financialMarketData: "allow",
        postCutoffEvidence: "reject"
      },
      systemPrompt: "system",
      userPrompt: "question",
      answerType: "binary",
      research: { sources: ["perplexity"] },
      reasoningEffort: "medium"
    }, new AbortController().signal);
    expect(body).toMatchObject({ answer_type: "binary", reasoning_effort: "medium" });
    expect(result.citations).toEqual(["https://example.com/source"]);
  });

  it("accepts nullable official fields and retries a bounded 429", async () => {
    let calls = 0;
    const fetchFn: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({
        choices: [{ message: { content: "<answer>0.61</answer>", thinking: null, annotations: null } }],
        usage: null
      }), { status: 200 });
    };
    const client = new OpenAICompatiblePredictor({
      baseUrl: "https://example.com/v1",
      apiKey: "secret",
      model: "foresight-v4",
      timeoutMs: 1000,
      trials: 1,
      concurrency: 1,
      reasoningEffort: "low",
      researchSources: [],
      maxRetries: 1,
      retryBaseMs: 1
    }, fetchFn);
    const result = await client.generate({
      task: {
        taskId: "retry",
        origin: { benchmark: "forecastbench", roundId: "r", externalId: "q", source: "manifold" },
        kind: "binary_probability",
        prompt: "Will it happen?",
        asOfUtc: "2026-08-16T00:00:00.000Z",
        resolution: { criteria: "YES" },
        metadata: {}
      },
      policy: {
        id: "test",
        asOfUtc: "2026-08-16T00:00:00.000Z",
        web: "deny",
        predictionMarket: "anchor",
        suppliedMarketStats: "deny",
        financialMarketData: "allow",
        postCutoffEvidence: "reject"
      },
      systemPrompt: "system",
      userPrompt: "question",
      answerType: "binary",
      research: false,
      reasoningEffort: "low"
    }, new AbortController().signal);
    expect(calls).toBe(2);
    expect(result.content).toBe("<answer>0.61</answer>");
  });
});
