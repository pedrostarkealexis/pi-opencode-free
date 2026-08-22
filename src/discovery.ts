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
  /** Input modalities advertised by models.dev (subset relevant to pi). */
  input?: string[];
}

interface ModelMeta {
  name?: string;
  reasoning?: boolean;
  reasoning_options?: Array<{ type: string; values?: string[] }>;
  limit?: { context?: number; output?: number };
  input?: string[];
}

const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const MODELS_DEV_URL = "https://models.dev/api.json";
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
 * model id. Only models verified alive on the free tier are listed; models
 * whose free promotion ended (e.g. deepseek-v4-flash) or whose upstream is
 * broken (muse-spark) are excluded entirely.
 */
const FALLBACK_META: Record<string, ModelMeta> = {
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
 * Builds the pi `thinkingLevelMap` from a model's `reasoning_options`. Only
 * models advertising explicit effort values get an explicit map (plus `off`
 * when a toggle exists); anything else defers to the provider's default
 * mapping so thinking stays controllable.
 */
function buildThinkingLevelMap(meta: ModelMeta | undefined): Record<string, string | null> | undefined {
  if (!meta?.reasoning) return undefined;
  const options = meta.reasoning_options ?? [];
  const effort = options.find(o => o.type === "effort")?.values ?? [];
  const hasToggle = options.some(o => o.type === "toggle");
  if (effort.length === 0) return undefined;

  const map: Record<string, string | null> = {};
  for (const level of THINKING_LEVELS) map[level] = null;
  let sawNone = false;
  for (const value of effort) {
    if (value === "none") { map.off = "off"; sawNone = true; continue; }
    if (value in map) map[value] = value;
  }
  if (hasToggle && !sawNone) map.off = "off";
  return map;
}

export function filterFreeModels(
  models: Array<{ id: string; name?: string }>,
  opts?: { catalog?: Record<string, ModelMeta> },
): OpenCodeModelInfo[] {
  return models
    .filter(m => FREE_REGEX.test(m.id))
    .map(m => {
      const base = baseModelId(m.id);
      const bare = m.id.startsWith("opencode/") ? m.id.slice("opencode/".length) : m.id;
      // Live metadata first (models.dev); offline table is the last resort.
      // models.dev keys keep the `-free` suffix, the offline table does not.
      const meta = opts?.catalog?.[bare] ?? opts?.catalog?.[base] ?? FALLBACK_META[base];
      return {
        id: m.id.startsWith("opencode/") ? m.id : `opencode/${m.id}`,
        name: m.name ?? meta?.name ?? humanizeName(m.id),
        reasoning: meta?.reasoning ?? false,
        contextWindow: meta?.limit?.context ?? 128_000,
        maxTokens: meta?.limit?.output ?? 16_384,
        thinkingLevelMap: buildThinkingLevelMap(meta),
        input: meta?.input,
      };
    });
}

/**
 * Fetches the models.dev catalog entries for the `opencode` provider, keyed by
 * base model id. Returns null on any failure so callers can fall back to the
 * offline table without blocking.
 */
async function fetchModelsDevCatalog(fetcher: typeof fetch, timeoutMs: number): Promise<Record<string, ModelMeta> | null> {
  try {
    const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
    const res = await fetcher(MODELS_DEV_URL, { signal });
    if (!res.ok) return null;
    const cat = await res.json() as { opencode?: { models?: Record<string, unknown> } };
    const entries = cat?.opencode?.models;
    if (!entries) return null;
    const catalog: Record<string, ModelMeta> = {};
    for (const [id, raw] of Object.entries(entries)) {
      const m = raw as {
        name?: string;
        reasoning?: boolean;
        reasoning_options?: Array<{ type: string; values?: string[] }>;
        limit?: { context?: number; output?: number };
        modalities?: { input?: string[] };
      };
      catalog[id] = {
        name: m.name,
        reasoning: m.reasoning === true,
        reasoning_options: m.reasoning_options,
        limit: m.limit,
        input: m.modalities?.input,
      };
    }
    return Object.keys(catalog).length > 0 ? catalog : null;
  } catch {
    return null;
  }
}

export async function discoverModels(opts?: { fetchFn?: typeof fetch; timeoutMs?: number }): Promise<OpenCodeModelInfo[]> {
  const fetcher = opts?.fetchFn ?? fetch;
  // Strict startup budget: if neither source answers quickly enough, boot
  // proceeds on the offline catalog instead of blocking extension load.
  const timeoutMs = opts?.timeoutMs ?? 3000;
  try {
    const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
    const [zen, catalog] = await Promise.all([
      (async () => {
        const res = await fetcher(ZEN_MODELS_URL, {
          headers: { "x-opencode-client": "cli", "User-Agent": "opencode/0.0.0-dev" },
          signal,
        });
        if (!res.ok) return null;
        return await res.json() as { data?: Array<{ id: string; name?: string }> };
      })(),
      fetchModelsDevCatalog(fetcher, timeoutMs),
    ]);
    if (!zen) return FALLBACK_MODELS;
    const filtered = filterFreeModels(zen.data ?? [], { catalog: catalog ?? undefined });
    return filtered.length > 0 ? filtered : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}
