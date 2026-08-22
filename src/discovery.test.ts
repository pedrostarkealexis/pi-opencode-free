import assert from "node:assert/strict";
import test from "node:test";
import { discoverModels, filterFreeModels, FALLBACK_MODELS } from "./discovery.js";

test("filterFreeModels filters free models and applies fallback metadata", () => {
  const input = [
    { id: "hy3-free", name: "Hy3" },
    { id: "gpt-5.6-sol", name: "Paid Model" },
    { id: "big-pickle", name: "Big Pickle" },
  ];
  const result = filterFreeModels(input);
  assert.deepEqual(result.map(m => m.id), [
    "opencode/hy3-free",
    "opencode/big-pickle",
  ]);
  assert.equal(result[0].reasoning, true);
  assert.equal(result[0].contextWindow, 256_000);
  assert.equal(result[1].reasoning, false);
});

test("fallback catalog excludes models whose free promotion ended", () => {
  const ids = FALLBACK_MODELS.map(m => m.id);
  assert.ok(!ids.includes("opencode/deepseek-v4-flash-free"), "deepseek free promotion ended");
  assert.ok(ids.includes("opencode/muse-spark-1.2-contributor-free"));
  assert.ok(ids.includes("opencode/hy3-free"));
  assert.ok(ids.length > 0);
});

test("discoverModels returns fallback models when zen fetch fails", async () => {
  const failingFetch = async () => { throw new Error("Offline"); };
  const models = await discoverModels({ fetchFn: failingFetch as typeof fetch });
  assert.deepEqual(models, FALLBACK_MODELS);
});

test("discoverModels serves every free model listed by the endpoint", async () => {
  const zenResponse = {
    ok: true,
    json: async () => ({ data: [{ id: "hy3-free" }, { id: "deepseek-v4-flash-free" }, { id: "gpt-5.6-sol" }] }),
  };
  const fetchFn = (async () => zenResponse) as unknown as typeof fetch;

  const models = await discoverModels({ fetchFn });
  // The catalog mirrors the endpoint's free list — no health filtering.
  assert.deepEqual(models.map(m => m.id), [
    "opencode/hy3-free",
    "opencode/deepseek-v4-flash-free",
  ]);
});

test("discoverModels enriches metadata from models.dev before the offline table", async () => {
  const routes = (url: string | URL | Request) => {
    if (String(url).includes("models.dev")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ opencode: { models: {
          "x-preview-f-free": {
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
            limit: { context: 1_000_000, output: 131_072 },
            modalities: { input: ["text", "image"] },
          },
        } } }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({ data: [{ id: "x-preview-f-free" }] }) });
  };

  const models = await discoverModels({ fetchFn: routes as unknown as typeof fetch });
  const x = models.find(m => m.id === "opencode/x-preview-f-free");
  assert.ok(x, "free model from endpoint must be served");
  assert.equal(x.contextWindow, 1_000_000); // models.dev truth, not the 128K default
  assert.equal(x.maxTokens, 131_072);
  assert.equal(x.reasoning, true);
  assert.equal(x.thinkingLevelMap?.high, "high"); // explicit effort levels survive
  assert.equal(x.thinkingLevelMap?.off, null); // no toggle -> off stays hidden
  assert.deepEqual(x.input, ["text", "image"]); // modality passthrough
});

test("discoverModels falls back to offline metadata when models.dev is unreachable", async () => {
  const routes = (url: string | URL | Request) => {
    if (String(url).includes("models.dev")) return Promise.reject(new Error("Offline"));
    return Promise.resolve({ ok: true, json: async () => ({ data: [{ id: "hy3-free" }] }) });
  };

  const models = await discoverModels({ fetchFn: routes as unknown as typeof fetch });
  const hy3 = models.find(m => m.id === "opencode/hy3-free");
  assert.ok(hy3);
  assert.equal(hy3.contextWindow, 256_000); // from FALLBACK_META
});

test("discoverModels falls back to offline catalog when fetch times out or aborts", async () => {
  const hangingFetch = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Timeout", "AbortError")));
    });

  const models = await discoverModels({ fetchFn: hangingFetch as unknown as typeof fetch, timeoutMs: 10 });
  assert.deepEqual(models, FALLBACK_MODELS);
});
