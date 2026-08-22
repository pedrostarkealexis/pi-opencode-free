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
  assert.ok(!ids.includes("opencode/muse-spark-1.2-contributor-free"), "muse-spark upstream is broken");
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

test("discoverModels falls back to offline catalog when fetch times out or aborts", async () => {
  const hangingFetch = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Timeout", "AbortError")));
    });

  const models = await discoverModels({ fetchFn: hangingFetch as unknown as typeof fetch, timeoutMs: 10 });
  assert.deepEqual(models, FALLBACK_MODELS);
});
