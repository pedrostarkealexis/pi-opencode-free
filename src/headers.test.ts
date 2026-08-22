import assert from "node:assert/strict";
import test from "node:test";
import { createSessionHeaders } from "./headers.js";

test("createSessionHeaders keeps session hash stable as conversation grows", () => {
  const turn1 = [{ role: "system", content: "You are Pi" }, { role: "user", content: "Hello" }];
  const turn2 = [...turn1, { role: "assistant", content: "Hi" }, { role: "user", content: "Next" }];

  const headers1 = createSessionHeaders(turn1);
  const headers2 = createSessionHeaders(turn2);

  assert.equal(headers1["x-opencode-session"], headers2["x-opencode-session"]);
  assert.notEqual(headers1["x-opencode-request"], headers2["x-opencode-request"]);
  assert.equal(headers1["x-opencode-client"], "cli");
});

test("createSessionHeaders changes session hash for a distinct conversation anchor", () => {
  const convA = [{ role: "system", content: "System A" }, { role: "user", content: "Topic A" }];
  const convB = [{ role: "system", content: "System B" }, { role: "user", content: "Topic B" }];

  assert.notEqual(
    createSessionHeaders(convA)["x-opencode-session"],
    createSessionHeaders(convB)["x-opencode-session"]
  );
});
