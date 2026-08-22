# pi-cache-optimizer × pi-opencode-free Compatibility Investigation Plan

**Goal:** Produce an evidence-backed compatibility verdict between `pi-cache-optimizer` v2.8.5 and `pi-opencode-free`, covering every hook where both extensions touch the same request/response pipeline.

**Architecture:** Static analysis first (map what each hook in pi-cache-optimizer actually does to requests targeting the `opencode-free` provider), then pipeline-order verification against installed pi sources, then hermetic tests, then one live interactive matrix. Each task ends in a written finding — no fixes unless a task explicitly says so.

**Tech Stack:** ripgrep, bun, the installed packages under `~/.pi/agent/npm/node_modules/pi-cache-optimizer/` (target) and `/home/pedro/Projetos/pi-opencode-free` (subject), pi sources at `~/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/`.

**Spec:** Compatibility = all three hold simultaneously: (1) every Zen request still carries the free-tier authorization headers and omits `Authorization`; (2) cache-optimizer's transformations never cause 4xx from Zen nor corrupt reasoning/tool traffic; (3) cache-optimizer's footer stats stay truthful for zero-cost models. Sources of truth: `pi-opencode-free/src/index.ts`, `pi-cache-optimizer/index.ts`.

## Global Constraints

- Investigation only: **do not edit either extension** unless a task explicitly orders a fix.
- Never send real API keys during live tests; opencode-free is keyless by design.
- Record findings in `plans/cache-optimizer-compat-report.md` as you go (create in Task 1).
- Every claim must cite file:line evidence or a reproducible command output. "Probably fine" is not a finding.
- Environment facts already verified (do not re-derive):
  - pi-cache-optimizer hooks: `session_start` (:8293), `tool_execution_end` (:8307), `agent_settled` (:8312), `session_shutdown` (:8317), `model_select` (:8332), `before_agent_start` (:8338), `before_provider_headers` (:8458), `before_provider_request` (:8467), `after_provider_response` (:8520), `message_end` (:8581), command `cache-optimizer` (:9278).
  - pi-opencode-free touches: custom headers (`x-opencode-client`, `x-opencode-project`, `User-Agent`), `streamSimple` shim setting `Authorization: null`, `compat.maxTokensField = "max_tokens"`, `compat.requiresReasoningContentOnAssistantMessages = true`.
  - Both are loaded globally (`~/.pi/agent/settings.json` packages list).

---

### Task 1: Map cache-optimizer behavior on the opencode-free request path

**Files:**
- Read: `~/.pi/agent/npm/node_modules/pi-cache-optimizer/index.ts`
- Create: `plans/cache-optimizer-compat-report.md`

**Interfaces:**
- Produces: report skeleton with one section per hook; each finding tagged `PASS` / `RISK` / `BLOCKER` with file:line citations. Later tasks fill the runtime-verification columns.

- [ ] **Step 1: Create the report skeleton**

```markdown
# Compatibility Report: pi-cache-optimizer × pi-opencode-free

| # | Area | Verdict | Evidence |
|---|------|---------|----------|
| 1 | Header mutation vs keyless shim | ? | |
| 2 | Payload rewrite vs Zen compat quirks | ? | |
| 3 | Prompt/message mutation | ? | |
| 4 | Usage/cost accounting | ? | |
| 5 | Live matrix | ? | |

## Findings
(one numbered section per row)
```

- [ ] **Step 2: Analyze `before_provider_headers` (index.ts:8458)**

Read the handler body (~lines 8458–8520). Answer with citations:
- Does it add/override/delete any of: `Authorization`, `User-Agent`, `x-opencode-*`?
- Does it apply unconditionally to all providers, or filter by provider id / api type?
- Does it depend on an apiKey being present?

Run: `sed -n '8458,8560p' ~/.pi/agent/npm/node_modules/pi-cache-optimizer/index.ts`

- [ ] **Step 3: Analyze `before_provider_request` (index.ts:8467)**

Answer with citations:
- Does it rewrite/delete fields in the JSON payload (e.g. `max_tokens`, `max_completion_tokens`, `reasoning_content`, `store`, `cache_control`)?
- Is there provider/api gating (`openai-completions` only? allowlist/denylist by provider id)?
- Does anything it injects collide with `compat.requiresReasoningContentOnAssistantMessages` replay?

Run: `sed -n '8460,8580p' ~/.pi/agent/npm/node_modules/pi-cache-optimizer/index.ts` plus targeted `rg -n "max_completion_tokens|reasoning_content|cache_control" ...`

- [ ] **Step 4: Analyze prompt-side hooks**

Skim `before_agent_start` (:8338–8458) and `message_end` (:8581+): do they mutate `event.systemPrompt` or return `{ message }` replacements? Note whether changes are content-rewriting (risk) or metadata-only (safe).

- [ ] **Step 5: Commit the skeleton with static findings**

```bash
git add plans/cache-optimizer-compat-report.md
git commit -m "docs: static compatibility analysis of pi-cache-optimizer"
```

---

### Task 2: Verify pipeline order between header hook and the streamSimple shim

This is the highest-risk item: opencode-free's shim sets `Authorization: null` inside `streamSimple`, while cache-optimizer mutates headers in `before_provider_headers`. If the hook runs **after** the shim composes headers, an injected `Authorization` would reach Zen and trigger 401.

**Files:**
- Read: `~/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js`
- Modify: `plans/cache-optimizer-compat-report.md` (row 1)

**Interfaces:**
- Consumes: Task 1 findings (what the header hook actually does).
- Produces: definitive answer — final `Authorization` state on a Zen request when both extensions are active.

- [ ] **Step 1: Trace the call order in pi sources**

Run:
```bash
rg -n "before_provider_headers|streamSimple|emitHeaderHook" \
  ~/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/*.js --glob '!*.map'
```
Determine: does pi emit `before_provider_headers` on the headers object *passed into* the provider's `streamSimple(options.headers)`, or on a separate layer applied after streaming begins? Cite the exact lines establishing order.

- [ ] **Step 2: Write a hermetic proof test (temporary, not committed)**

Create `/tmp/header-order.test.ts`: fake `fetch` capturing received headers; register a stub provider whose `streamSimple` spreads `{ ...options.headers, Authorization: null }`; simulate the header hook mutating `Authorization: "Bearer x"`. Assert which value wins. Run `bun test /tmp/header-order.test.ts`.

Expected possible outcomes:
- Shim wins (hook ran first) → row 1 = `PASS`.
- Hook wins (`Bearer x` reaches fetch) → row 1 = `BLOCKER`, go to Task 5 fix.

- [ ] **Step 3: Record finding + commit**

Update report row 1 with verdict, evidence lines, and the captured header set.

```bash
git add plans/cache-optimizer-compat-report.md
git commit -m "docs: header pipeline order verdict"
```

---

### Task 3: Hermetic payload-interaction tests

**Files:**
- Create: `src/compat.test.ts` (permanent regression tests, committed)
- Modify: `plans/cache-optimizer-compat-report.md` (row 2)

**Interfaces:**
- Consumes: `registerProvider` config exported indirectly via `opencodeDirectExtension` (existing fake-pi pattern in `src/index.test.ts`).
- Produces: `src/compat.test.ts` proving Zen-request shape survives cache-optimizer-style payload transforms.

- [ ] **Step 1: Extract cache-optimizer's actual transforms**

From Task 1 Step 3, list the concrete field operations it performs on `openai-completions` payloads (names + before→after). Only proceed once this list is written in the report.

- [ ] **Step 2: Write failing-proof tests replicating those transforms**

In `src/compat.test.ts`, reuse the fake-pi pattern from `src/index.test.ts`. For each transform from Step 1: build a representative payload (assistant message with `reasoning_content`, tool calls, `max_tokens`), apply cache-optimizer's operation verbatim, then assert invariants Zen requires:

```ts
// example shape — replicate per real transform found in Task 1
test("reasoning_content survives cache-optimizer normalization", () => {
  const msg = { role: "assistant", reasoning_content: "<think>...</think>", content: "" };
  const normalized = applyCacheOptimizerTransform(msg); // mirror of its real code
  assert.ok(normalized.reasoning_content !== undefined || normalized.reasoning === undefined,
    "Zen replays reasoning only if the field is intact");
});
```

Also assert `max_tokens` is never renamed to `max_completion_tokens` post-transform.

- [ ] **Step 3: Run and triage**

Run: `bun test src/compat.test.ts`
- All pass → row 2 = `PASS`.
- Any invariant breaks → row 2 = `RISK`/`BLOCKER` + Task 5.

- [ ] **Step 4: Commit**

```bash
git add src/compat.test.ts plans/cache-optimizer-compat-report.md
git commit -m "test: pin Zen payload invariants against cache-optimizer transforms"
```

---

### Task 4: Live matrix in real pi sessions

**Files:**
- Modify: `plans/cache-optimizer-compat-report.md` (rows 3–5)

**Interfaces:**
- Consumes: Tasks 1–3 verdicts (know exactly which symptoms to watch).
- Produces: final verdict column filled.

- [ ] **Step 1: Baseline run without cache-optimizer**

Temporarily disable it: `pi config` → disable `npm:pi-cache-optimizer` (global). Start `pi`, pick `x-preview-f-free`, run one prompt exercising tools ("list files here and count lines of src/index.ts") and one reasoning prompt. Note: responses OK, footer stats absent, no warnings.

- [ ] **Step 2: Re-enable and repeat**

Re-enable via `pi config`. Same two prompts plus `/cache-optimizer` command output. Compare:
- Any 400/401 from Zen? (would implicate rows 1–2)
- Do cache hit-rate stats render and move plausibly (first miss → later hits)?
- Does reasoning content still stream correctly?
- Do tools still execute end-to-end?

- [ ] **Step 3: Offline snapshot sanity**

`PI_OFFLINE=1 pi` with both enabled: picker still lists `(Free)` models from the persisted snapshot, no crash from either extension during init refresh.

- [ ] **Step 4: Finalize report and commit**

Fill rows 3–5, write an overall verdict paragraph: FULLY COMPATIBLE / COMPATIBLE WITH RISKS (list) / INCOMPATIBLE (mechanism + minimal fix proposal).

```bash
git add plans/cache-optimizer-compat-report.md
git commit -m "docs: finalize cache-optimizer compatibility verdict"
```

---

### Task 5 (conditional): Minimal fix if any BLOCKER found

**Trigger:** only if Tasks 2–4 produced a BLOCKER.

**Files:** depends on mechanism — likely `pi-opencode-free/src/index.ts` (defend our own request invariants inside the existing `streamSimple` shim, e.g. force-delete keys cache-optimizer injected).

**Steps:** mirror TDD — write failing hermetic test reproducing the BLOCKER, implement the smallest shim-level defense, verify live matrix again, commit `fix: harden zen request invariants against header/payload mutation`.

If the fix would require editing pi-cache-optimizer instead, stop and present findings to the user — upstream patch or disablement is a user decision, not an autonomous one.
