import assert from "node:assert/strict";
import test from "node:test";
import { adaptMessages, adaptTools, parseSseLine } from "./stream.js";

test("parseSseLine extracts delta text and reasoning content", () => {
  const textChunk = 'data: {"choices":[{"delta":{"content":"Hello"}}]}';
  const thoughtChunk = 'data: {"choices":[{"delta":{"reasoning_content":"Thinking..."}}]}';
  const toolChunk = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{}"}}]}}]}';

  assert.deepEqual(parseSseLine(textChunk), { type: "text", text: "Hello" });
  assert.deepEqual(parseSseLine(thoughtChunk), { type: "thinking", text: "Thinking..." });
  assert.equal(parseSseLine(toolChunk)?.type, "tool_calls");
});

test("adaptMessages injects system prompt as first message", () => {
  const result = adaptMessages({
    systemPrompt: "You are helpful",
    messages: [{ role: "user", content: "hi", timestamp: 0 }],
  });
  assert.deepEqual(result[0], { role: "system", content: "You are helpful" });
  assert.deepEqual(result[1], { role: "user", content: "hi" });
});

test("adaptMessages hoists assistant thinking to reasoning_content", () => {
  const result = adaptMessages({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "step one" },
          { type: "text", text: "answer" },
        ],
        api: "openai-completions",
        provider: "opencode-direct",
        model: "opencode/deepseek-v4-flash-free",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      },
    ],
  });
  assert.equal(result[0].role, "assistant");
  assert.equal(result[0].reasoning_content, "step one");
  assert.equal(result[0].content, "answer");
  assert.equal(result[0].tool_calls, undefined);
});

test("adaptMessages converts toolCall blocks to tool_calls and toolResult to tool role", () => {
  const result = adaptMessages({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "need data" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
        ],
        api: "openai-completions",
        provider: "opencode-direct",
        model: "opencode/deepseek-v4-flash-free",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: 0,
      },
    ],
  });
  const assistant = result[0];
  assert.equal(assistant.reasoning_content, "need data");
  assert.deepEqual(assistant.tool_calls, [
    { id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } },
  ]);
  assert.deepEqual(result[1], {
    role: "tool",
    tool_call_id: "call_1",
    content: "file contents",
  });
});

test("adaptTools wraps pi tools in OpenAI function schema", () => {
  const tools = adaptTools([
    {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  ]);
  assert.deepEqual(tools, [
    {
      type: "function",
      function: {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ]);
  assert.equal(adaptTools(undefined), undefined);
  assert.equal(adaptTools([]), undefined);
});

test("adaptMessages renders user image blocks as data-URL image_url parts", () => {
  const result = adaptMessages({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "see this" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
        timestamp: 0,
      },
    ],
  });
  assert.deepEqual(result[0].content, [
    { type: "text", text: "see this" },
    { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
  ]);
});
