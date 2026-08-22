import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import opencodeDirectExtension from "./index.js";
import { discoverModels, FALLBACK_MODELS } from "./discovery.js";

function hermeticFetch(): typeof fetch {
  return (async () => ({
    ok: true,
    json: async () => ({ data: [{ id: "hy3-free", name: "Hy3" }] }),
  }) as Response) as typeof fetch;
}

test("opencodeDirectExtension registers native openai-completions provider with opencode headers", async () => {
  // Hermetic fetch stub: static /models catalog (discovery does not probe).
  const originalFetch = globalThis.fetch;
  globalThis.fetch = hermeticFetch();

  try {
    let registeredId = "";
    let registeredConfig: any = null;

    const fakePi = {
      registerProvider(id: string, config: any) {
        registeredId = id;
        registeredConfig = config;
      },
      registerCommand() {},
    } as unknown as ExtensionAPI;

    await opencodeDirectExtension(fakePi);

    assert.equal(registeredId, "opencode-free");
    assert.equal(registeredConfig.name, "OpenCode Direct (Free)");
    assert.equal(registeredConfig.api, "openai-completions");
    assert.equal(registeredConfig.baseUrl, "https://opencode.ai/zen/v1");
    assert.equal(registeredConfig.apiKey, "none");
    assert.equal(registeredConfig.headers["x-opencode-client"], "cli");
    assert.equal(registeredConfig.headers["x-opencode-project"], "global");
    assert.ok(registeredConfig.models.length > 0);
    assert.equal(registeredConfig.models[0].compat.supportsStore, false);
    // Thin keyless shim over the native engine (delegation itself is verified
    // end-to-end against the live API by scripts/smoke-real.ts).
    assert.equal(typeof registeredConfig.streamSimple, "function");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("module exports are defined and functions", () => {
  assert.equal(typeof opencodeDirectExtension, "function");
  assert.equal(typeof discoverModels, "function");
  assert.ok(Array.isArray(FALLBACK_MODELS));
});

test("package.json is configured for public release and distribution", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.private, undefined, "package must not be private");
  assert.equal(pkg.license, "GPL-3.0-or-later");
  assert.deepEqual(pkg.pi?.extensions, ["./dist/index.js"]);
  assert.ok(pkg.files?.includes("dist"));
  assert.ok(pkg.scripts?.prepack);
});

test("/opencode-sync re-registers the provider with a refreshed model list", async () => {
  const originalFetch = globalThis.fetch;
  let catalog = { data: [{ id: "hy3-free", name: "Hy3" }] };
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("/chat/completions")) return { ok: true } as Response;
    return { ok: true, json: async () => catalog } as Response;
  }) as typeof fetch;

  try {
    let registrationCount = 0;
    let lastModels: any[] = [];
    let syncHandler: ((args: string, ctx: any) => Promise<void>) | undefined;

    const fakePi = {
      registerProvider(_id: string, config: any) {
        registrationCount++;
        lastModels = config.models;
      },
      registerCommand(_name: string, cmd: any) {
        syncHandler = cmd.handler;
      },
    } as unknown as ExtensionAPI;

    await opencodeDirectExtension(fakePi);
    assert.equal(registrationCount, 1); // initial load
    assert.equal(lastModels.length, 1);

    // Endpoint now lists one more model; running the command must apply it.
    catalog = { data: [{ id: "hy3-free", name: "Hy3" }, { id: "laguna-s-2.1-free", name: "Laguna" }] };
    assert.ok(syncHandler, "sync command was not registered");
    let notified = "";
    await syncHandler!("", { ui: { notify: (msg: string) => { notified = msg; } } });

    assert.equal(registrationCount, 2); // provider re-registered
    assert.deepEqual(lastModels.map((m: any) => m.id), ["hy3-free", "laguna-s-2.1-free"]);
    assert.match(notified, /synchronized 2 free models/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
