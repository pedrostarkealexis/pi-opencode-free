# pi-opencode-free

Zero-daemon, pure-passthrough native Pi extension that connects Pi directly to OpenCode Zen API with dynamic model discovery, stable KV-cache session hashing, real-time SSE streaming, and native tool calling.

## Architecture

A single in-process TypeScript extension that registers a provider in Pi using `ExtensionAPI.registerProvider`. It dynamically fetches free models on boot from OpenCode Zen, computes stable session-affinity headers in memory per conversation, and streams upstream SSE chunks directly into Pi's event stream — no intermediate proxy processes, no PID files, no prompt mutations.

## Structure

| File | Purpose |
|------|---------|
| `src/discovery.ts` | `discoverModels()` — fetch `https://opencode.ai/zen/v1/models` with offline `FALLBACK_MODELS` |
| `src/headers.ts` | `createSessionHeaders()` — deterministic `x-opencode-session` hash anchored on `messages[0..1]` |
| `src/stream.ts` | `streamOpenCodeDirect()` — SSE engine emitting text, thinking (`reasoning_content`), and tool calls; `parseSseLine()` |
| `src/index.ts` | Extension entrypoint registering the `opencode-direct` provider + `/opencode-sync` command |

## Usage

Install dependencies and run tests:

```bash
npm install
bun test src/          # or: npm run build && node --test dist/*.test.js
```

Load the extension in Pi:

```bash
pi -e ./src/index.ts
```

## Key Properties

- **Dynamic discovery:** model list refreshed from OpenCode Zen on boot, falling back to a hardcoded free list when offline.
- **Stable session affinity:** `x-opencode-session` is derived deterministically from the conversation anchor, enabling KV-cache reuse; `x-opencode-request` is unique per request.
- **Pure pass-through:** `messages`, `systemPrompt`, and `tools` are never mutated.
- **Native streaming:** text, reasoning deltas, and tool calls are parsed and pushed into Pi's `AssistantMessageEventStream` in real time.
