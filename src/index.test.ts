import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import opencodeDirectExtension from "./index.js";

test("opencodeDirectExtension registers opencode-direct provider", async () => {
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
  assert.ok(registeredConfig.models.length > 0);
  assert.equal(typeof registeredConfig.streamSimple, "function");
});
