import { execFileSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config/env";

interface WebhookBot {
  updates: { handleUpdate(update: unknown): Promise<unknown> };
}
const MAX_WEBHOOK_BYTES = 256 * 1024;

/** Authenticate the transport before trusting Telegram numeric sender IDs.
 * Durable acceptance/recovery is a separate tracked change (#4). */
export function startWebhookServer(bot: WebhookBot): ReturnType<typeof Bun.serve> {
  const config = loadConfig();
  const secret = config.WEBHOOK_SECRET;
  if (!secret || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
    throw new Error("WEBHOOK_SECRET must contain 16–256 URL-safe characters");
  }
  const expectedSecret = Buffer.from(secret);
  const webhookPath = config.WEBHOOK_URL
    ? new URL(config.WEBHOOK_URL).pathname || "/webhook"
    : "/webhook";
  let buildSha = "unknown";
  try {
    buildSha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Missing VCS metadata must not be misrepresented as a verified version.
    console.warn("[webhook] build identity unavailable");
  }
  const server = Bun.serve({
    port: config.TEST_API_PORT,
    maxRequestBodySize: MAX_WEBHOOK_BYTES,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return jsonResponse({ status: "alive", buildSha, authenticatedWebhook: true });
      }
      if (req.method !== "POST" || url.pathname !== webhookPath)
        return jsonResponse({ error: "Not found" }, 404);
      const supplied = Buffer.from(req.headers.get("x-telegram-bot-api-secret-token") ?? "");
      if (supplied.length !== expectedSecret.length || !timingSafeEqual(supplied, expectedSecret))
        return jsonResponse({ error: "Unauthorized" }, 401);
      try {
        const raw = await req.arrayBuffer();
        if (raw.byteLength > MAX_WEBHOOK_BYTES)
          return jsonResponse({ error: "Request too large" }, 413);
        const body: unknown = JSON.parse(new TextDecoder().decode(raw));
        if (
          typeof body !== "object" ||
          body === null ||
          !("update_id" in body) ||
          !Number.isSafeInteger(body.update_id) ||
          typeof body.update_id !== "number" ||
          body.update_id < 0
        ) {
          return jsonResponse({ error: "Bad update" }, 400);
        }
        // No payloads or Telegram credentials are included in failure logs.
        void bot.updates
          .handleUpdate(body)
          .catch(() => console.error("[webhook] update processing failed"));
        return jsonResponse({ ok: true });
      } catch {
        return jsonResponse({ error: "Bad request" }, 400);
      }
    },
  });
  console.log(`[webhook] authenticated listener on port ${server.port}`);
  return server;
}
function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
