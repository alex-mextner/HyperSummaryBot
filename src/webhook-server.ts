/* eslint-disable @typescript-eslint/no-explicit-any */
import { loadConfig } from "./config/env";

/** Start a minimal Bun HTTP server for receiving Telegram webhook updates.
 *  Verifies secret token if configured. */
export function startWebhookServer(bot: any): ReturnType<typeof Bun.serve> {
  const config = loadConfig();
  const port = config.TEST_API_PORT;

  // Extract webhook path from URL (e.g. https://domain.com/webhook → /webhook)
  let webhookPath = "/webhook";
  if (config.WEBHOOK_URL) {
    try {
      const url = new URL(config.WEBHOOK_URL);
      webhookPath = url.pathname || "/webhook";
    } catch {
      // Invalid URL, fallback to /webhook
    }
  }

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "POST" && url.pathname === webhookPath) {
        // Verify secret token if configured
        if (config.WEBHOOK_SECRET) {
          const secret = req.headers.get("x-telegram-bot-api-secret-token");
          if (secret !== config.WEBHOOK_SECRET) {
            return jsonResponse({ error: "Unauthorized" }, 401);
          }
        }

        try {
          const body = await req.json();
          // Handle update asynchronously — respond 200 immediately so Telegram
          // doesn't retry while we process long-running handlers (summary, etc.)
          void (async () => {
            try {
              await bot.updates.handleUpdate(body);
            } catch (err) {
              console.error("[webhook] Failed to handle update:", err);
            }
          })();
          return jsonResponse({ ok: true });
        } catch (err) {
          console.error("[webhook] Failed to parse request:", err);
          return jsonResponse({ error: "Bad request" }, 400);
        }
      }

      return jsonResponse({ error: "Not found" }, 404);
    },
  });

  console.log(`[webhook] Server listening on port ${port}, webhook path: ${webhookPath}`);
  return server;
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
