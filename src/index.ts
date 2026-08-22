import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
// First-class pi-ai subpath export (stable); unlike /compat, this is not a
// temporary shim scheduled for deletion.
import { streamSimple as nativeOpenAICompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { discoverModels, type OpenCodeModelInfo } from "./discovery.js";

const PROVIDER_ID = "opencode-free";

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

export default async function opencodeDirectExtension(pi: ExtensionAPI): Promise<void> {
  // Re-registering with `models` replaces the live list in place, so
  // /opencode-sync can refresh models without a /reload.
  const registerProvider = async (): Promise<number> => {
    const models = await discoverModels();

    pi.registerProvider(PROVIDER_ID, {
      name: "OpenCode Direct (Free)",
      baseUrl: "https://opencode.ai/zen/v1",
      // Placeholder: Pi's auth composition requires a key; real requests go
      // keyless via the streamSimple shim below.
      apiKey: "none",
      api: "openai-completions",
      headers: {
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "User-Agent": "opencode/0.0.0-dev",
      },
      models: models.map(toProviderModel),
      // Native refresh hook: lets `pi update --models` re-discover the free
      // list without persisting it (live catalog, like the llama.cpp pattern).
      async refreshModels({ signal }: { signal: AbortSignal }) {
        return (await discoverModels({ signal })).map(toProviderModel);
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

    return models.length;
  };

  await registerProvider();

  pi.registerCommand("opencode-sync", {
    description: "Sync latest free models list from OpenCode Zen",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const count = await registerProvider();
      ctx.ui.notify(`opencode-free: synchronized ${count} free models.`, "info");
    },
  });
}
