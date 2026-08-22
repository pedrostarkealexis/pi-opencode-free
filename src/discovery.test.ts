import assert from "node:assert/strict";
import test from "node:test";
import { discoverModels, filterFreeModels, FALLBACK_MODELS } from "./discovery.js";

test("filterFreeModels filters free models from API list", () => {
  const input = [
    { id: "deepseek-v4-flash-free", name: "DeepSeek v4 Flash" },
    { id: "gpt-5.6-sol", name: "Paid Model" },
    { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra" },
  ];
  const result = filterFreeModels(input);
  assert.deepEqual(result.map(m => m.id), [
    "deepseek-v4-flash-free",
    "nemotron-3-ultra-free",
  ]);
  assert.equal(result[0].reasoning, true);
});

test("discoverModels returns fallback models when fetch fails", async () => {
  const failingFetch = async () => { throw new Error("Offline"); };
  const models = await discoverModels({ fetchFn: failingFetch as typeof fetch });
  assert.deepEqual(models, FALLBACK_MODELS);
});
