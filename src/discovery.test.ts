import assert from "node:assert/strict";
import test from "node:test";
import { discoverModels, filterFreeModels, FALLBACK_MODELS } from "./discovery.js";

test("filterFreeModels filters free models and applies fallback metadata", () => {
  const input = [
    { id: "deepseek-v4-flash-free", name: "DeepSeek v4 Flash" },
    { id: "gpt-5.6-sol", name: "Paid Model" },
    { id: "big-pickle", name: "Big Pickle" },
  ];
  const result = filterFreeModels(input);
  assert.deepEqual(result.map(m => m.id), [
    "opencode/deepseek-v4-flash-free",
    "opencode/big-pickle",
  ]);
  assert.equal(result[0].reasoning, true);
  assert.equal(result[1].reasoning, false);
});

test("discoverModels returns fallback models when zen fetch fails", async () => {
  const failingFetch = async () => { throw new Error("Offline"); };
  const models = await discoverModels({ fetchFn: failingFetch as typeof fetch });
  assert.deepEqual(models, FALLBACK_MODELS);
});

test("discoverModels parses live zen models endpoint", async () => {
  const fakeZen = {
    ok: true,
    json: async () => ({ data: [{ id: "deepseek-v4-flash-free" }] }),
  };
  const fetchFn = (async () => fakeZen) as unknown as typeof fetch;
  const models = await discoverModels({ fetchFn });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "opencode/deepseek-v4-flash-free");
});
