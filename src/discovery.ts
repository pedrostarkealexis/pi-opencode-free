export interface OpenCodeModelInfo {
  id: string;
  name: string;
  reasoning?: boolean;
}

export const FALLBACK_MODELS: OpenCodeModelInfo[] = [
  { id: "opencode/deepseek-v4-flash-free", name: "DeepSeek v4 Flash (Free)", reasoning: true },
  { id: "opencode/mimo-v2.5-free", name: "MiMo v2.5 (Free)", reasoning: false },
  { id: "opencode/nemotron-3-super-free", name: "Nemotron 3 Super (Free)", reasoning: true },
  { id: "opencode/big-pickle", name: "Big Pickle (Free)", reasoning: false },
];

export function filterFreeModels(models: Array<{ id: string; name?: string }>): OpenCodeModelInfo[] {
  return models
    .filter(m => /(^opencode\/.*-free$)|(^opencode\/big-pickle$)/.test(m.id))
    .map(m => ({
      id: m.id,
      name: m.name ?? m.id,
      reasoning: m.id.includes("deepseek") || m.id.includes("nemotron"),
    }));
}

export async function discoverModels(opts?: { fetchFn?: typeof fetch }): Promise<OpenCodeModelInfo[]> {
  const fetcher = opts?.fetchFn ?? fetch;
  try {
    const res = await fetcher("https://opencode.ai/zen/v1/models", {
      headers: { "x-opencode-client": "cli", "User-Agent": "opencode/0.0.0-dev" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { data?: Array<{ id: string; name?: string }> };
    const filtered = filterFreeModels(data?.data ?? []);
    return filtered.length > 0 ? filtered : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}
