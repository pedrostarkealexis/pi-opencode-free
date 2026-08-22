/**
 * Discovery of free OpenCode Zen models.
 *
 * Free-tier models are discovered live from the OpenCode Zen REST API
 * (`/zen/v1/models`). Display names, reasoning support, thinking-effort
 * levels, and context/output limits come from a small offline fallback table
 * keyed by base model id; anything unknown defaults to non-reasoning with
 * conservative limits.
 */

export interface OpenCodeModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** pi thinking level → provider value. `null` marks the level unsupported. */
  thinkingLevelMap?: Record<string, string | null>;
}

interface ModelMeta {
  reasoning?: boolean;
  reasoning_options?: Array<{ type: string; values?: string[] }>;
  limit?: { context?: number; output?: number };
}

const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const FREE_REGEX = /(^(opencode\/)?.*-free$)|(^(opencode\/)?big-pickle$)/i;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Zen free id without the `opencode/` prefix and `-free` suffix (base model id). */
function baseModelId(id: string): string {
  return id.startsWith("opencode/") ? id.slice("opencode/".length).replace(/-free$/, "") : id.replace(/-free$/, "");
}

/** Human-readable display name derived from a Zen free id. */
function humanizeName(id: string): string {
  const base = id.replace(/-free$/, "").replace(/[_-]+/g, " ");
  return base
    .split(" ")
    .map(word => (word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ") + " (Free)";
}

/**
 * Offline fallback metadata mirroring the known Zen free tier, keyed by base
 * model id. Used when the live endpoint cannot be reached or a model has no
 * known limits.
 */
const FALLBACK_META: Record<string, ModelMeta> = {
  "deepseek-v4-flash": { reasoning: true, reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }], limit: { context: 1_000_000, output: 393_216 } },
  "muse-spark-1.2-contributor": { reasoning: true, reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] }], limit: { context: 1_048_576, output: 131_072 } },
  "mimo-v2.5": { reasoning: true, reasoning_options: [{ type: "toggle" }], limit: { context: 1_048_576, output: 131_072 } },
  "hy3": { reasoning: true, reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "high"] }], limit: { context: 256_000, output: 64_000 } },
  "nemotron-3-ultra": { reasoning: true, reasoning_options: [{ type: "toggle" }], limit: { context: 131_072, output: 32_000 } },
  "nemotron-3.5-lightning": { reasoning: true, limit: { context: 1_000_000, output: 128_000 } },
  "laguna-s-2.1": { reasoning: false, limit: { context: 262_144, output: 16_384 } },
};

export const FALLBACK_MODELS: OpenCodeModelInfo[] = Object.entries(FALLBACK_META).map(([base, meta]) => ({
  id: `opencode/${base}-free`,
  name: humanizeName(`${base}-free`),
  reasoning: meta.reasoning ?? false,
  contextWindow: meta.limit?.context ?? 128_000,
  maxTokens: meta.limit?.output ?? 16_384,
  thinkingLevelMap: buildThinkingLevelMap(meta),
}));

/**
 * Builds the pi `thinkingLevelMap` from a model's `reasoning_options`. pi only
 * hides a level that is explicitly `null` (others fall back to the provider's
 * default mapping and stay visible), so every unsupported level is nulled.
 * Effort values map to themselves ("none" normalizes to `off`); toggle-only
 * models expose just `off`.
 */
function buildThinkingLevelMap(meta: ModelMeta | undefined): Record<string, string | null> | undefined {
  if (!meta?.reasoning) return undefined;
  const options = meta.reasoning_options ?? [];
  const effort = options.find(o => o.type === "effort")?.values ?? [];
  const hasToggle = options.some(o => o.type === "toggle");
  if (effort.length === 0 && !hasToggle) return undefined;

  const map: Record<string, string | null> = {};
  for (const level of THINKING_LEVELS) map[level] = null;
  for (const value of effort) map[value === "none" ? "off" : value] = value;
  if (hasToggle && effort.length === 0) map.off = "off";
  return map;
}

export function filterFreeModels(models: Array<{ id: string; name?: string }>): OpenCodeModelInfo[] {
  return models
    .filter(m => FREE_REGEX.test(m.id))
    .map(m => {
      const base = baseModelId(m.id);
      const meta = FALLBACK_META[base];
      return {
        id: m.id.startsWith("opencode/") ? m.id : `opencode/${m.id}`,
        name: m.name ?? humanizeName(m.id),
        reasoning: meta?.reasoning ?? false,
        contextWindow: meta?.limit?.context ?? 128_000,
        maxTokens: meta?.limit?.output ?? 16_384,
        thinkingLevelMap: buildThinkingLevelMap(meta),
      };
    });
}

export async function discoverModels(opts?: { fetchFn?: typeof fetch }): Promise<OpenCodeModelInfo[]> {
  const fetcher = opts?.fetchFn ?? fetch;
  try {
    const zen = await fetcher(ZEN_MODELS_URL, {
      headers: { "x-opencode-client": "cli", "User-Agent": "opencode/0.0.0-dev" },
    });
    if (!zen.ok) return FALLBACK_MODELS;
    const data = await zen.json() as { data?: Array<{ id: string; name?: string }> };
    const filtered = filterFreeModels(data?.data ?? []);
    return filtered.length > 0 ? filtered : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}
