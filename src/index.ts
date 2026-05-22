import { Bot } from "gramio";
import { session } from "@gramio/session";
import { sqliteStorage } from "@gramio/storage-sqlite";
import { loadConfig } from "./config/env";
import { initDatabase } from "./db/client";
import { ChatHistoryRepository } from "./db/repositories/chat-history";

const config = loadConfig();

// Init database
const db = initDatabase(config.DATABASE_PATH);
const chatHistory = new ChatHistoryRepository(db);

// Create bot
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

// Commands
bot.command("start", async (ctx) => {
  await ctx.reply(
    `👋 Привет! Я <b>${config.BOT_USERNAME}</b> — бот для саммари групповых чатов.\n\n` +
      "📋 <b>Доступные команды:</b>\n" +
      "/summary — Саммари последних сообщений\n" +
      "/ask — Задать вопрос по истории чата (в ЛС)\n" +
      "/search — Поиск по истории\n" +
      "/note — Извлечь полезную заметку\n" +
      "/config — Настройки чата\n" +
      "/digest — Получить дайджест (в ЛС)\n" +
      "/help — Помощь",
    { parse_mode: "HTML" },
  );
});

bot.command("help", async (ctx) => {
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
});

// Store incoming messages
bot.on("message", async (ctx) => {
  const chat = ctx.chat;
  if (!chat) return;

  // Only process group chats
  if (chat.type !== "group" && chat.type !== "supergroup") return;

  let content = ctx.text || ctx.caption || "";

  // Handle voice messages
  if (ctx.voice) {
    content = "[Voice message]";
  }

  // Forward enrichment
  if (ctx.forwardOrigin) {
    const forwardName =
      ctx.forwardOrigin.type === "user"
        ? ctx.forwardOrigin.senderUser?.firstName
        : ctx.forwardOrigin.type === "chat"
          ? ctx.forwardOrigin.senderChat?.title
          : "Forwarded message";
    content = `Forwarded from ${forwardName}: ${content}`;
  }

  // Reply enrichment
  if (ctx.replyMessage) {
    const replyText = ctx.replyMessage.text || ctx.replyMessage.caption || "";
    const replyUser = ctx.replyMessage.from?.firstName || "User";
    content = `Reply to ${replyUser} («${replyText.slice(0, 100)}...»): ${content}`;
  }

  await chatHistory.save({
    chatId: chat.id,
    messageId: ctx.id,
    userId: ctx.from?.id ?? 0,
    userName: ctx.from?.firstName || null,
    role: "user",
    content,
    replyToMessageId: ctx.replyMessage?.id || null,
    forwardFromName:
      ctx.forwardOrigin?.type === "user"
        ? ctx.forwardOrigin.senderUser?.firstName || null
        : ctx.forwardOrigin?.type === "chat"
          ? ctx.forwardOrigin.senderChat?.title || null
          : null,
  });
});

// Start bot
async function main() {
  console.log(`🚀 Starting ${config.BOT_USERNAME}...`);

  if (config.NODE_ENV === "development") {
    // Use polling for local dev
    await bot.start();
  } else {
    // Use webhook for production
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) {
      console.warn("WEBHOOK_URL not set, falling back to polling");
      await bot.start();
    } else {
      await bot.api.setWebhook({ url: webhookUrl });
      console.log(`✅ Webhook set: ${webhookUrl}`);
    }
  }
}

main().catch((err) => {
  console.error("Failed to start bot:", err);
  process.exit(1);
});
