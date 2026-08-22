import { createHash } from "node:crypto";

export function createSessionHeaders(messages: unknown[]): Record<string, string> {
  const anchor = JSON.stringify(messages.slice(0, 2));
  const sessionHash = createHash("sha1").update(anchor || "default_session").digest("hex").slice(0, 24);
  const requestHash = createHash("sha1").update(String(Math.random()) + Date.now()).digest("hex").slice(0, 24);

  return {
    "Content-Type": "application/json",
    "x-opencode-project": "global",
    "x-opencode-client": "cli",
    "User-Agent": "opencode/0.0.0-dev",
    "x-opencode-session": `ses_direct_${sessionHash}`,
    "x-opencode-request": `msg_${requestHash}`,
  };
}