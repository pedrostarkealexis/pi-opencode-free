export interface OpenCodeModelInfo {
  id: string;
  name: string;
  reasoning?: boolean;
}

export const FALLBACK_MODELS: OpenCodeModelInfo[] = [
  { id: "opencode/deepseek-v4-flash-free", name: "DeepSeek v4 Flash (Free)", reasoning: true },
  { id: "opencode/muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor (Free)", reasoning: false },
  { id: "opencode/mimo-v2.5-free", name: "MiMo v2.5 (Free)", reasoning: false },
  { id: "opencode/hy3-free", name: "Hy3 (Free)", reasoning: false },
  { id: "opencode/nemotron-3-ultra-free", name: "Nemotron 3 Ultra (Free)", reasoning: true },
  { id: "opencode/nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning (Free)", reasoning: true },
  { id: "opencode/laguna-s-2.1-free", name: "Laguna S 2.1 (Free)", reasoning: false },
];

const freeRegex = /(^(opencode\/)?.*-free$)|(^(opencode\/)?big-pickle$)/i;

export function filterFreeModels(models: Array<{ id: string; name?: string }>): OpenCodeModelInfo[] {
  return models
    .filter(m => freeRegex.test(m.id))
    .map(m => {
      const bareId = m.id.replace(/^opencode\//, "");
      return {
        id: `opencode/${bareId}`,
        name: m.name ?? humanizeName(bareId),
        reasoning: /(deepseek|nemotron|hy3)/i.test(bareId),
      };
    });
}

function humanizeName(id: string): string {
  const base = id.replace(/-free$/, "").replace(/[_-]+/g, " ");
  return base
    .split(" ")
    .map(word => (word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ") + " (Free)";
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
