import { TelegramClient } from "@mtcute/bun";
import { loadConfig } from "../config/env";
import { MAX_CHAT_HISTORY } from "../config/constants";
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
  const limit = Math.min(options.limit ?? MAX_CHAT_HISTORY, MAX_CHAT_HISTORY);
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

  // Batch dedup: check which message IDs already exist
  const existingIds = await chatHistoryRepo.checkExistsBatch(
    chatId,
    messages.map((m) => m.id),
  );

  // Import to database (INSERT OR REPLACE handles edits)
  let imported = 0;
  let skipped = 0;

  for (const msg of messages) {
    try {
      if (existingIds.has(msg.id)) {
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

export async function getUserGroups(): Promise<Array<{ id: number; title: string }>> {
  const client = getClient();
  await client.start();

  const result = await client.call({
    _: "messages.getDialogs",
    limit: 100,
    offsetDate: 0,
    offsetId: 0,
    offsetPeer: { _: "inputPeerEmpty" },
    hash: 0 as any,
  });

  const dialogs = (result as any).dialogs || [];
  const chats = (result as any).chats || [];
  const chatMap = new Map<number, string>();

  for (const chat of chats) {
    if (chat._ === "chat" || chat._ === "channel") {
      chatMap.set(chat.id, chat.title || "Unknown");
    }
  }

  const groups: Array<{ id: number; title: string }> = [];
  for (const dialog of dialogs) {
    const peer = dialog.peer;
    let chatId: number | null = null;

    if (peer?._ === "peerChat") {
      chatId = peer.chatId;
    } else if (peer?._ === "peerChannel") {
      chatId = peer.channelId;
    }

    if (chatId && chatMap.has(chatId)) {
      groups.push({ id: chatId, title: chatMap.get(chatId)! });
    }
  }

  return groups;
}

export async function startRealtimeSync(
  chatHistoryRepo: ChatHistoryRepository,
): Promise<() => void> {
  const client = getClient();
  await client.start();

  // Listen for new messages via MTProto updates
  const handler = async (update: unknown) => {
    const u = update as Record<string, unknown>;
    if (u._ !== "updateNewChannelMessage" && u._ !== "updateNewMessage") return;

    const msg = u.message as Record<string, unknown> | undefined;
    if (!msg || msg._ !== "message") return;

    const peerId = msg.peerId as Record<string, unknown> | undefined;
    const chatId = (peerId?.channelId ?? peerId?.chatId ?? peerId?.userId) as number | undefined;
    if (!chatId) return;

    const msgId = msg.id as number;

    // Check if already exists (fast dedup)
    const exists = await chatHistoryRepo.checkExists(chatId, msgId);
    if (exists) return;

    const fromId = msg.fromId as Record<string, unknown> | undefined;
    const replyTo = msg.replyTo as Record<string, unknown> | undefined;
    const fwdFrom = msg.fwdFrom as Record<string, unknown> | undefined;

    // Save new message
    await chatHistoryRepo.save({
      chatId,
      messageId: msgId,
      userId: (fromId?.userId ?? fromId?.channelId ?? 0) as number,
      userName: fromId ? String(fromId.userId || fromId.channelId) : null,
      role: "user",
      content: (msg.message as string) || "[Media/Empty]",
      replyToMessageId: (replyTo?.replyToMsgId as number) || null,
      forwardFromName: fwdFrom ? String(fwdFrom.fromId || "Forwarded") : null,
    });

    console.log(`[MTProto] Synced message ${msgId} from chat ${chatId}`);
  };

  // mtcute uses event emitter pattern for updates
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).onUpdate?.(handler) || (client as any).updates?.on?.("raw", handler);

  return () => {
    // mtcute cleanup if available
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).updates?.off?.("raw", handler);
  };
}

export async function isMtProtoConfigured(): Promise<boolean> {
  return !!(config.MTPROTO_API_ID && config.MTPROTO_API_HASH);
}
