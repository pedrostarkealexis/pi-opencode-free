import assert from "node:assert/strict";
import test from "node:test";
import { parseSseLine } from "./stream.js";

test("parseSseLine extracts delta text and reasoning content", () => {
  const textChunk = 'data: {"choices":[{"delta":{"content":"Hello"}}]}';
  const thoughtChunk = 'data: {"choices":[{"delta":{"reasoning_content":"Thinking..."}}]}';
  const toolChunk = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{}"}}]}}]}';

  assert.deepEqual(parseSseLine(textChunk), { type: "text", text: "Hello" });
  assert.deepEqual(parseSseLine(thoughtChunk), { type: "thinking", text: "Thinking..." });
  assert.equal(parseSseLine(toolChunk)?.type, "tool_calls");
});
