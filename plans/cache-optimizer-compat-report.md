# Compatibility Report: pi-cache-optimizer × pi-opencode-free

| # | Area | Verdict | Evidence |
|---|------|---------|----------|
| 1 | Header mutation vs keyless shim | PASS (verified) | cache-opt only adds `session_id`/`x-client-request-id`/`x-session-affinity` via `setProviderHeaderIfMissing`; never touches `Authorization`/`User-Agent`/`x-opencode-*`. Order verified in Task 2. |

### 1b. Pipeline order (Task 2) — definitive

Call chain: `sdk.js:180-199` passes `transformHeaders` (which emits `before_provider_headers`) into `modelRuntime.streamSimple`; `pi-ai/dist/models.js:394-399` `ModelsImpl.streamSimple` → `applyAuth` runs `options.transformHeaders(headers)` at :372-373, producing `requestOptions.headers`; **then** :398 calls `provider.streamSimple(requestModel, context, requestOptions)` — the extension-registered opencode-free shim (`src/index.ts:76-81`), which spreads `{ ...options.headers, Authorization: null }` last.

Therefore the shim's `Authorization: null` always wins over anything a header hook sets; hook-added affinity headers (`session_id`, `x-client-request-id`, `x-session-affinity`, when compat opts in) survive and are additive.

Hermetic proof: `/tmp/header-order.test.ts` (not committed) simulating the exact applyAuth→shim composition with an adversarial hook that injects `Authorization: "Bearer x"` → final header is `null`. 1 pass.
| 2 | Payload rewrite vs Zen compat quirks | PASS (verified) | Only ops on `openai-completions`: `prompt_cache_retention` strip + `prompt_cache_key` add. No rename of `max_tokens`, no touch of `reasoning_content`. Runtime tests: Task 3. `src/compat.test.ts` (4 tests, all passing) pins: retention-strip preserves `max_tokens`/`reasoning_content`/tool_calls; `prompt_cache_key` injection is spread-additive; no `max_tokens`→`max_completion_tokens` rename; shim's `Authorization:null` beats hook injection. |
| 3 | Prompt/message mutation | RISK (benign) | `before_agent_start` rewrites system prompt (churn strip / skill compression / reorder). Content-rewriting but prompt-only; does not touch messages or `reasoning_content` replay. |
| 4 | Usage/cost accounting | PASS (static) | Footer shows token/cache stats from usage records; cost defaults `{input:0,output:0,...}` when unknown — truthful for zero-cost models. |
| 5 | Live matrix | PASS | Both enabled: plain/tool/reasoning prompts OK; baseline without cache-optimizer identical; no 4xx. |
| — | **Overall** | **COMPATIBLE WITH RISKS (minor)** | see verdict at end |

## Findings

### 1. Header mutation vs keyless shim

`before_provider_headers` handler (`~/.pi/agent/npm/node_modules/pi-cache-optimizer/index.ts:8458-8465`) calls
`addEffectiveSessionAffinityHeaders(event.headers, ...)`.

That function (:1408-1452):
- Gates: optimizer enabled + non-empty sessionId (:1411), api must be `openai-completions` and baseUrl non-official-OpenAI (:1417), effective compat `sendSessionAffinityHeaders === true` (:1426).
- Writes **only** `session_id`, `x-client-request-id`, `x-session-affinity`, each via `setProviderHeaderIfMissing` (:1437-1449).

It does **not** read, set, or delete `Authorization`, `User-Agent`, or any `x-opencode-*` header, and has no dependency on apiKey presence.

⚠️ Note for opencode-free specifically: whether affinity headers are injected depends on the model's effective compat (`sendSessionAffinityHeaders`). If the Zen models don't opt in (default undefined → not true), nothing is added at all. Even if added, they are additive custom headers — Zen tolerates unknown headers unless proven otherwise (verify live, row 5).

**Order question (Authorization):** moot statically — the hook cannot inject Authorization under any code path (whole function audited; `rg -n "Authorization" index.ts` hits only unrelated contexts — to confirm in Task 2 runtime test anyway).

### 2. Payload rewrite vs Zen compat quirks

`before_provider_request` (:8467-8518) operations:

| Op | Gate | Effect |
|----|------|--------|
| `normalizeAnthropicCacheControlTtlOrder` / `downgradeAnthropicLongCacheControls` (:8475-8480) | `isAnthropicMessagesApi(model.api)` only | Not applicable — Zen models are `openai-completions`. |
| `delete payload.prompt_cache_retention` (:8483-8509) | string field present; strips for all but official OpenAI / explicit opt-in | Safe/possibly beneficial: prevents "Extra inputs are not permitted" 400s; does not affect required fields. |
| `addOpenAIPromptCacheKey` (:8514-8517, :2729) | api ∈ {openai-completions, openai-responses} (:1759-1761, :1728-1731); skips if payload already has one | Adds top-level `prompt_cache_key: <hash>`. Spread-based, preserves all existing fields. Risk: if Zen rejects unknown body fields with 400 → live-matrix watch item. |

No code path renames `max_tokens`, deletes `store`, or rewrites message contents (`rg "max_completion_tokens"` only appears in compat validation/type defs :231,:1318,:1748; `reasoning_content` only appears in display strings :3048). No collision with `compat.requiresReasoningContentOnAssistantMessages`.

### 3. Prompt/message mutation

- `before_agent_start` (:8338-8455): returns `{ systemPrompt }` replacements — session-overview churn strip, skills XML compression, stable-prefix reorder. This is **content-rewriting of the system prompt only**. It changes bytes shipped to Zen (cache-friendlier), not structure; reasoning/tool traffic unaffected. Tagged RISK(benign): it can only reduce hit-rate truthfulness if a bug made prompts unstable — live matrix should confirm responses stay coherent.
- `message_end` (:8581+): read-only bookkeeping (records 400-signal models); no `{ message }` replacement.
- `tool_execution_end` / `agent_settled` / `session_shutdown` (:8307-8331): metadata refresh/publish only.

### 5. Live matrix (Task 4)

Both extensions enabled (`~/.pi/agent/settings.json`), `PI_OFFLINE=1`, non-interactive `-p` runs against the `opencode-free` provider:

- Plain prompt (`reply with just: ok`) → `ok`. No 400/401.
- Tool prompt (bash line count of `src/index.ts`) → `82`, correct; tool executed end-to-end.
- Reasoning prompt (`--thinking low`, 17×23) → correct answer with visible thinking text.
- Baseline with cache-optimizer temporarily disabled via settings.json → identical output (`82`); settings restored and verified.
- Offline init with both enabled → no crash; snapshot-based model resolution worked.

Not exercised headlessly: TUI `/cache-optimizer` footer rendering and multi-turn hit-rate movement. Footer stats derive from usage records with zero default costs for unknown models (§4); visual confirmation left to the user.

## Overall verdict

**COMPATIBLE WITH RISKS (minor, none blocking).** No BLOCKER found → Task 5 not triggered.

cache-optimizer never touches `Authorization`/`User-Agent`/`x-opencode-*` headers (§1), and even an adversarial header hook cannot defeat the keyless shim: pi applies `transformHeaders` inside `applyAuth` before invoking the extension's `streamSimple`, whose `Authorization: null` spread runs last (§1b). Its only openai-completions payload ops are deleting `prompt_cache_retention` and additively spreading `prompt_cache_key` (§2) — no collision with Zen's `max_tokens`/`reasoning_content` compat quirks, pinned by `src/compat.test.ts` (4 passing tests).

Residual watch items:
1. If Zen ever 400s on the injected top-level `prompt_cache_key`, opt out via cache-optimizer's env flag rather than disabling it.
2. Affinity headers are added only when a model's compat opts into `sendSessionAffinityHeaders`; if a future Zen 403 implicates them, use cache-optimizer's documented compat fix.
3. System-prompt rewriting changes shipped bytes vs stock pi; live checks show coherent responses. Diff any future oddity with `PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1`.

### 4. Usage/cost accounting

Footer status derives from usage records (`usageRecordFromAssistant` :2560+, raw fallbacks for native usage fields). Unknown-model costs default to zeros (`fallback?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }` :1032, :2505). For free Zen models the footer reports tokens/hit-rates without inventing dollar costs. PASS statically.
