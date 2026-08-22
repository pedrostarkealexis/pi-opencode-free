# pi-opencode-free

Native Pi extension connecting directly to OpenCode Zen API using Pi's built-in `openai-completions` engine with dynamic free model discovery, OpenCode client headers, and native streaming.

## Architecture

Registers a lightweight provider in Pi using `ExtensionAPI.registerProvider` configured with `api: "openai-completions"`. Free models are discovered on boot from OpenCode Zen, and OpenCode client headers (`x-opencode-client`, `x-opencode-project`, `User-Agent`) are injected to authorize free tier usage. All SSE streaming, reasoning parsing, and tool calls are handled natively by Pi.

## Structure

| File | Purpose |
|------|---------|
| `src/discovery.ts` | `discoverModels()` — fetch `https://opencode.ai/zen/v1/models` with offline `FALLBACK_MODELS` |
| `src/index.ts` | Extension entrypoint registering the native `opencode-direct` provider + `/opencode-sync` command |
| `scripts/smoke-real.ts` | Real-scenario smoke test against the live Zen API (`bun scripts/smoke-real.ts`) |

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
- **OpenCode client headers:** `x-opencode-client`, `x-opencode-project`, and `User-Agent` are sent on every request to authorize free tier usage.
- **Keyless auth shim:** the Zen free tier is anonymous — any Bearer token gets 401. A thin `streamSimple` wrapper delegates to Pi's native engine but omits the `Authorization` header (the OpenAI SDK's supported null-omission); no streaming logic is custom.
- **Pure pass-through:** `messages`, `systemPrompt`, and `tools` are never mutated; SSE streaming, reasoning replay, tool accumulation, and cost calculations are delegated entirely to Pi's native engine.
- **Zero custom transport:** no manual SSE parsing, session hashing, or buffers — the provider is fully declarative.
