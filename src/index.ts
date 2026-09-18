import { Bot } from "gramio";
import { session } from "@gramio/session";
import { sqliteStorage } from "@gramio/storage-sqlite";
import { loadConfig } from "./config/env";
import { sourceDate } from "./utils/source-metadata";
import { MAX_CHAT_HISTORY } from "./config/constants";
import { initDatabase } from "./db/client";
import { assertDatabaseReady } from "./db/migrations";
import { ChatHistoryRepository } from "./db/repositories/chat-history";
import { generateSummary } from "./agents/summary";
import { extractNote } from "./agents/note-extractor";
import {
  buildMessageContent,
  buildForwardFromNameForDb,
  parseSearchQuery,
  parseAskQuestion,
} from "./bot/message-processor";
import { resolveDMChat, toBotApiChatId } from "./bot/dm-chat-resolver";
import { deliverDmText, requireDmDelivery } from "./bot/dm-delivery";
import { DebtTracker } from "./services/debt-tracker";
import { createAccessPolicy } from "./security/access-policy";

const config = loadConfig();
const accessPolicy = createAccessPolicy({
  ownerUserId: config.BOT_ADMIN_ID,
  allowedChatIds: config.ALLOWED_CHAT_IDS,
});
const allowedChatIds = accessPolicy.allowedChatIds;

interface AccessContext {
  from?: { id: number };
  reply: (text: string) => Promise<unknown>;
}

async function requireOwner(ctx: AccessContext): Promise<boolean> {
  if (accessPolicy.isOwner(ctx.from?.id)) return true;
  await ctx.reply("⛔ Доступ ограничен.");
  return false;
}

async function requireAllowedSource(ctx: AccessContext, chatId: number): Promise<boolean> {
  if (accessPolicy.isAllowedChat(chatId)) return true;
  await ctx.reply("⛔ Доступ ограничен.");
  return false;
}
/** Universal command error wrapper: catches ANY error, logs it, replies to user.
 *  Generic — preserves GramIO derived context type so .chatHistory etc stay typed. */
function safeCommand<TContext extends { reply: (text: string) => Promise<unknown> }>(
  name: string,
  handler: (ctx: TContext) => Promise<void>,
): (ctx: TContext) => Promise<void> {
  return async (ctx) => {
    try {
      await handler(ctx);
    } catch (error) {
      console.error(`[command:${name}] Unhandled error:`, error);
      try {
        await ctx.reply("❌ Что-то пошло не так. Попробуй ещё раз или используй /help.");
      } catch (replyErr) {
        console.error(`[command:${name}] Failed to send error reply:`, replyErr);
      }
    }
  };
}

// Init database
const db = initDatabase(config.DATABASE_PATH);
assertDatabaseReady(db);
const chatHistory = new ChatHistoryRepository(db);
const debtTracker = new DebtTracker(db);

// Bot's own Telegram user ID — populated at startup, used to filter out bot messages
let botUserId = 0;

// Track chats where the bot is actually present — used to filter MTProto import
const knownGroupIds = new Set<number>();

async function loadKnownGroupIds(): Promise<void> {
  try {
    const ids = await chatHistory.getAllChatIds();
    for (const id of ids) {
      if (accessPolicy.isAllowedChat(id)) knownGroupIds.add(id);
    }
    console.log(
      `📋 Pre-loaded ${knownGroupIds.size} known chats from DB`,
      Array.from(knownGroupIds),
    );
  } catch {
    console.warn("📋 Failed to pre-load known chats from DB");
  }
}

/** One-time import on startup for already-connected MTProto accounts */
async function runInitialImport(): Promise<void> {
  if (!accessPolicy.isConfigured()) {
    console.warn("[startup] Initial import skipped: access policy is not configured");
    return;
  }
  try {
    const { getCommonGroups, importChatHistory } = await import("./services/mtproto");
    const groups = (await getCommonGroups(config.BOT_USERNAME)).filter((group) =>
      accessPolicy.isAllowedChat(toBotApiChatId(group.id, group.type)),
    );
    console.log(`[startup] Found ${groups.length} allowlisted common groups with bot`);

    for (const group of groups) {
      const sourceChatId = toBotApiChatId(group.id, group.type);
      knownGroupIds.add(sourceChatId);
      try {
        const result = await importChatHistory(chatHistory, group.id, {
          limit: MAX_CHAT_HISTORY,
          type: group.type,
          accessHash: group.accessHash,
          allowedChatIds,
        });
        console.log(
          `[startup] Imported ${result.imported} messages from ${group.title} (${group.id})`,
        );
      } catch (err) {
        console.error(`[startup] Failed to import ${group.title}:`, err);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (err) {
    console.warn("[startup] Initial import skipped (not authenticated yet):", err);
  }
}

// Create bot with derive for typed context
const bot = new Bot(config.BOT_TOKEN)
  .extend(
    session({
      key: "session",
      storage: sqliteStorage({
        filename: config.DATABASE_PATH,
      }),
      initial: () => ({}),
    }),
  )
  .derive(async () => ({
    chatHistory,
  }));

// Error handling
bot.onError(({ kind, error }) => {
  console.error(`Bot error (${kind}):`, error);
});

async function requireDmRecipient(ctx: {
  from?: { id: number };
  chat?: { type: string };
  reply: (text: string) => Promise<unknown>;
}): Promise<number | null> {
  const userId = ctx.from?.id;
  if (!userId) return null;
  return (await requireDmDelivery(bot, ctx, userId)) ? userId : null;
}

// Commands
bot.command(
  "start",
  safeCommand("start", async (ctx) => {
    await ctx.reply(
      `👋 Привет! Я <b>${config.BOT_USERNAME}</b> — бот для саммари групповых чатов.\n\n` +
        "📋 <b>Доступные команды:</b>\n" +
        "/summary — Саммари последних сообщений\n" +
        "/ask — Задать вопрос по истории чата (в ЛС)\n" +
        "/search — Поиск по истории\n" +
        "/note — Извлечь полезную заметку\n" +
        "/digest — Получить дайджест (в ЛС)\n" +
        "/help — Помощь",
      { parse_mode: "HTML" },
    );
  }),
);

bot.command(
  "help",
  safeCommand("help", async (ctx) => {
    await ctx.reply(
      "📖 <b>Помощь</b>\n\n" +
        "Я сохраняю историю чата и могу:\n" +
        "• 📊 Создавать саммари разных типов\n" +
        "• ❓ Отвечать на вопросы по истории\n" +
        "• 🔍 Искать по сообщениям\n" +
        "• 📝 Извлекать полезные заметки в Notion\n" +
        "• 🎙 Обрабатывать голосовые сообщения\n\n" +
        "Просто добавь меня в группу и используй команды!",
      { parse_mode: "HTML" },
    );
  }),
);

bot.command(
  "summary",
  safeCommand("summary", async (ctx) => {
    const chat = ctx.chat;
    if (!chat) return;
    if (!(await requireOwner(ctx))) return;

    let targetChatId: number;

    if (chat.type === "private") {
      const choice = await resolveDMChat(ctx, allowedChatIds);
      if (!choice) return;
      targetChatId = choice.chatId;
    } else if (chat.type === "group" || chat.type === "supergroup") {
      targetChatId = chat.id;
    } else {
      await ctx.reply("Команда работает в группах и личных сообщениях.");
      return;
    }
    if (!(await requireAllowedSource(ctx, targetChatId))) return;
    const recipientUserId = await requireDmRecipient(ctx);
    if (!recipientUserId) return;

    try {
      const allMessages = await ctx.chatHistory.getRecent(targetChatId, MAX_CHAT_HISTORY);

      // Filter out bot's own messages from analysis (old entries + current)
      const messages = allMessages.filter((m) => m.userId !== botUserId);

      if (messages.length === 0) {
        await deliverDmText(bot, ctx, recipientUserId, "Нет сообщений для анализа.");
        return;
      }

      await generateSummary({
        chatId: targetChatId,
        replyToChatId: recipientUserId,
        messages: messages.map((m) => ({
          userId: m.userId,
          userName: m.userName,
          content: m.content,
          messageId: m.messageId,
          sourceCreatedAt: m.sourceCreatedAt,
          sourceEditedAt: m.sourceEditedAt,
          replyToMessageId: m.replyToMessageId,
          threadId: m.threadId,
        })),
        bot,
        placeholderText: `📊 Анализирую ${messages.length} сообщений…`,
      });
    } catch (error) {
      console.error("Summary error:", error);
      const errMsg = error instanceof Error ? error.message : "";
      if (
        errMsg.includes("401") ||
        errMsg.includes("token") ||
        errMsg.includes("All AI providers failed")
      ) {
        await deliverDmText(
          bot,
          ctx,
          recipientUserId,
          "❌ AI-сервисы временно недоступны. Попробуй позже.",
        );
      } else {
        await deliverDmText(
          bot,
          ctx,
          recipientUserId,
          "❌ Ошибка при генерации саммари. Попробуй позже.",
        );
      }
    }
  }),
);

bot.command(
  "ask",
  safeCommand("ask", async (ctx) => {
    const chat = ctx.chat;
    if (!chat) return;
    if (!(await requireOwner(ctx))) return;

    const question = parseAskQuestion(ctx.text || "");
    if (!question.trim()) {
      await ctx.reply("❓ Задай вопрос: /ask <твой вопрос>");
      return;
    }

    let targetChatId: number;

    if (chat.type === "private") {
      const choice = await resolveDMChat(ctx, allowedChatIds);
      if (!choice) return;
      targetChatId = choice.chatId;
    } else if (chat.type === "group" || chat.type === "supergroup") {
      targetChatId = chat.id;
    } else {
      await ctx.reply("Команда работает в группах и личных сообщениях.");
      return;
    }
    if (!(await requireAllowedSource(ctx, targetChatId))) return;
    const recipientUserId = await requireDmRecipient(ctx);
    if (!recipientUserId) return;

    try {
      const messages = await ctx.chatHistory.getRecent(targetChatId, 100);

      if (messages.length === 0) {
        await deliverDmText(bot, ctx, recipientUserId, "Нет сообщений для анализа.");
        return;
      }

      if (
        !(await deliverDmText(
          bot,
          ctx,
          recipientUserId,
          `🔍 Вопрос: ${question}\n\nАнализирую ${messages.length} сообщений...`,
        ))
      ) {
        return;
      }

      // TODO: Implement QA agent with streaming
      await deliverDmText(
        bot,
        ctx,
        recipientUserId,
        `📋 Ответ:\n\n${question}\n\n(Агент в разработке)`,
      );
    } catch (error) {
      console.error("Ask error:", error);
      await deliverDmText(bot, ctx, recipientUserId, "❌ Ошибка при обработке вопроса.");
    }
  }),
);

bot.command(
  "search",
  safeCommand("search", async (ctx) => {
    const chat = ctx.chat;
    if (!chat) return;
    if (!(await requireOwner(ctx))) return;

    let targetChatId: number;

    if (chat.type === "private") {
      const choice = await resolveDMChat(ctx, allowedChatIds);
      if (!choice) return;
      targetChatId = choice.chatId;
    } else if (chat.type === "group" || chat.type === "supergroup") {
      targetChatId = chat.id;
    } else {
      await ctx.reply("Команда работает в группах и личных сообщениях.");
      return;
    }
    if (!(await requireAllowedSource(ctx, targetChatId))) return;

    const query = parseSearchQuery(ctx.text || "");
    if (!query.trim()) {
      await ctx.reply("🔍 Введи запрос: /search <текст>");
      return;
    }
    const recipientUserId = await requireDmRecipient(ctx);
    if (!recipientUserId) return;

    if (!(await deliverDmText(bot, ctx, recipientUserId, `🔍 Ищу: "${query}"...`))) return;

    try {
      const messages = await ctx.chatHistory.getRecent(targetChatId, 99999);
      const results = messages.filter((m) => m.content.toLowerCase().includes(query.toLowerCase()));

      if (results.length === 0) {
        await deliverDmText(bot, ctx, recipientUserId, "Ничего не найдено.");
        return;
      }

      const formatted = results
        .slice(0, 20)
        .map((m) => `${m.userName}: ${m.content.slice(0, 200)}`)
        .join("\n\n");

      await deliverDmText(
        bot,
        ctx,
        recipientUserId,
        `🔍 Результаты (${results.length}):\n\n${formatted}`,
      );
    } catch (error) {
      console.error("Search error:", error);
      await deliverDmText(bot, ctx, recipientUserId, "❌ Ошибка при поиске.");
    }
  }),
);

bot.command(
  "note",
  safeCommand("note", async (ctx) => {
    const chat = ctx.chat;
    if (!chat) return;
    if (!(await requireOwner(ctx))) return;

    const { isNotionConfigured } = await import("./services/notion");
    if (!isNotionConfigured()) {
      await ctx.reply(
        "📝 Notion не настроен.\n\n" + "Администратор должен добавить NOTION_TOKEN в .env",
      );
      return;
    }

    const session = ctx.session as Record<string, unknown>;
    const notionDbId = session.notionDatabaseId as string | undefined;
    if (!notionDbId) {
      await ctx.reply(
        "📝 Не выбрана база Notion.\n\n" +
          "Используй /connect_notion, чтобы выбрать или создать базу для заметок.",
      );
      return;
    }

    let targetChatId: number;

    if (chat.type === "private") {
      const choice = await resolveDMChat(ctx, allowedChatIds);
      if (!choice) return;
      targetChatId = choice.chatId;
    } else if (chat.type === "group" || chat.type === "supergroup") {
      targetChatId = chat.id;
    } else {
      await ctx.reply("Команда работает в группах и личных сообщениях.");
      return;
    }
    if (!(await requireAllowedSource(ctx, targetChatId))) return;
    const recipientUserId = await requireDmRecipient(ctx);
    if (!recipientUserId) return;

    if (
      !(await deliverDmText(
        bot,
        ctx,
        recipientUserId,
        "📝 Анализирую сообщения и извлекаю заметку…",
      ))
    ) {
      return;
    }

    try {
      const messages = await ctx.chatHistory.getRecent(targetChatId, MAX_CHAT_HISTORY);

      if (messages.length === 0) {
        await deliverDmText(bot, ctx, recipientUserId, "Нет сообщений для анализа.");
        return;
      }

      const note = await extractNote(
        messages.map((m) => ({
          userId: m.userId,
          userName: m.userName,
          content: m.content,
        })),
      );

      const { createNotePage } = await import("./services/notion");
      const result = await createNotePage(notionDbId, {
        ...note,
        url:
          chat.type === "supergroup" || chat.type === "group"
            ? `https://t.me/c/${String(targetChatId).replace("-100", "")}`
            : undefined,
      });

      await deliverDmText(
        bot,
        ctx,
        recipientUserId,
        `✅ Заметка сохранена в Notion\n\n` +
          `${note.title}\n` +
          `${note.summary.slice(0, 200)}${note.summary.length > 200 ? "…" : ""}\n\n` +
          `Открыть в Notion: ${result.url}`,
      );
    } catch (error) {
      console.error("Note extraction error:", error);
      const errMsg = error instanceof Error ? error.message : "";
      if (errMsg.includes("Notion API error")) {
        await deliverDmText(
          bot,
          ctx,
          recipientUserId,
          "❌ Ошибка Notion API. Проверь доступ интеграции к выбранной базе.",
        );
      } else if (errMsg.includes("not configured")) {
        await deliverDmText(bot, ctx, recipientUserId, "❌ Notion не настроен на сервере.");
      } else {
        await deliverDmText(
          bot,
          ctx,
          recipientUserId,
          "❌ Ошибка при создании заметки. Попробуй позже.",
        );
      }
    }
  }),
);

bot.command(
  "connect_notion",
  safeCommand("connect_notion", async (ctx) => {
    if (!(await requireOwner(ctx))) return;
    const chat = ctx.chat;
    if (!chat || chat.type !== "private") {
      await ctx.reply("Эта команда работает только в личных сообщениях.");
      return;
    }

    const { isNotionConfigured, searchDatabases } = await import("./services/notion");
    if (!isNotionConfigured()) {
      await ctx.reply(
        "🔌 Notion не настроен на сервере.\n\n" +
          "Администратор должен добавить NOTION_TOKEN в .env",
      );
      return;
    }

    await ctx.reply("🔍 Ищу доступные базы Notion…");

    try {
      const databases = await searchDatabases();

      if (databases.length === 0) {
        await ctx.reply(
          "📭 Не найдено баз, доступных интеграции.\n\n" +
            "1. Открой нужную страницу в Notion\n" +
            "2. Нажми ⋮ → Добавить связи → найди интеграцию бота\n" +
            "3. Повтори /connect_notion",
        );
        return;
      }

      const buttons = databases.map((db) => ({
        text: db.title,
        callback_data: `select_notion_db:${db.id}`,
      }));

      // Add option to create new database
      buttons.push({
        text: "➕ Создать новую базу",
        callback_data: "create_notion_db_prompt",
      });

      const keyboard = buttons.map((b) => [b]);

      await ctx.reply("📁 Выбери базу для заметок:", {
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (error) {
      console.error("Notion search error:", error);
      await ctx.reply("❌ Ошибка при поиске баз Notion. Попробуй позже.");
    }
  }),
);

bot.command(
  "digest",
  safeCommand("digest", async (ctx) => {
    if (!(await requireOwner(ctx))) return;
    const recipientUserId = await requireDmRecipient(ctx);
    if (!recipientUserId) return;

    await deliverDmText(bot, ctx, recipientUserId, "📬 Дайджест в разработке.");
  }),
);

bot.command(
  "debts",
  safeCommand("debts", async (ctx) => {
    const chat = ctx.chat;
    if (!chat) return;
    if (!(await requireOwner(ctx))) return;

    let targetChatId: number;
    if (chat.type === "private") {
      const choice = await resolveDMChat(ctx, allowedChatIds);
      if (!choice) return;
      targetChatId = choice.chatId;
    } else if (chat.type === "group" || chat.type === "supergroup") {
      targetChatId = chat.id;
    } else {
      await ctx.reply("Команда работает в группах и личных сообщениях.");
      return;
    }
    if (!(await requireAllowedSource(ctx, targetChatId))) return;
    const recipientUserId = await requireDmRecipient(ctx);
    if (!recipientUserId) return;

    try {
      const activeDebts = await debtTracker.getActiveDebts(targetChatId);
      if (activeDebts.length === 0) {
        await deliverDmText(bot, ctx, recipientUserId, "💰 Нет активных долгов в этом чате.");
        return;
      }

      const { formatAmount } = await import("./services/debt-tracker");
      const lines = ["💰 Активные долги:\n"];
      for (const debt of activeDebts) {
        lines.push(
          `• ${debt.debtorUserName || "Unknown"} → ${debt.creditorUserName || "Unknown"}: ${formatAmount(debt.amount, debt.currency)}${debt.description ? ` (${debt.description})` : ""}`,
        );
      }
      await deliverDmText(bot, ctx, recipientUserId, lines.join("\n"));
    } catch (error) {
      console.error("[debts] Error:", error);
      await deliverDmText(bot, ctx, recipientUserId, "❌ Ошибка при получении списка долгов.");
    }
  }),
);

// MTProto account bootstrap is intentionally an out-of-band admin operation.
// The bot never accepts phone numbers, OTP codes, contacts, or 2FA passwords.
bot.command(
  "connect_account",
  safeCommand("connect_account", async (ctx) => {
    if (!(await requireOwner(ctx))) return;
    await ctx.reply(
      "🔐 Подключение Telegram-аккаунта выполняется только локально администратором сервера. " +
        "Коды и пароль в чат отправлять не нужно.",
    );
  }),
);

// Private-message handler for non-MTProto interactive flows.
bot.on("message", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || chat.type !== "private") return;
  const text = ctx.text || "";
  const userId = ctx.from?.id;
  if (!userId || !accessPolicy.isOwner(userId)) return;

  // Handle Notion parent page ID input
  const session = ctx.session as Record<string, unknown>;
  if (session.awaitingNotionParentPageId) {
    const pageId = text.trim().replace(/-/g, ""); // Notion IDs can have dashes
    if (!pageId || pageId.length < 10) {
      await ctx.reply("❌ Неверный ID страницы. Попробуй ещё раз или отмени командой /cancel.");
      return;
    }

    delete session.awaitingNotionParentPageId;

    try {
      const { createDatabase } = await import("./services/notion");
      const dbId = await createDatabase(pageId, "HyperSummary Notes");
      session.notionDatabaseId = dbId;
      await ctx.reply(
        `✅ Создана новая база "HyperSummary Notes" в Notion!\n\n` +
          `Теперь /note будет сохранять заметки сюда.`,
      );
    } catch (error) {
      console.error("[notion] Failed to create database:", error);
      await ctx.reply(
        "❌ Не удалось создать базу.\n\n" +
          "Проверь:\n" +
          "1. ID страницы скопирован правильно\n" +
          "2. Интеграция имеет доступ к этой странице (⋮ → Добавить связи)\n" +
          "3. Повтори /connect_notion и выбери существующую базу",
      );
    }
    return;
  }
});

// Auto-import history when bot is added to a group and MTProto is configured
bot.on("my_chat_member", async (ctx) => {
  const chat = ctx.chat;
  const oldStatus = ctx.oldChatMember?.status;
  const newStatus = ctx.newChatMember?.status;

  console.log("[my_chat_member] received", {
    chatId: chat?.id,
    chatType: chat?.type,
    oldStatus,
    newStatus,
  });

  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) {
    console.log("[my_chat_member] skipped: not a group");
    return;
  }
  if (!accessPolicy.isAllowedChat(chat.id)) {
    console.log("[my_chat_member] skipped: source not allowlisted");
    return;
  }

  // Bot was just added to the group (or became admin)
  if (oldStatus !== "member" && newStatus === "member") {
    console.log("[my_chat_member] bot added to group", { chatId: chat.id });
    knownGroupIds.add(chat.id);
    const { isMtProtoConfigured, importChatHistory } = await import("./services/mtproto");

    if (await isMtProtoConfigured()) {
      // Silent import in background
      (async () => {
        try {
          const mtprotoChatId =
            chat.type === "supergroup" ? Math.abs(chat.id + 1000000000000) : Math.abs(chat.id);
          await importChatHistory(chatHistory, mtprotoChatId, {
            limit: MAX_CHAT_HISTORY,
            type: chat.type === "supergroup" ? "channel" : "group",
            allowedChatIds,
          });
        } catch (error) {
          console.error("Summary error:", error);
          const errMsg = error instanceof Error ? error.message : "";
          if (
            errMsg.includes("401") ||
            errMsg.includes("token") ||
            errMsg.includes("All AI providers failed")
          ) {
            await ctx.reply(
              "❌ AI-сервисы временно недоступны — ключи API устарели.\n" +
                "Нужно обновить ZAI_API_KEY / HF_TOKEN / GEMINI_API_KEY в .env",
            );
          } else {
            await ctx.reply("❌ Ошибка при генерации саммари. Попробуй позже.");
          }
        }
      })();
    }
  }

  // Bot was removed from the group
  if (oldStatus === "member" && newStatus !== "member") {
    console.log("[my_chat_member] bot removed from group", { chatId: chat.id });
    knownGroupIds.delete(chat.id);
  }
});

// Handle inline keyboard group selection in DM
bot.on("callback_query", async (ctx) => {
  const c = ctx as any;
  const data = c.callbackQuery?.data || "";
  if (!data.startsWith("select_chat:")) return;
  if (!accessPolicy.isOwner(c.from?.id)) {
    await c.answerCallbackQuery("⛔ Недоступно");
    return;
  }

  const [, rawId, type] = data.split(":");
  const mtprotoId = Number(rawId);
  if (!mtprotoId || !type) {
    await c.answerCallbackQuery("❌ Неверные данные");
    return;
  }

  const chatId = toBotApiChatId(mtprotoId, type as "group" | "channel");
  if (!accessPolicy.isAllowedChat(chatId)) {
    await c.answerCallbackQuery("⛔ Недоступно");
    return;
  }
  const session = c.session as Record<string, unknown>;
  session.selectedChatId = chatId;

  // Fetch title from MTProto common groups to cache it in session
  try {
    const { getCommonGroups } = await import("./services/mtproto");
    const groups = await getCommonGroups(config.BOT_USERNAME);
    const group = groups.find((g: any) => g.id === mtprotoId);
    if (group) {
      session.selectedChatTitle = group.title;
    }
  } catch {
    // ignore
  }

  await c.answerCallbackQuery("✅ Группа выбрана");
  await c.reply("📌 Группа выбрана. Теперь можешь использовать команды здесь.");
});

// Handle Notion database selection callbacks
bot.on("callback_query", async (ctx) => {
  const c = ctx as any;
  const data = c.callbackQuery?.data || "";
  if (!data.startsWith("select_notion_db:") && data !== "create_notion_db_prompt") return;
  if (!accessPolicy.isOwner(c.from?.id)) {
    await c.answerCallbackQuery("⛔ Недоступно");
    return;
  }

  if (data.startsWith("select_notion_db:")) {
    const [, dbId] = data.split(":");
    if (!dbId) {
      await c.answerCallbackQuery("❌ Неверные данные");
      return;
    }

    const session = c.session as Record<string, unknown>;
    session.notionDatabaseId = dbId;
    await c.answerCallbackQuery("✅ База выбрана");
    await c.reply("📌 База Notion выбрана. Теперь /note будет сохранять заметки сюда.");
    return;
  }

  if (data === "create_notion_db_prompt") {
    const session = c.session as Record<string, unknown>;
    session.awaitingNotionParentPageId = true;
    await c.answerCallbackQuery("Введи ID страницы");
    await c.reply(
      "📝 Чтобы создать новую базу, мне нужен ID родительской страницы в Notion.\n\n" +
        "1. Открой страницу в Notion\n" +
        "2. Скопируй её ID из URL (последняя часть после последнего слеша)\n" +
        "3. Вставь ID сюда",
    );
    return;
  }
});

// Handle file uploads for chat dump import
bot.on("message", async (ctx) => {
  if (!ctx.chat || !accessPolicy.isOwner(ctx.from?.id)) return;

  const fileName = ctx.document?.fileName?.toLowerCase() || "";
  if (fileName.endsWith(".json") || fileName.endsWith(".csv")) {
    await ctx.reply(`📁 Получен файл ${fileName}. Импорт в разработке.`);
  }
});

// Store incoming messages
bot.on("message", async (ctx) => {
  const chat = ctx.chat;
  if (!chat) return;

  // Skip bot's own messages — don't pollute chat history with placeholders and summaries
  if (ctx.from?.id && botUserId && ctx.from.id === botUserId) return;

  // Only process allowlisted group chats
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  if (!accessPolicy.isAllowedChat(chat.id)) return;
  knownGroupIds.add(chat.id);

  const content = buildMessageContent({
    text: ctx.text,
    caption: ctx.caption,
    voice: !!ctx.voice,
    forwardOrigin: ctx.forwardOrigin,
    replyMessage: ctx.replyMessage,
  });

  await chatHistory.save({
    chatId: chat.id,
    messageId: ctx.id,
    userId: ctx.from?.id ?? 0,
    userName: ctx.from?.firstName || null,
    role: "user",
    content,
    sourceCreatedAt: sourceDate(ctx.payload.date),
    sourceEditedAt: sourceDate(ctx.payload.edit_date),
    threadId: ctx.payload.message_thread_id ?? null,
    sourceKind: "bot_api",
    contentKind: ctx.voice ? "placeholder" : "text",
    replyToMessageId: ctx.replyMessage?.id || null,
    forwardFromName: buildForwardFromNameForDb(ctx.forwardOrigin),
  });

  // Handle voice messages — transcribe asynchronously
  if (ctx.voice) {
    (async () => {
      try {
        const fileInfo = await bot.api.getFile({ file_id: ctx.voice!.fileId });
        if (fileInfo.file_path) {
          const fileUrl = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${fileInfo.file_path}`;
          const response = await fetch(fileUrl);
          const arrayBuffer = await response.arrayBuffer();

          const { transcribeAudio } = await import("./services/ai/voice");
          const transcription = await transcribeAudio(arrayBuffer);

          // Update message content with transcription, preserving reply/forward context
          const transcribedContent = buildMessageContent({
            text: transcription.text,
            voice: false,
            forwardOrigin: ctx.forwardOrigin,
            replyMessage: ctx.replyMessage,
          });
          await chatHistory.updateContent(chat.id, ctx.id, transcribedContent, "transcription");
          console.log("[voice] transcription persisted");
        }
      } catch (error) {
        console.error("Voice transcription error:", error);
        await chatHistory.updateContent(
          chat.id,
          ctx.id,
          "[Voice message - transcription failed]",
          "placeholder",
        );
      }
    })();
  }

  // Save/update chat title for user-facing display
  void chatHistory
    .saveChat({
      chatId: chat.id,
      title: chat.title || String(chat.id),
      type: chat.type,
      username: "username" in chat ? (chat.username ?? undefined) : undefined,
    })
    .catch((err) => {
      console.error("Failed to save chat title:", err);
    });
});

// The Bot API may deliver edits independently of MTProto. Keep the same source
// timestamps and allowlist boundary instead of replacing them with arrival time.
bot.on("edited_message", async (ctx) => {
  const chat = ctx.chat;
  if (
    !chat ||
    (chat.type !== "group" && chat.type !== "supergroup") ||
    !accessPolicy.isAllowedChat(chat.id)
  )
    return;
  if (ctx.from?.id === botUserId) return;
  await chatHistory.save({
    chatId: chat.id,
    messageId: ctx.id,
    userId: ctx.from?.id ?? 0,
    userName: ctx.from?.firstName ?? null,
    role: "user",
    content: buildMessageContent({
      text: ctx.text,
      caption: ctx.caption,
      voice: !!ctx.voice,
      forwardOrigin: ctx.forwardOrigin,
      replyMessage: ctx.replyMessage,
    }),
    replyToMessageId: ctx.replyMessage?.id ?? null,
    forwardFromName: buildForwardFromNameForDb(ctx.forwardOrigin),
    sourceCreatedAt: sourceDate(ctx.payload.date),
    sourceEditedAt: sourceDate(ctx.payload.edit_date),
    threadId: ctx.payload.message_thread_id ?? null,
    sourceKind: "bot_api",
    contentKind: ctx.voice ? "placeholder" : "text",
  });
});

// Register bot commands in Telegram UI
async function registerBotCommands() {
  await bot.api.setMyCommands({
    commands: [
      { command: "start", description: "👋 Start bot / show help" },
      { command: "help", description: "📖 Show all commands and features" },
      { command: "summary", description: "📊 Summary of recent messages [type] [count]" },
      { command: "ask", description: "❓ Ask a question about chat history (answers in DM)" },
      { command: "search", description: "🔍 Search messages by text" },
      { command: "note", description: "📝 Extract useful note to Notion" },
      { command: "digest", description: "📬 Request digest (sent to DM)" },
      { command: "debts", description: "💰 Show active debts / who owes whom" },
      {
        command: "connect_account",
        description: "🔐 Show MTProto admin bootstrap status",
      },
      {
        command: "connect_notion",
        description: "🔗 Connect Notion database for notes (DM only)",
      },
    ],
  });
  console.log("✅ Bot commands registered");
}

// Start bot
async function main() {
  console.log(`🚀 Starting ${config.BOT_USERNAME}...`);
  if (!accessPolicy.isConfigured()) {
    console.warn("[security] owner/source allowlist is not configured; data access is disabled");
  }

  // Load known groups from DB before any imports run
  await loadKnownGroupIds();
  await registerBotCommands();

  // Fetch bot's own user ID to filter out bot messages from history
  try {
    const me = await bot.api.getMe();
    botUserId = me.id;
    console.log(`🤖 Bot user ID: ${botUserId}`);
  } catch (err) {
    console.warn("Failed to fetch bot user ID:", err);
  }

  // Start HTTP server: webhook receiver (prod) or test API (dev)
  if (config.WEBHOOK_URL) {
    const { startWebhookServer } = await import("./webhook-server");
    startWebhookServer(bot);
  } else {
    // Polling mode: start test server on separate port
    try {
      const { startTestServer } = await import("./test-server");
      startTestServer();
    } catch (err) {
      console.warn("[test-api] Failed to start test server:", err);
    }
  }

  // One-time import + real-time sync for already-connected MTProto accounts
  if (config.MTPROTO_API_ID && config.MTPROTO_API_HASH) {
    runInitialImport();
    (async () => {
      try {
        const { startRealtimeSync } = await import("./services/mtproto");
        const dispose = await startRealtimeSync(chatHistory, allowedChatIds);
        if (dispose.toString() !== "() => {}") {
          console.log("📡 MTProto real-time sync started");
        }
      } catch (err) {
        console.warn("⚠️ MTProto sync failed:", err);
      }
    })();
  }

  if (config.WEBHOOK_URL) {
    // Production with webhook
    console.log(`🔌 Starting webhook mode on ${config.WEBHOOK_URL}`);
    await bot.start({
      webhook: {
        url: config.WEBHOOK_URL,
        ...(config.WEBHOOK_SECRET ? { secret_token: config.WEBHOOK_SECRET } : {}),
      },
    });
  } else {
    // Polling mode (dev or prod without webhook)
    console.log("📡 Starting polling mode");
    await bot.start();
  }
}

let shutdownStarted = false;
async function shutdown(signal: string): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`[process] ${signal}: shutting down MTProto`);
  try {
    const { shutdownMtProto } = await import("./services/mtproto");
    await shutdownMtProto();
  } catch (error) {
    console.error("[process] MTProto shutdown failed:", error);
  } finally {
    process.exit(0);
  }
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

// Process-level safety nets — never crash on transient / unhandled errors
process.on("uncaughtException", (err) => {
  console.error("[process] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection:", reason);
});

main().catch((err) => {
  console.error("Failed to start bot:", err);
  process.exit(1);
});
