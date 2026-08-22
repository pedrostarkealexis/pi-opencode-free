import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverModels } from "./discovery.js";
import { streamOpenCodeDirect } from "./stream.js";

const PROVIDER_ID = "opencode-direct";

export default async function opencodeDirectExtension(pi: ExtensionAPI): Promise<void> {
  const models = await discoverModels();

  pi.registerProvider(PROVIDER_ID, {
    name: "OpenCode Direct (Free)",
    baseUrl: "https://opencode.ai/zen/v1",
    apiKey: "none",
    api: "openai-completions",
    models: models.map(m => ({
      id: m.id,
      name: `${m.name} (Direct)`,
      reasoning: m.reasoning ?? false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: 128_000,
      maxTokens: 16_384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple: streamOpenCodeDirect,
  });

  pi.registerCommand("opencode-sync", {
    description: "Sync latest free models list from OpenCode Zen",
    handler: async (_args: string, ctx: any) => {
      const refreshed = await discoverModels();
      ctx.ui.notify(`opencode-direct: synchronized ${refreshed.length} models.`, "info");
    },
  });
}
