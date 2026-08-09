import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createProphetServer, listen, loadProphetServerConfig, type ProphetServerConfig } from "./server.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const request = JSON.parse(readFileSync(`${root}fixtures/prophet-arena/current-request.json`, "utf8")) as unknown;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function config(): ProphetServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    bearerToken: "test-token",
    maxConcurrent: 2,
    requestTimeoutMs: 1000,
    residualCap: 0.05,
    bodyLimitBytes: 64 * 1024,
    maxOutcomes: 100,
    maxTotalPromptBytes: 1_000_000,
    providerConcurrency: 2,
    allowBaselineOnly: true,
    wireMode: "auto",
    artifactRoot: "/tmp/raven-gonna-test-prophet-tests",
    pipelineVersion: "test-v1"
  };
}

describe("Prophet Arena HTTP contract", () => {
  it("serves health and a strict current response with market-prior fallback", async () => {
    const server = createProphetServer(config(), {
      forecast: async () => [],
      now: () => new Date("2026-08-09T00:00:00Z")
    });
    servers.push(server);
    const address = await listen(server, config());
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const response = await fetch(`${base}/forecast`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["probabilities"]);
    expect(body.probabilities).toEqual([
      { market: "Outcome A", probability: 0.6 },
      { market: "Outcome B", probability: 0.3 }
    ]);
  });

  it("enforces bearer auth and content type", async () => {
    const server = createProphetServer(config(), { forecast: async () => [] });
    servers.push(server);
    const address = await listen(server, config());
    const base = `http://127.0.0.1:${address.port}`;
    const unauthorized = await fetch(`${base}/forecast`, { method: "POST" });
    expect(unauthorized.status).toBe(401);
    const wrongType = await fetch(`${base}/forecast`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "text/plain" },
      body: "{}"
    });
    expect(wrongType.status).toBe(415);
  });

  it("survives malformed/schema-invalid requests without an unhandled rejection", async () => {
    const server = createProphetServer(config(), { forecast: async () => [] });
    servers.push(server);
    const address = await listen(server, config());
    const base = `http://127.0.0.1:${address.port}`;
    const invalid = await fetch(`${base}/forecast`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: "{}"
    });
    expect(invalid.status).toBe(422);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("single-flights identical payloads while keeping both waiters independent", async () => {
    let calls = 0;
    const server = createProphetServer(config(), {
      now: () => new Date("2026-08-09T00:00:00Z"),
      forecast: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return [];
      }
    });
    servers.push(server);
    const address = await listen(server, config());
    const url = `http://127.0.0.1:${address.port}/forecast`;
    const init = {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify(request)
    };
    const [left, right] = await Promise.all([fetch(url, init), fetch(url, init)]);
    expect([left.status, right.status]).toEqual([200, 200]);
    expect(calls).toBe(1);
  });

  it("returns 504 when an injected provider ignores cancellation", async () => {
    const timeoutConfig = { ...config(), requestTimeoutMs: 25 };
    const server = createProphetServer(timeoutConfig, {
      forecast: async () => new Promise(() => undefined)
    });
    servers.push(server);
    const address = await listen(server, timeoutConfig);
    const response = await fetch(`http://127.0.0.1:${address.port}/forecast`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    expect(response.status).toBe(504);
  });

  it("supports the legacy wire response and enforces safe public config", async () => {
    expect(() => loadProphetServerConfig({ PROPHET_HOST: "0.0.0.0" })).toThrow(/BEARER_TOKEN/);
    expect(() => loadProphetServerConfig({ PROPHET_HOST: "0.0.0.0", PROPHET_BEARER_TOKEN: "short" })).toThrow(/32 bytes/);
    const server = createProphetServer(config(), { forecast: async () => [] });
    servers.push(server);
    const address = await listen(server, config());
    const response = await fetch(`http://127.0.0.1:${address.port}/forecast`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({
        event_id: "legacy-event",
        title: "Legacy event",
        markets: ["YES", "NO"],
        rules: "Exactly one outcome.",
        market_stats: { YES: { last_price: 0.7 }, NO: { last_price: 0.2 } }
      })
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { prediction: Record<string, number>; rationale: string };
    expect(Object.keys(body.prediction)).toEqual(["YES", "NO"]);
    expect(Object.values(body.prediction).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
    expect(body.rationale).toBeTruthy();
  });
});
