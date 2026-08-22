import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Imported from the /compat entrypoint: it is the path pi's extension loader
// aliases for extensions and it re-exports the native openai-completions
// stream functions (the bare root export does not include them).
import { streamSimple as nativeOpenAICompletionsStream } from "@earendil-works/pi-ai/compat";
import { discoverModels } from "./discovery.js";

const PROVIDER_ID = "opencode-free";

// OpenCode Zen is an OpenAI-compatible completions endpoint. These compat
// flags describe the upstream so Pi's native openai-completions engine sends
// the right payload shape (max_tokens field, reasoning_content replay on
// assistant messages) without any custom streaming code.
const OPENCODE_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens" as const,
  requiresReasoningContentOnAssistantMessages: true,
};

export default async function opencodeDirectExtension(pi: ExtensionAPI): Promise<void> {
  // Discovers the free catalog and (re)registers the provider. Pi replaces a
  // provider's models when registerProvider supplies `models`, and applies
  // the change immediately outside initial load — so calling this again from
  // /opencode-sync refreshes the live list without a /reload.
  const registerProvider = async (): Promise<number> => {
    const models = await discoverModels();

    pi.registerProvider(PROVIDER_ID, {
      name: "OpenCode Direct (Free)",
      baseUrl: "https://opencode.ai/zen/v1",
      // Placeholder key so Pi's auth composition accepts the provider; real
      // requests go out keyless via the streamSimple shim below.
      apiKey: "none",
      api: "openai-completions",
      headers: {
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "User-Agent": "opencode/0.0.0-dev",
      },
      models: models.map(m => ({
        id: m.id.replace(/^opencode\//, ""),
        name: m.name,
        reasoning: m.reasoning ?? false,
        thinkingLevelMap: m.thinkingLevelMap,
        input: (m.input?.includes("image") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
        contextWindow: m.contextWindow ?? 128_000,
        maxTokens: m.maxTokens ?? 16_384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: OPENCODE_COMPAT,
      })),
      // Thin auth shim around Pi's NATIVE openai-completions engine (same
      // pattern as pi's gitlab-duo example). All SSE streaming, tool-call
      // accumulation, reasoning replay, and usage/cost handling stay native;
      // we only drop the Authorization header, because the Zen free tier is
      // anonymous and rejects every Bearer token with 401. `Authorization:
      // null` is the OpenAI SDK's supported way to omit the header entirely.
      streamSimple: (model, context, options) =>
        nativeOpenAICompletionsStream(model, context, {
          ...options,
          headers: { ...options?.headers, Authorization: null },
        }),
    });

    return models.length;
  };

  await registerProvider();

  pi.registerCommand("opencode-sync", {
    description: "Sync latest free models list from OpenCode Zen",
    handler: async (_args: string, ctx: any) => {
      const count = await registerProvider();
      ctx.ui.notify(`opencode-free: synchronized ${count} free models.`, "info");
    },
  });
}
