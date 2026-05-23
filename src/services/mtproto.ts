import { TelegramClient } from "@mtcute/bun";
import { loadConfig } from "../config/env";
import { MAX_CHAT_HISTORY } from "../config/constants";
import type { ChatHistoryRepository } from "../db/repositories/chat-history";

let _client: TelegramClient | null = null;

function getClient(): TelegramClient {
  if (!_client) {
    const config = loadConfig();
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract FLOOD_WAIT seconds from mtcute RpcError if present. */
function getFloodWaitSeconds(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const e = err as any;
    // mtcute v0.10: text is "FLOOD_WAIT_%d", actual seconds in .seconds
    if (e.seconds !== undefined && typeof e.seconds === "number") {
      return e.seconds;
    }
    // Fallback: older versions may have FLOOD_WAIT_N in text
    const text = e.text;
    if (typeof text === "string" && text.startsWith("FLOOD_WAIT_")) {
      const seconds = Number.parseInt(text.replace("FLOOD_WAIT_", ""), 10);
      if (!Number.isNaN(seconds)) return seconds;
    }
  }
  return undefined;
}

/** Check if the bot has access to a chat by trying to fetch 1 message.
 * Returns true if the bot is a member (or admin), false otherwise.
 */
/** Check if the bot is a member of a chat via Bot API getChatMember.
 * Uses the bot's own token, not the user's MTProto session.
 */
export async function canAccessChat(
  chatId: number,
  type: "group" | "channel",
  botToken: string,
): Promise<boolean> {
  const botApiChatId = type === "channel" ? -1000000000000 - chatId : -chatId;
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getChat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: botApiChatId }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function importChatHistory(
  chatHistoryRepo: ChatHistoryRepository,
  chatId: number,
  options: {
    limit?: number;
    offsetDate?: Date;
    type?: "group" | "channel";
    accessHash?: unknown;
  } = {},
): Promise<{ imported: number; skipped: number }> {
  const client = getClient();

  // Start client (uses saved session if available)
  await client.start();

  // Normalize chatId to Bot API format so DB queries work consistently
  const dbChatId = options.type === "channel" ? -1000000000000 - chatId : -chatId;

  // Build peer directly from known type + access_hash (avoids resolvePeer cache issues).
  // Fallback to resolvePeer if accessHash not provided (e.g. my_chat_member events).
  let peer;
  if (options.type === "channel" && options.accessHash) {
    // mtcute runtime accepts bigint for Long fields; cast to suppress TS strictness
    peer = {
      _: "inputPeerChannel" as const,
      channelId: chatId,
      accessHash: options.accessHash,
    } as any;
    console.log(
      `[mtproto] importChatHistory using inputPeerChannel channelId=${chatId} accessHash=${options.accessHash}`,
    );
  } else if (options.type === "group") {
    peer = { _: "inputPeerChat" as const, chatId };
    console.log(`[mtproto] importChatHistory using inputPeerChat chatId=${chatId}`);
  } else {
    console.log(`[mtproto] importChatHistory falling back to resolvePeer for chatId=${chatId}`);
    peer = await client.resolvePeer(chatId, true);
  }

  // Fetch messages
  const limit = Math.min(options.limit ?? MAX_CHAT_HISTORY, MAX_CHAT_HISTORY);
  const messages: any[] = [];
  const userMap = new Map<number, { username?: string; firstName?: string; lastName?: string }>();
  let offsetId = 0;

  while (messages.length < limit) {
    let batch: unknown;
    try {
      batch = await client.call({
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
    } catch (err) {
      const floodWait = getFloodWaitSeconds(err);
      if (floodWait !== undefined) {
        console.warn(`[mtproto] FLOOD_WAIT_${floodWait} for chat ${chatId}, sleeping...`);
        await sleep(floodWait * 1000 + 1000); // +1s buffer
        continue; // retry same batch
      }
      throw err;
    }

    const batchMessages = (batch as any).messages || [];
    const batchUsers = (batch as any).users || [];
    console.log(
      `[mtproto] getHistory returned ${batchMessages.length} messages, ${batchUsers.length} users for chat ${chatId}`,
    );
    if (batchMessages.length === 0) break;

    // Collect user info from the response
    for (const u of batchUsers) {
      if (u._ === "user" && u.id) {
        userMap.set(Number(u.id), {
          username: u.username,
          firstName: u.firstName,
          lastName: u.lastName,
        });
      }
    }

    for (const msg of batchMessages) {
      if (msg._ === "message") {
        messages.push(msg);
        offsetId = msg.id;
      }
    }

    if (batchMessages.length < 100) break;

    // Delay between batches to avoid rate limiting
    await sleep(2000);
  }

  // Batch dedup: check which message IDs already exist (convert Long objects to Number)
  const existingIds = await chatHistoryRepo.checkExistsBatch(
    dbChatId,
    messages.map((m) => Number(m.id)),
  );

  // Build user ID → display name from userMap collected during getHistory
  // Format: "Имя @ник" when both available, "@ник" when only username, "Имя" when only name
  const userNameMap = new Map<number, string>();
  for (const [uid, info] of userMap) {
    let name: string | null = null;
    const displayName = info.firstName
      ? `${info.firstName}${info.lastName ? ` ${info.lastName}` : ""}`
      : null;
    if (displayName && info.username) {
      name = `${displayName} @${info.username}`;
    } else if (info.username) {
      name = `@${info.username}`;
    } else if (displayName) {
      name = displayName;
    }
    if (name) userNameMap.set(uid, name);
  }
  console.log(`[mtproto] Built ${userNameMap.size} user names from getHistory response`);

  // Import to database — INSERT new, UPDATE existing with resolved names
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  for (const msg of messages) {
    try {
      const messageId = Number(msg.id);
      const fromId = msg.fromId;
      const userId = fromId?.userId
        ? Number(fromId.userId)
        : fromId?.channelId
          ? Number(fromId.channelId)
          : 0;
      const resolvedName = fromId?.userId ? userNameMap.get(Number(fromId.userId)) : null;
      const userName = resolvedName ?? (fromId ? String(fromId.userId || fromId.channelId) : null);

      if (existingIds.has(messageId)) {
        // Update existing record if we now have a better name
        if (resolvedName) {
          await chatHistoryRepo.save({
            chatId: dbChatId,
            messageId,
            userId,
            userName: resolvedName,
            role: "user",
            content: msg.message || "[Media/Empty]",
            replyToMessageId: msg.replyTo?.replyToMsgId ? Number(msg.replyTo.replyToMsgId) : null,
            forwardFromName: msg.fwdFrom ? String(msg.fwdFrom.fromId || "Forwarded") : null,
          });
          updated++;
          continue;
        }
        skipped++;
        continue;
      }

      await chatHistoryRepo.save({
        chatId: dbChatId,
        messageId,
        userId,
        userName,
        role: "user",
        content: msg.message || "[Media/Empty]",
        replyToMessageId: msg.replyTo?.replyToMsgId ? Number(msg.replyTo.replyToMsgId) : null,
        forwardFromName: msg.fwdFrom ? String(msg.fwdFrom.fromId || "Forwarded") : null,
      });
      imported++;
    } catch (err) {
      console.error(`[mtproto] Failed to save message ${msg.id}:`, err);
      skipped++;
    }
  }

  console.log(
    `[mtproto] importChatHistory done: mtprotoChatId=${chatId}, dbChatId=${dbChatId}, totalFetched=${messages.length}, imported=${imported}, updated=${updated}, skipped=${skipped}, existingInDb=${existingIds.size}`,
  );
  return { imported, skipped };
}

export async function getUserGroups(): Promise<
  Array<{ id: number; title: string; type: "group" | "channel" }>
> {
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
  const chatMap = new Map<number, { title: string; type: "group" | "channel" }>();

  for (const chat of chats) {
    if (chat._ === "chat") {
      chatMap.set(chat.id, { title: chat.title || "Unknown", type: "group" });
    } else if (chat._ === "channel") {
      chatMap.set(chat.id, { title: chat.title || "Unknown", type: "channel" });
    }
  }

  const groups: Array<{
    id: number;
    title: string;
    type: "group" | "channel";
  }> = [];
  for (const dialog of dialogs) {
    const peer = dialog.peer;
    let chatId: number | null = null;

    if (peer?._ === "peerChat") {
      chatId = peer.chatId;
    } else if (peer?._ === "peerChannel") {
      chatId = peer.channelId;
    }

    if (chatId) {
      const info = chatMap.get(chatId);
      if (info) {
        groups.push({ id: chatId, title: info.title, type: info.type });
      }
    }
  }

  return groups;
}

/** Get groups where both the user AND the bot are members.
 * Uses MTProto messages.getCommonChats — same as "Common Groups" in Telegram app.
 */
export async function getCommonGroups(
  botUsername: string,
): Promise<Array<{ id: number; title: string; type: "group" | "channel"; accessHash?: unknown }>> {
  const client = getClient();
  await client.start();

  // Resolve bot username to get user_id + access_hash
  const resolved = await client.call({
    _: "contacts.resolveUsername",
    username: botUsername,
  });

  const users = (resolved as any).users || [];
  const botUser = users.find((u: any) => u._ === "user" && u.bot);
  if (!botUser) {
    console.warn("[mtproto] Could not resolve bot username:", botUsername);
    return [];
  }

  const inputUser = {
    _: "inputUser" as const,
    userId: botUser.id,
    accessHash: botUser.accessHash ?? botUser.access_hash,
  };

  // Get common chats (groups where both user and bot are members)
  const result = await client.call({
    _: "messages.getCommonChats" as const,
    userId: inputUser,
    limit: 100,
    maxId: 0,
  });

  const chats = (result as any).chats || [];
  const groups: Array<{
    id: number;
    title: string;
    type: "group" | "channel";
    accessHash?: bigint;
  }> = [];

  for (const chat of chats) {
    if (chat._ === "chat") {
      groups.push({ id: chat.id, title: chat.title || "Unknown", type: "group" });
    } else if (chat._ === "channel") {
      const ah = chat.accessHash ?? chat.access_hash;
      console.log(
        `[mtproto] getCommonChats channel: id=${chat.id}, title=${chat.title}, ah=${ah}, typeof=${typeof ah}`,
      );
      groups.push({
        id: chat.id,
        title: chat.title || "Unknown",
        type: "channel",
        // mtcute returns Long objects; pass through as-is (runtime handles them)
        accessHash: ah,
      });
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
    const rawChatId = (peerId?.channelId ?? peerId?.chatId ?? peerId?.userId) as number | undefined;
    if (!rawChatId) return;

    const isChannel = peerId?.channelId !== undefined;
    const dbChatId = isChannel ? -1000000000000 - Number(rawChatId) : -Number(rawChatId);
    const msgId = msg.id as number;

    // Check if already exists (fast dedup)
    const exists = await chatHistoryRepo.checkExists(dbChatId, msgId);
    if (exists) return;

    const fromId = msg.fromId as Record<string, unknown> | undefined;
    const replyTo = msg.replyTo as Record<string, unknown> | undefined;
    const fwdFrom = msg.fwdFrom as Record<string, unknown> | undefined;

    // Save new message
    await chatHistoryRepo.save({
      chatId: dbChatId,
      messageId: msgId,
      userId: (fromId?.userId ?? fromId?.channelId ?? 0) as number,
      userName: fromId ? String(fromId.userId || fromId.channelId) : null,
      role: "user",
      content: (msg.message as string) || "[Media/Empty]",
      replyToMessageId: (replyTo?.replyToMsgId as number) || null,
      forwardFromName: fwdFrom ? String(fwdFrom.fromId || "Forwarded") : null,
    });

    console.log(`[MTProto] Synced message ${msgId} from chat ${rawChatId} (dbChatId=${dbChatId})`);
  };

  // mtcute uses event emitter pattern for updates
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = client as any;
  if (c.onUpdate) {
    c.onUpdate(handler);
  } else if (c.updates?.on) {
    c.updates.on("raw", handler);
  }

  return () => {
    // mtcute cleanup if available
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).updates?.off?.("raw", handler);
  };
}

export async function isMtProtoConfigured(): Promise<boolean> {
  const config = loadConfig();
  return !!(config.MTPROTO_API_ID && config.MTPROTO_API_HASH);
}
