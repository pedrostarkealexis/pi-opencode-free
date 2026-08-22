import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverModels } from "./discovery.js";

const PROVIDER_ID = "opencode-direct";

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
  const models = await discoverModels();

  pi.registerProvider(PROVIDER_ID, {
    name: "OpenCode Direct (Free)",
    baseUrl: "https://opencode.ai/zen/v1",
    apiKey: "none",
    api: "openai-completions",
    headers: {
      "x-opencode-client": "cli",
      "x-opencode-project": "global",
      "User-Agent": "opencode/0.0.0-dev",
    },
    models: models.map(m => ({
      id: m.id.replace(/^opencode\//, ""),
      name: `${m.name} (Direct)`,
      reasoning: m.reasoning ?? false,
      thinkingLevelMap: m.thinkingLevelMap,
      input: ["text"] as ("text" | "image")[],
      contextWindow: m.contextWindow ?? 128_000,
      maxTokens: m.maxTokens ?? 16_384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: OPENCODE_COMPAT,
    })),
  });

  pi.registerCommand("opencode-sync", {
    description: "Sync latest free models list from OpenCode Zen",
    handler: async (_args: string, ctx: any) => {
      const refreshed = await discoverModels();
      ctx.ui.notify(`opencode-direct: synchronized ${refreshed.length} models.`, "info");
    },
  });
}
