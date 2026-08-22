import assert from "node:assert/strict";
import test from "node:test";
import { discoverModels, filterFreeModels, FALLBACK_MODELS } from "./discovery.js";

test("filterFreeModels filters free models from API list", () => {
  const input = [
    { id: "opencode/deepseek-v4-flash-free", name: "DeepSeek v4 Flash" },
    { id: "opencode/gpt-4o-paid", name: "Paid Model" },
    { id: "opencode/big-pickle", name: "Big Pickle" },
  ];
  const result = filterFreeModels(input);
  assert.deepEqual(result.map(m => m.id), [
    "opencode/deepseek-v4-flash-free",
    "opencode/big-pickle",
  ]);
});

test("discoverModels returns fallback models when fetch fails", async () => {
  const failingFetch = async () => { throw new Error("Offline"); };
  const models = await discoverModels({ fetchFn: failingFetch as typeof fetch });
  assert.deepEqual(models, FALLBACK_MODELS);
});
