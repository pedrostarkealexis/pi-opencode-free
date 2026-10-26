// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import opencodeDirectExtension, {
  getCurrentTools,
  newZenSessionId,
  shapeZenPayload,
  ZEN_DISREGARD_PREAMBLE,
  ZEN_MARKER_PROMPT,
  ZEN_TRAILING_REMINDER,
} from "./index.js";
import { discoverModels } from "./discovery.js";

test("registers provider once with empty initial models and no boot fetch", async () => {
  let registered = 0;
  let providerConfig: any = null;
  const fakePi: ExtensionAPI = {
    registerProvider(_id: string, config: any) {
      registered++;
      providerConfig = config;
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;

  opencodeDirectExtension(fakePi);

  assert.equal(registered, 1);
  assert.equal(providerConfig?.models?.length, 0);
});

test("module exports are defined and functions", () => {
  assert.equal(typeof opencodeDirectExtension, "function");
  assert.equal(typeof discoverModels, "function");
});

test("package.json is configured for public release and distribution", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
  assert.equal(pkg.version, "0.2.0");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "GPL-3.0-or-later");
  assert.ok(pkg.author);
  assert.ok(pkg.repository);
  assert.ok(pkg.keywords?.includes("pi-package"));
  assert.ok(pkg.files?.includes("dist"));
  assert.ok(pkg.pi?.extensions?.includes("./dist/index.js"));
  assert.ok(!pkg.devDependencies?.["@earendil-works/pi-ai"]);
  assert.ok(!pkg.devDependencies?.["@earendil-works/pi-coding-agent"]);
});

test("cache-only refresh restores persisted snapshot without network", async () => {
  let registeredConfig: any = null;
  const fakePi: ExtensionAPI = {
    registerProvider(_id: string, config: any) {
      registeredConfig = config;
    },
  } as unknown as ExtensionAPI;

  opencodeDirectExtension(fakePi);

  const stored = {
    checkedAt: Date.now(),
    models: [
      {
        provider: "opencode-free",
        baseUrl: "https://opencode.ai/zen/v1",
        id: "cached-model",
        name: "Cached Model",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };

  const restored = await registeredConfig.refreshModels({
    allowNetwork: false,
    signal: new AbortController().signal,
    stored,
  });

  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, "cached-model");
  assert.equal(restored[0].provider, undefined);
  assert.equal(restored[0].baseUrl, undefined);
});

test("cache-only refresh with no stored snapshot yields empty list", async () => {
  let registeredConfig: any = null;
  const fakePi: ExtensionAPI = {
    registerProvider(_id: string, config: any) {
      registeredConfig = config;
    },
  } as unknown as ExtensionAPI;

  opencodeDirectExtension(fakePi);

  const restored = await registeredConfig.refreshModels({
    allowNetwork: false,
    signal: new AbortController().signal,
    stored: undefined,
  });

  assert.deepEqual(restored, []);
});

test("network refresh discovers models and persists a stamped snapshot", async () => {
  let registeredConfig: any = null;
  const fakePi: ExtensionAPI = {
    registerProvider(_id: string, config: any) {
      registeredConfig = config;
    },
  } as unknown as ExtensionAPI;

  opencodeDirectExtension(fakePi);

  let published: any = null;
  const ctx = {
    allowNetwork: true,
    signal: new AbortController().signal,
    stored: undefined,
    async publish(data: any) {
      published = data;
    },
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "test-free", name: "Test Free" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return origFetch(url);
  }) as any;

  try {
    const models = await registeredConfig.refreshModels(ctx);
    assert.ok(models.length > 0);
    assert.equal(models[0].id, "test-free");
    assert.ok(published?.persist?.models?.length > 0);
    assert.equal(published.persist.models[0].provider, "opencode-free");
    assert.equal(published.persist.models[0].baseUrl, "https://opencode.ai/zen/v1");
    assert.ok(published.persist.checkedAt > 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("network refresh never wipes a good snapshot when discovery comes back empty", async () => {
  let registeredConfig: any = null;
  const fakePi: ExtensionAPI = {
    registerProvider(_id: string, config: any) {
      registeredConfig = config;
    },
  } as unknown as ExtensionAPI;

  opencodeDirectExtension(fakePi);

  let publishCalled = false;
  const ctx = {
    allowNetwork: true,
    signal: new AbortController().signal,
    stored: {
      checkedAt: 1234,
      models: [{ provider: "opencode-free", id: "old-model" }],
    },
    async publish() {
      publishCalled = true;
    },
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as any;

  try {
    const models = await registeredConfig.refreshModels(ctx);
    assert.deepEqual(models, []);
    assert.equal(publishCalled, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("network refresh respects abort signal before fetching", async () => {
  let registeredConfig: any = null;
  const fakePi: ExtensionAPI = {
    registerProvider(_id: string, config: any) {
      registeredConfig = config;
    },
  } as unknown as ExtensionAPI;

  opencodeDirectExtension(fakePi);

  const controller = new AbortController();
  controller.abort();

  const ctx = {
    allowNetwork: true,
    signal: controller.signal,
    stored: undefined,
    async publish() {},
  };

  const models = await registeredConfig.refreshModels(ctx);
  assert.deepEqual(models, []);
});

test("registers no slash commands", () => {
  const commands: string[] = [];
  const fakePi: ExtensionAPI = {
    registerProvider() {},
    registerCommand(name: string) {
      commands.push(name);
    },
  } as unknown as ExtensionAPI;

  opencodeDirectExtension(fakePi);
  assert.equal(commands.length, 0);
});

test("newZenSessionId generates valid session format", () => {
  const id = newZenSessionId();
  assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
});

test("shapeZenPayload sets stream: true and strips wire tools to satisfy Zen gate", () => {
  const payloadWithTools = {
    model: "test",
    messages: [
      { role: "user", content: "Do something" },
    ],
    tools: [
      { type: "function", function: { name: "subagent_run", description: "Run subagent", parameters: {} } },
      { type: "function", function: { name: "read", description: "Read file", parameters: {} } },
    ],
    tool_choice: "auto",
  };
  const shaped = shapeZenPayload(payloadWithTools) as any;
  assert.equal(shaped.stream, true);
  assert.equal(shaped.tools, undefined);
  assert.equal(shaped.tool_choice, undefined);
  assert.ok(shaped.messages[1].content.includes("<tools>"));
  assert.ok(shaped.messages[1].content.includes("subagent_run"));
  assert.ok(shaped.messages[1].content.includes("<tool-protocol>"));
});

test("shapeZenPayload injects developer marker prompt and disregard preamble", () => {
  const payload = {
    model: "test",
    messages: [
      { role: "system", content: "You are a code reviewer." },
      { role: "user", content: "Check this function" },
    ],
  };
  const shaped = shapeZenPayload(payload) as any;
  assert.equal(shaped.messages.length, 4);
  assert.equal(shaped.messages[0].role, "developer");
  assert.equal(shaped.messages[0].content, ZEN_MARKER_PROMPT);
  assert.equal(shaped.messages[1].role, "developer");
  assert.ok(shaped.messages[1].content.startsWith(ZEN_DISREGARD_PREAMBLE));
  assert.ok(shaped.messages[1].content.includes("You are a code reviewer."));
  assert.equal(shaped.messages[2].role, "user");
  assert.ok(shaped.messages[2].content.includes("Check this function"));
  assert.equal(shaped.messages[3].role, "developer");
  assert.equal(shaped.messages[3].content, ZEN_TRAILING_REMINDER);
});

test("shapeZenPayload collapses multi-turn messages so total items <= 4", () => {
  const payload = {
    model: "test",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Turn 1" },
      { role: "assistant", content: "Reply 1" },
      { role: "user", content: "Turn 2" },
      { role: "assistant", content: "Reply 2" },
      { role: "user", content: "Turn 3" },
    ],
  };
  const shaped = shapeZenPayload(payload) as any;
  assert.ok(shaped.messages.length <= 4);
  assert.equal(shaped.messages[0].role, "developer");
  assert.equal(shaped.messages[1].role, "developer");
  assert.equal(shaped.messages[2].role, "user");
  assert.ok(shaped.messages[2].content.includes("[user]: Turn 1"));
  assert.ok(shaped.messages[2].content.includes("[assistant]: Reply 1"));
  assert.ok(shaped.messages[2].content.includes("[user]: Turn 3"));
});

test("getCurrentTools extracts tools added in system messages and honors removals", () => {
  const messages = [
    {
      role: "system",
      content: "prompt",
      toolsAdded: [
        { name: "read", description: "Read file", parameters: {} },
        { name: "subagent_run", description: "Run subagent", parameters: {} },
      ],
    },
    {
      role: "user",
      content: "hello",
    },
    {
      role: "system",
      toolsRemoved: [{ name: "read" }],
      toolsAdded: [{ name: "read_v2", description: "Read file v2", parameters: {} }],
    },
  ];
  const tools = getCurrentTools(messages);
  assert.equal(tools.length, 2);
  const names = (tools as any[]).map((t: any) => t.name);
  assert.deepEqual(names, ["subagent_run", "read_v2"]);
});
