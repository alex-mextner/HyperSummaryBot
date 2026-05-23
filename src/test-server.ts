import { aiStreamRound } from "./services/ai/streaming";
import { generateSummary } from "./agents/summary";
import { loadConfig } from "./config/env";
import { initDatabase } from "./db/client";
import { ChatHistoryRepository } from "./db/repositories/chat-history";
const config = loadConfig();

/** Start a lightweight HTTP test server alongside the bot.
 *  Endpoints:
 *   GET  /test/health          — ping
 *   POST /test/summary         — test summary generation with provided messages
 *   POST /test/ai              — direct AI streaming call
 *   POST /test/import          — trigger MTProto import for a chat
 *
 *  All endpoints require X-Test-Password header matching TEST_API_PASSWORD.
 */
export function startTestServer(): any | null {
  if (!config.TEST_API_PASSWORD) {
    console.log("[test-api] TEST_API_PASSWORD not set, test server disabled");
    return null;
  }

  const db = initDatabase(config.DATABASE_PATH);
  const chatHistory = new ChatHistoryRepository(db);

  const server = Bun.serve({
    port: Number(process.env.TEST_API_PORT || 3001),
    async fetch(req) {
      const url = new URL(req.url);
      const password = req.headers.get("x-test-password");

      // Public health check (no password)
      if (url.pathname === "/test/health") {
        return jsonResponse({ ok: true, env: config.NODE_ENV, time: new Date().toISOString() });
      }

      // All other test endpoints require password
      if (password !== config.TEST_API_PASSWORD) {
        return jsonResponse({ error: "Unauthorized — set X-Test-Password header" }, 401);
      }

      try {
        if (url.pathname === "/test/summary" && req.method === "POST") {
          return await handleTestSummary(req, chatHistory);
        }

        if (url.pathname === "/test/ai" && req.method === "POST") {
          return await handleTestAI(req);
        }

        if (url.pathname === "/test/import" && req.method === "POST") {
          return await handleTestImport(req, chatHistory);
        }

        return jsonResponse({ error: "Not found" }, 404);
      } catch (err) {
        console.error("[test-api] endpoint error:", err);
        return jsonResponse(
          { error: "Internal error", detail: err instanceof Error ? err.message : String(err) },
          500,
        );
      }
    },
  });

  console.log(`[test-api] Test server running on http://localhost:${server.port}`);
  return server;
}

async function handleTestSummary(req: Request, chatHistory: ChatHistoryRepository) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const chatId = Number(body.chatId || -1003848286052);
  const limit = Number(body.limit || 99999);

  const messages = await chatHistory.getRecent(chatId, limit);

  if (messages.length === 0) {
    return jsonResponse({ error: "No messages found for this chatId", chatId }, 404);
  }

  const startTime = Date.now();

  try {
    const result = await generateSummary({
      chatId,
      messages: messages.map((m) => ({
        userId: m.userId,
        userName: m.userName,
        content: m.content,
      })),
      bot: { api: { sendMessage: async () => ({ message_id: 1 }) } } as any,
    });

    return jsonResponse({
      ok: true,
      chatId,
      messageCount: messages.length,
      durationMs: Date.now() - startTime,
      textLength: result.length,
      preview: result.slice(0, 500) + (result.length > 500 ? "…" : ""),
      fullText: result,
    });
  } catch (err) {
    return jsonResponse(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
        messageCount: messages.length,
      },
      502,
    );
  }
}

async function handleTestAI(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const prompt = (body.prompt as string) || "Say hello";
  const maxTokens = Number(body.maxTokens || 500);

  const chunks: string[] = [];
  const startTime = Date.now();

  try {
    await aiStreamRound(
      {
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: prompt },
        ],
        maxTokens,
        temperature: 0.7,
      },
      {
        onTextDelta: (text) => chunks.push(text),
      },
    );

    const fullText = chunks.join("");
    return jsonResponse({
      ok: true,
      prompt,
      durationMs: Date.now() - startTime,
      textLength: fullText.length,
      preview: fullText.slice(0, 500) + (fullText.length > 500 ? "…" : ""),
      fullText,
    });
  } catch (err) {
    return jsonResponse(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
        chunksReceived: chunks.length,
      },
      502,
    );
  }
}

async function handleTestImport(req: Request, chatHistory: ChatHistoryRepository) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const chatId = Number(body.chatId || 3848286052);
  const type = (body.type as string) || "channel";

  const startTime = Date.now();

  try {
    const { importChatHistory } = await import("./services/mtproto");
    const result = await importChatHistory(chatHistory, chatId, {
      limit: 99999,
      type: type as "group" | "channel",
    });

    return jsonResponse({
      ok: true,
      chatId,
      type,
      durationMs: Date.now() - startTime,
      imported: result.imported,
      skipped: result.skipped,
    });
  } catch (err) {
    return jsonResponse(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      },
      502,
    );
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
