import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
// First-class pi-ai subpath export (stable); unlike /compat, this is not a
// temporary shim scheduled for deletion.
import { streamSimple as nativeOpenAICompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { discoverModels, type OpenCodeModelInfo } from "./discovery.js";

const PROVIDER_ID = "opencode-free";
const BASE_URL = "https://opencode.ai/zen/v1";

// Describes Zen's upstream quirks to Pi's native openai-completions engine
// (max_tokens field name, reasoning_content replay) — no custom streaming code.
const OPENCODE_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens" as const,
  requiresReasoningContentOnAssistantMessages: true,
};

/** Maps a discovered model to the provider config shape. */
function toProviderModel(m: OpenCodeModelInfo) {
  return {
    id: m.id.replace(/^opencode\//, ""),
    name: m.name,
    reasoning: m.reasoning ?? false,
    thinkingLevelMap: m.thinkingLevelMap,
    input: (m.input?.includes("image") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    contextWindow: m.contextWindow ?? 128_000,
    maxTokens: m.maxTokens ?? 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: OPENCODE_COMPAT,
  };
}

function toStoredModel(config: ReturnType<typeof toProviderModel>) {
  return { ...config, api: "openai-completions" as const, provider: PROVIDER_ID, baseUrl: BASE_URL };
}

function fromStoredModel<M extends { api?: unknown; provider?: unknown; baseUrl?: unknown }>(m: M) {
  const { api: _api, provider: _provider, baseUrl: _baseUrl, ...config } = m;
  return config as unknown as ReturnType<typeof toProviderModel>;
}

export default function opencodeDirectExtension(pi: ExtensionAPI): void {
  // Registered once with an empty list; models come exclusively through
  // refreshModels (snapshot restore on session init, live discovery on
  // explicit refresh) — pi's native model lifecycle.
  pi.registerProvider(PROVIDER_ID, {
    name: "OpenCode Direct (Free)",
    baseUrl: BASE_URL,
    // Placeholder: Pi's auth composition requires a key; real requests go
    // keyless via the streamSimple shim below.
    apiKey: "none",
    api: "openai-completions",
    headers: {
      "x-opencode-client": "cli",
      "x-opencode-project": "global",
      "User-Agent": "opencode/0.0.0-dev",
    },
    models: [],
    async refreshModels(ctx) {
      if (!ctx.allowNetwork) {
        return ctx.stored?.models
          .filter(m => m.provider === PROVIDER_ID && m.api === "openai-completions")
          .map(fromStoredModel) ?? [];
      }
      return [];
    },
    // Keyless shim: Zen's free tier rejects every Bearer token with 401,
    // and `Authorization: null` is the OpenAI SDK's supported omission.
    // Streaming, tools, reasoning, and cost handling stay fully native.
    streamSimple: (model, context, options) =>
      nativeOpenAICompletionsStream(model as Parameters<typeof nativeOpenAICompletionsStream>[0], context, {
        ...options,
        headers: { ...options?.headers, Authorization: null },
      }),
  });
}
