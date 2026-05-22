import { TelegramClient } from "@mtcute/bun";
import { loadConfig } from "../config/env";
import type { ChatHistoryRepository } from "../db/repositories/chat-history";

const config = loadConfig();

let _client: TelegramClient | null = null;

function getClient(): TelegramClient {
  if (!_client) {
    const apiId = config.MTPROTO_API_ID;
    const apiHash = config.MTPROTO_API_HASH;

    if (!apiId || !apiHash) {
      throw new Error("MTProto not configured. Set MTPROTO_API_ID and MTPROTO_API_HASH in .env");
    }

    _client = new TelegramClient({
      apiId,
      apiHash,
      storage: "data/mtcute-session",
    });
  }
  return _client;
}

export async function importChatHistory(
  chatHistoryRepo: ChatHistoryRepository,
  chatId: number,
  options: { limit?: number; offsetDate?: Date } = {},
): Promise<{ imported: number; skipped: number }> {
  const client = getClient();

  // Start client (uses saved session if available)
  await client.start();

  // Resolve peer from chat ID
  const peer = await client.resolvePeer(chatId);

  // Fetch messages
  const limit = Math.min(options.limit ?? 1000, 10000);
  const messages: any[] = [];
  let offsetId = 0;

  while (messages.length < limit) {
    const batch = await client.call({
      _: "messages.getHistory",
      peer,
      limit: Math.min(100, limit - messages.length),
      offsetId,
      offsetDate: 0,
      addOffset: 0,
      maxId: 0,
      minId: 0,
      hash: 0 as any,
    });

    const batchMessages = (batch as any).messages || [];
    if (batchMessages.length === 0) break;

    for (const msg of batchMessages) {
      if (msg._ === "message") {
        messages.push(msg);
        offsetId = msg.id;
      }
    }

    if (batchMessages.length < 100) break;
  }

  // Import to database
  let imported = 0;
  let skipped = 0;

  for (const msg of messages) {
    try {
      // Check if message already exists
      const existing = await chatHistoryRepo.getRecent(chatId, 1);
      if (existing.some((m) => m.messageId === msg.id)) {
        skipped++;
        continue;
      }

      await chatHistoryRepo.save({
        chatId,
        messageId: msg.id,
        userId: msg.fromId?.userId ?? msg.fromId?.channelId ?? 0,
        userName: msg.fromId ? String(msg.fromId.userId || msg.fromId.channelId) : null,
        role: "user",
        content: msg.message || "[Media/Empty]",
        replyToMessageId: msg.replyTo?.replyToMsgId || null,
        forwardFromName: msg.fwdFrom ? String(msg.fwdFrom.fromId || "Forwarded") : null,
      });
      imported++;
    } catch {
      skipped++;
    }
  }

  return { imported, skipped };
}

export async function isMtProtoConfigured(): Promise<boolean> {
  return !!(config.MTPROTO_API_ID && config.MTPROTO_API_HASH);
}
