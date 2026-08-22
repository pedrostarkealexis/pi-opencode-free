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
    "opencode/deepseek-v4-flash-free",
    "opencode/nemotron-3-ultra-free",
  ]);
  assert.equal(result[0].reasoning, true);
});

test("filterFreeModels keeps IDs without opencode/ prefix and normalizes them", () => {
  const input = [
    { id: "big-pickle", name: "Big Pickle" },
    { id: "nemotron-3-super-free", name: "Nemotron 3 Super" },
    { id: "opencode/hy3-free", name: "Hy3" },
    { id: "gpt-5.6-sol", name: "Paid Model" },
  ];
  const result = filterFreeModels(input);
  assert.deepEqual(result.map(m => m.id), [
    "opencode/big-pickle",
    "opencode/nemotron-3-super-free",
    "opencode/hy3-free",
  ]);
  assert.equal(result[1].reasoning, true);
  assert.equal(result[0].reasoning, false);
});

test("discoverModels returns fallback models when fetch fails", async () => {
  const failingFetch = async () => { throw new Error("Offline"); };
  const models = await discoverModels({ fetchFn: failingFetch as typeof fetch });
  assert.deepEqual(models, FALLBACK_MODELS);
});
