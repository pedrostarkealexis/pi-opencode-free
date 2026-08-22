import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import opencodeDirectExtension from "./index.js";

test("opencodeDirectExtension registers native openai-completions provider with opencode headers", async () => {
  let registeredId = "";
  let registeredConfig: any = null;

  const fakePi = {
    registerProvider(id: string, config: any) {
      registeredId = id;
      registeredConfig = config;
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;

  await opencodeDirectExtension(fakePi);

  assert.equal(registeredId, "opencode-direct");
  assert.equal(registeredConfig.name, "OpenCode Direct (Free)");
  assert.equal(registeredConfig.api, "openai-completions");
  assert.equal(registeredConfig.baseUrl, "https://opencode.ai/zen/v1");
  assert.equal(registeredConfig.apiKey, "none");
  assert.equal(registeredConfig.headers["x-opencode-client"], "cli");
  assert.equal(registeredConfig.headers["x-opencode-project"], "global");
  assert.ok(registeredConfig.models.length > 0);
  assert.equal(registeredConfig.models[0].compat.supportsStore, false);
  // Thin keyless shim over the native engine (delegation itself is verified
  // end-to-end against the live API by scripts/smoke-real.ts).
  assert.equal(typeof registeredConfig.streamSimple, "function");
});
