# Native Model Refresh Implementation Plan

**Goal:** Replace the boot-time fetch + `/opencode-sync` command + hardcoded fallback catalogs with pi's native `refreshModels` lifecycle (snapshot restore on cold start, network discover-and-persist on explicit refresh).

**Architecture:** The extension registers the provider once with an empty model list and implements the config-form `refreshModels(ctx)` hook — the same pattern as pi's built-in `llama.cpp` extension (`node_modules/@earendil-works/pi-coding-agent/dist/extensions/llama/provider.js`). When pi calls `refreshModels` with `allowNetwork: false` (every session init), we restore models from the persisted store snapshot (`ctx.stored`) with **zero network I/O**. When called with `allowNetwork: true` (interactive startup background refresh, `/model` picker open, `pi update --models`), we discover live from Zen + models.dev and persist the enriched catalog via `ctx.publish({ persist })`. The `/opencode-sync` command and `FALLBACK_META`/`FALLBACK_MODELS` are deleted.

**Tech Stack:** TypeScript (strict, NodeNext, ES2022), Bun test runner, `@earendil-works/pi-coding-agent` (peer, v0.84.x API), `@earendil-works/pi-ai` (peer).

**Spec:** `README.md` (project overview); design rationale was validated against installed sources:
- `docs/custom-provider.md` — Dynamic providers / `refreshModels` section
- `pi-coding-agent/dist/extensions/llama/provider.js` — canonical reference implementation
- `pi-ai/dist/models.d.ts` — `RefreshModelsContext`, `ModelsPublication`, `ModelsStoreEntry` shapes

## Global Constraints

- Core packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) stay in `peerDependencies` with `"*"` range; never move to `dependencies` (AGENTS.md).
- No mutation of prompts/messages (AGENTS.md).
- Commits in English, conventional format (`feat:`/`fix:`/`chore:`/`refactor:`).
- Type-check gate: `bunx tsc -p tsconfig.json --noEmit` must pass on every commit.
- Test gate: `bun test src/` must pass on every commit.
- Do not touch: `streamSimple` keyless shim, `OPENCODE_COMPAT`, provider headers, `apiKey: "none"` placeholder (explicitly out of scope).
- Runtime behavior contract: display names keep the `(Free)` suffix; model ids keep the `opencode/<id>-free` shape internally and `<base>` shape in `ProviderModelConfig.id`.

## Key Type Facts (verified in installed packages)

```ts
// pi-ai/dist/models.d.ts
interface RefreshModelsContext {
  credential?: Credential;
  stored?: Readonly<ModelsStoreEntry>;     // undefined until first successful persist
  publish(publication: ModelsPublication): Promise<boolean>;
  allowNetwork: boolean;                   // false on session-init refresh, true on explicit refresh
  force?: boolean;
  signal: AbortSignal;
}
interface ModelsStoreEntry {
  models: readonly Model<Api>[];           // FULL Model objects (api, provider, baseUrl stamped)
  lastModified?: number;
  checkedAt?: number;
  etag?: string;
}
// Config-form registerProvider: "The returned list replaces extension-provided models."
```

Timing guarantee (verified in `dist/core/agent-session-services.js:98` and `dist/modes/interactive/interactive-mode.js:772-778`): session init calls refresh with `allowNetwork: false`; right after, interactive mode fires a background network refresh (15s timeout) unless `PI_OFFLINE` is set.

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `src/discovery.ts` | Live discovery: Zen free-list filter + models.dev enrichment | Modify: delete `FALLBACK_META`, `FALLBACK_MODELS`; failures return `[]` |
| `src/index.ts` | Provider registration + `refreshModels` hook | Modify: add restore/persist paths, stop boot fetch, delete command |
| `src/discovery.test.ts` | Discovery unit tests | Modify: replace fallback-dependent tests |
| `src/index.test.ts` | Provider/refresh unit tests (hermetic fetch stubs) | Modify: replace all provider tests |
| `scripts/smoke-real.ts` | Live API smoke test | No change (imports only `discoverModels`) |
| `README.md` | User docs | Modify: remove `/opencode-sync` docs, document native refresh |
| `plans/native-model-refresh.md` | This plan | Create |

---

### Task 1: Remove hardcoded fallback catalogs from discovery

**Files:**
- Modify: `src/discovery.ts:47-66` (delete block), `src/discovery.ts:100`, `src/discovery.ts:164-171`
- Test: `src/discovery.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `discoverModels(opts?: { fetchFn?: typeof fetch; timeoutMs?: number; signal?: AbortSignal }): Promise<OpenCodeModelInfo[]>` — same signature, but **all failure modes return `[]`**; `FALLBACK_MODELS` no longer exists (later tasks must not import it).

- [ ] **Step 1: Rewrite the failing tests**

In `src/discovery.test.ts`, change the import line to remove `FALLBACK_MODELS`:

```ts
import { discoverModels, filterFreeModels } from "./discovery.js";
```

Replace the first test's metadata assertions (without `FALLBACK_META`, unknown ids get conservative defaults):

```ts
test("filterFreeModels filters free models with conservative default metadata", () => {
  const input = [
    { id: "hy3-free", name: "Hy3" },
    { id: "gpt-5.6-sol", name: "Paid Model" },
    { id: "big-pickle", name: "Big Pickle" },
  ];
  const result = filterFreeModels(input);
  assert.deepEqual(result.map(m => m.id), ["opencode/hy3-free", "opencode/big-pickle"]);
  assert.equal(result[0].reasoning, false);      // no catalog, no FALLBACK_META
  assert.equal(result[0].contextWindow, 128_000);
});
```

Delete the test `"fallback catalog excludes models whose free promotion ended"` entirely.

Replace `"discoverModels returns fallback models when zen fetch fails"`:

```ts
test("discoverModels returns empty list when zen fetch fails", async () => {
  const failingFetch = async () => { throw new Error("Offline"); };
  const models = await discoverModels({ fetchFn: failingFetch as typeof fetch });
  assert.deepEqual(models, []);
});
```

Replace `"discoverModels falls back to offline metadata when models.dev is unreachable"`:

```ts
test("discoverModels applies conservative defaults when models.dev is unreachable", async () => {
  const routes = (url: string | URL | Request) => {
    if (String(url).includes("models.dev")) return Promise.reject(new Error("Offline"));
    return Promise.resolve({ ok: true, json: async () => ({ data: [{ id: "hy3-free" }] }) });
  };
  const models = await discoverModels({ fetchFn: routes as unknown as typeof fetch });
  const hy3 = models.find(m => m.id === "opencode/hy3-free");
  assert.ok(hy3);
  assert.equal(hy3.contextWindow, 128_000); // default, not stale hardcoded value
});
```

Replace `"discoverModels falls back to offline catalog when fetch times out or aborts"` final assertion:

```ts
test("discoverModels returns empty list when fetch times out or aborts", async () => {
  const hangingFetch = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Timeout", "AbortError")));
    });
  const models = await discoverModels({ fetchFn: hangingFetch as unknown as typeof fetch, timeoutMs: 10 });
  assert.deepEqual(models, []);
});
```

Leave `"discoverModels serves every free model listed by the endpoint"` and `"discoverModels enriches metadata from models.dev..."` untouched.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/discovery.test.ts`
Expected: FAIL — `FALLBACK_MODELS` still exported and old behaviors intact.

- [ ] **Step 3: Implement the removal**

In `src/discovery.ts` delete lines 47–66 (comment, `FALLBACK_META`, `FALLBACK_MODELS`). At line 100 change:

```ts
const meta = opts?.catalog?.[bare] ?? opts?.catalog?.[base];
```

In `discoverModels` replace the three fallback returns:

```ts
if (!zen) return [];
const filtered = filterFreeModels(zen.data ?? [], { catalog: catalog ?? undefined });
return filtered;
```
and the `catch` block ends with `return [];`.

- [ ] **Step 4: Run tests and type-check**

Run: `bun test src/ && bunx tsc -p tsconfig.json --noEmit`
Expected: FAIL in `src/index.test.ts` (imports `FALLBACK_MODELS`) — acceptable intermediate state; fix by removing `, FALLBACK_MODELS` from the import and deleting the `assert.ok(Array.isArray(FALLBACK_MODELS))` line in `"module exports are defined and functions"`.
Re-run until green.

- [ ] **Step 5: Commit**

```bash
git add src/discovery.ts src/discovery.test.ts src/index.test.ts
git commit -m "refactor: drop hardcoded offline fallback catalogs"
```

---

### Task 2: Restore persisted snapshot natively (cache-only path)

**Files:**
- Modify: `src/index.ts:1-4` (imports), `src/index.ts:6` (add `BASE_URL`), `src/index.ts:29-70` (factory), `src/index.test.ts`

**Interfaces:**
- Consumes: `discoverModels` (unchanged signature), existing `toProviderModel` helper.
- Produces:
  - `const BASE_URL = "https://opencode.ai/zen/v1"`
  - `function toStoredModel(config): StoredModel` — spreads config + `{ api: "openai-completions", provider: PROVIDER_ID, baseUrl: BASE_URL }`
  - `function fromStoredModel(m): config` — destructures away `api`/`provider`/`baseUrl`, returns the rest
  - `refreshModels(ctx)` handling `allowNetwork === false` (network path lands in Task 3)

- [ ] **Step 1: Write the failing tests**

In `src/index.test.ts`, replace the two existing provider tests (`"opencodeDirectExtension registers native..."` and `"/opencode-sync re-registers..."`) with:

```ts
test("registers provider once with empty initial models and no boot fetch", async () => {
  let fetchCount = 0;
  globalThis.fetch = (async () => { fetchCount++; throw new Error("must not fetch"); }) as typeof fetch;
  try {
    let registeredId = ""; let registeredConfig: any = null;
    const fakePi = {
      registerProvider(id: string, config: any) { registeredId = id; registeredConfig = config; },
      registerCommand() {},
    } as unknown as ExtensionAPI;
    await opencodeDirectExtension(fakePi);
    assert.equal(registeredId, "opencode-free");
    assert.equal(fetchCount, 0);                    // no fetch during extension load
    assert.deepEqual(registeredConfig.models, []);  // populated by refreshModels
    assert.equal(registeredConfig.api, "openai-completions");
    assert.equal(registeredConfig.baseUrl, "https://opencode.ai/zen/v1");
    assert.equal(typeof registeredConfig.refreshModels, "function");
  } finally { globalThis.fetch = originalFetch; }
});

test("cache-only refresh restores persisted snapshot without network", async () => {
  globalThis.fetch = (async () => { throw new Error("must not fetch"); }) as typeof fetch;
  try {
    let registeredConfig: any = null;
    const fakePi = {
      registerProvider(_id: string, config: any) { registeredConfig = config; },
      registerCommand() {},
    } as unknown as ExtensionAPI;
    await opencodeDirectExtension(fakePi);

    const storedModel = {
      id: "hy3-free", name: "Hy3 (Free)", api: "openai-completions",
      provider: "opencode-free", baseUrl: "https://opencode.ai/zen/v1",
      reasoning: true, input: ["text"], contextWindow: 256_000, maxTokens: 64_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    };
    const restored = await registeredConfig.refreshModels({
      allowNetwork: false,
      signal: new AbortController().signal,
      stored: { models: [storedModel] },
      publish: async () => true,
    });
    assert.equal(restored.length, 1);
    assert.equal(restored[0].id, "hy3-free");            // stripped back to config shape
    assert.equal(restored[0].contextWindow, 256_000);
    assert.equal((restored[0] as any).provider, undefined); // api/provider/baseUrl removed
  } finally { globalThis.fetch = originalFetch; }
});

test("cache-only refresh with no stored snapshot yields empty list", async () => {
  globalThis.fetch = (async () => { throw new Error("must not fetch"); }) as typeof fetch;
  try {
    let registeredConfig: any = null;
    const fakePi = {
      registerProvider(_id: string, config: any) { registeredConfig = config; },
      registerCommand() {},
    } as unknown as ExtensionAPI;
    await opencodeDirectExtension(fakePi);
    const restored = await registeredConfig.refreshModels({
      allowNetwork: false, signal: new AbortController().signal,
      stored: undefined, publish: async () => true,
    });
    assert.deepEqual(restored, []);
  } finally { globalThis.fetch = originalFetch; }
});
```

Note: keep `originalFetch` defined at the top of each test as in existing tests (`const originalFetch = globalThis.fetch;`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/index.test.ts`
Expected: FAIL — `refreshModels` restores nothing yet; factory still fetches at boot (`fetchCount > 0`, models non-empty).

- [ ] **Step 3: Implement**

In `src/index.ts`, next to `PROVIDER_ID` add:

```ts
const BASE_URL = "https://opencode.ai/zen/v1";
```

Below `toProviderModel` add the two conversion helpers:

```ts
function toStoredModel(config: ReturnType<typeof toProviderModel>) {
  return { ...config, api: "openai-completions" as const, provider: PROVIDER_ID, baseUrl: BASE_URL };
}

function fromStoredModel(m: ReturnType<typeof toStoredModel>) {
  const { api: _api, provider: _provider, baseUrl: _baseUrl, ...config } = m;
  return config;
}
```

Rewrite the factory body — registration happens once, no fetch, `models: []`, and the cache-only branch of `refreshModels` (leave the network branch as a `[]` stub for Task 3):

```ts
export default function opencodeDirectExtension(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER_ID, {
    name: "OpenCode Direct (Free)",
    baseUrl: BASE_URL,
    apiKey: "none",
    api: "openai-completions",
    headers: { /* unchanged */ },
    models: [],
    async refreshModels(ctx) {
      if (!ctx.allowNetwork) {
        return ctx.stored?.models
          .filter(m => m.provider === PROVIDER_ID && m.api === "openai-completions")
          .map(fromStoredModel) ?? [];
      }
      return [];
    },
    streamSimple: /* unchanged shim */,
  });
}
```

Use the existing `BASE_URL` in the `baseUrl` field; keep headers/shim exactly as they are. The factory is no longer `async` and the `registerProvider` closure, `await registerProvider()`, stay deleted in Task 4's scope only if trivially removable — for THIS task simply stop calling it at boot; leave the command untouched (it keeps compiling against the closure).

- [ ] **Step 4: Run tests and type-check**

Run: `bun test src/ && bunx tsc -p tsconfig.json --noEmit`
Expected: PASS except the old `"/opencode-sync re-registers..."` test already replaced in Step 1.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: restore persisted model snapshot natively via refreshModels"
```

---

### Task 3: Discover and persist on network refresh

**Files:**
- Modify: `src/index.ts` (`refreshModels` network branch)
- Test: `src/index.test.ts`

**Interfaces:**
- Consumes: `discoverModels({ signal })`, `toProviderModel`, `toStoredModel` from Tasks 1–2.
- Produces: complete `refreshModels` behavior — network branch fetches, maps, persists via `ctx.publish({ persist: { models, checkedAt } })`, guards against wiping a good snapshot when discovery returns empty.

- [ ] **Step 1: Write the failing tests**

Append to `src/index.test.ts`:

```ts
test("network refresh discovers models and persists a stamped snapshot", async () => {
  const zenResponse = { ok: true, json: async () => ({ data: [{ id: "hy3-free", name: "Hy3" }] }) };
  let published: any = null;
  globalThis.fetch = (async () => zenResponse) as unknown as typeof fetch;
  try {
    let registeredConfig: any = null;
    const fakePi = {
      registerProvider(_id: string, config: any) { registeredConfig = config; },
      registerCommand() {},
    } as unknown as ExtensionAPI;
    await opencodeDirectExtension(fakePi);

    const refreshed = await registeredConfig.refreshModels({
      allowNetwork: true,
      signal: new AbortController().signal,
      stored: undefined,
      publish: async (publication: any) => { published = publication; return true; },
    });

    assert.equal(refreshed[0].id, "hy3-free");
    assert.equal(refreshed[0].compat.maxTokensField, "max_tokens"); // config shape
    assert.ok(published, "persist must be called on successful discovery");
    assert.equal(published.persist.models[0].provider, "opencode-free"); // stamped
    assert.equal(published.persist.models[0].api, "openai-completions");
    assert.equal(typeof published.persist.checkedAt, "number");
  } finally { globalThis.fetch = originalFetch; }
});

test("network refresh never wipes a good snapshot when discovery comes back empty", async () => {
  globalThis.fetch = (async () => { throw new Error("Offline"); }) as typeof fetch;
  try {
    let registeredConfig: any = null; let publishCalled = false;
    const fakePi = {
      registerProvider(_id: string, config: any) { registeredConfig = config; },
      registerCommand() {},
    } as unknown as ExtensionAPI;
    await opencodeDirectExtension(fakePi);
    const refreshed = await registeredConfig.refreshModels({
      allowNetwork: true, signal: new AbortController().signal,
      stored: { models: [{ id: "old", provider: "opencode-free", api: "openai-completions" }] },
      publish: async () => { publishCalled = true; return true; },
    });
    assert.deepEqual(refreshed, []);
    assert.equal(publishCalled, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("network refresh respects abort signal before fetching", async () => {
  let fetchCount = 0;
  globalThis.fetch = (async () => { fetchCount++; return { ok: true }; }) as typeof fetch;
  try {
    let registeredConfig: any = null;
    const fakePi = {
      registerProvider(_id: string, config: any) { registeredConfig = config; },
      registerCommand() {},
    } as unknown as ExtensionAPI;
    await opencodeDirectExtension(fakePi);
    const controller = new AbortController();
    controller.abort();
    const refreshed = await registeredConfig.refreshModels({
      allowNetwork: true, signal: controller.signal,
      stored: undefined, publish: async () => true,
    });
    assert.deepEqual(refreshed, []);
    assert.equal(fetchCount, 0);
  } finally { globalThis.fetch = originalFetch; }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/index.test.ts`
Expected: FAIL — network branch currently returns `[]` and never publishes.

- [ ] **Step 3: Implement the network branch**

Replace the `return [];` stub inside `refreshModels`:

```ts
if (ctx.signal.aborted) return [];
const discovered = await discoverModels({ signal: ctx.signal });
if (discovered.length === 0) return []; // keep previous snapshot; retry on next refresh
const configs = discovered.map(toProviderModel);
await ctx.publish({ persist: { models: configs.map(toStoredModel), checkedAt: Date.now() } });
return configs;
```

- [ ] **Step 4: Run tests and type-check**

Run: `bun test src/ && bunx tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: discover and persist free models on network refresh"
```

---

### Task 4: Delete /opencode-sync and update docs

**Files:**
- Modify: `src/index.ts:72-77` (command block), `src/index.ts:36-38` (dead closure, if any remains), `src/index.ts:1` (unused import)
- Modify: `README.md` (Usage section, file table)
- Test: `src/index.test.ts` (already clean after Tasks 1–2)

**Interfaces:**
- Consumes: everything from Tasks 1–3 (final state).
- Produces: public surface = provider registration only. No commands. `ExtensionCommandContext` import gone.

- [ ] **Step 1: Write the failing test**

Add a negative test proving no command is registered:

```ts
test("registers no slash commands", async () => {
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ data: [] }) })) as unknown as typeof fetch;
  try {
    const commands: string[] = [];
    const fakePi = {
      registerProvider() {},
      registerCommand(name: string) { commands.push(name); },
    } as unknown as ExtensionAPI;
    await opencodeDirectExtension(fakePi);
    assert.deepEqual(commands, []);
  } finally { globalThis.fetch = originalFetch; }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/index.test.ts`
Expected: FAIL — `registerCommand("opencode-sync")` still exists.

- [ ] **Step 3: Implement the removal**

Delete from `src/index.ts`: the `registerProvider` closure wrapper and `await registerProvider();` (registration is now inline from Task 2), the whole `pi.registerCommand("opencode-sync", ...)` block, and `ExtensionCommandContext` from the type import on line 1. Final import line:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
```

In `README.md`, replace the Usage section:

```markdown
## Usage

Pick any `(Free)` model in Pi's model selector. The free-model catalog is
managed natively by Pi: it loads instantly from a persisted snapshot and
refreshes itself in the background on startup, when opening the model
selector, or via `pi update --models`.
```

Update the file table rows:

```markdown
| `src/discovery.ts` | Free-model discovery (Zen + models.dev enrichment) |
| `src/index.ts` | Native provider registration and snapshot persistence |
```

- [ ] **Step 4: Full verification**

Run: `bun test src/ && bunx tsc -p tsconfig.json --noEmit && bun scripts/smoke-real.ts`
Expected: tests PASS, typecheck OK, smoke lists ≥1 free model end-to-end through the live Zen API.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts README.md
git commit -m "feat: rely on native model refresh; remove /opencode-sync"
```

---

## Post-Completion Manual Check (not a task)

After Task 4, install locally and confirm real-world behavior once:

```bash
pi install /home/pedro/Projetos/pi-opencode-free   # first run: background refresh populates snapshot
# quit, relaunch:
pi                                                  # picker shows (Free) models instantly, zero boot latency
PI_OFFLINE=1 pi                                     # snapshot still served offline
```
