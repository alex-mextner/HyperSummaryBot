import { Bot } from "gramio";
import { session } from "@gramio/session";
import { sqliteStorage } from "@gramio/storage-sqlite";
import { loadConfig } from "./config/env";
import { initDatabase } from "./db/client";
import { ChatHistoryRepository } from "./db/repositories/chat-history";
import { generateSummary, type SummaryType } from "./agents/summary";

const config = loadConfig();

// Init database
const db = initDatabase(config.DATABASE_PATH);
const chatHistory = new ChatHistoryRepository(db);

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

bot.command("summary", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) {
    await ctx.reply("Эта команда работает только в группах.");
    return;
  }

  const args = ctx.text?.split(" ").slice(1) || [];
  const type = (args[0] as SummaryType) || "general";
  const count = Math.min(Number.parseInt(args[1] || "50", 10), 200);

  await ctx.reply(`📊 Генерирую саммари типа "${type}" за последние ${count} сообщений...`);

  try {
    const messages = await ctx.chatHistory.getRecent(chat.id, count);

    if (messages.length === 0) {
      await ctx.reply("Нет сообщений для анализа.");
      return;
    }

    const formattedMessages = messages.map((m) => ({
      userName: m.userName,
      content: m.content,
    }));

    await generateSummary({
      chatId: chat.id,
      messages: formattedMessages,
      type,
      bot,
    });
  } catch (error) {
    console.error("Summary error:", error);
    await ctx.reply("❌ Ошибка при генерации саммари. Попробуйте позже.");
  }
});

bot.command("ask", async (ctx) => {
  const chat = ctx.chat;
  if (!chat) return;

  const question = ctx.text?.split(" ").slice(1).join(" ") || "";
  if (!question.trim()) {
    await ctx.reply("❓ Задайте вопрос: /ask <ваш вопрос>");
    return;
  }

  const userId = ctx.from?.id;
  if (!userId) return;

  await ctx.reply("🤔 Анализирую вопрос...");

  try {
    const messages = await ctx.chatHistory.getRecent(chat.id, 100);

    try {
      await bot.api.sendMessage({
        chat_id: userId,
        text: `🔍 <b>Вопрос:</b> ${question}\n\n<i>Анализирую ${messages.length} сообщений...</i>`,
        parse_mode: "HTML",
      });
    } catch {
      await ctx.reply("Откройте ЛС со мной, чтобы получить ответ.");
      return;
    }

    // TODO: Implement QA agent with streaming
    await bot.api.sendMessage({
      chat_id: userId,
      text: `📋 <b>Ответ на ваш вопрос:</b>\n\n${question}\n\n(Агент в разработке)`,
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error("Ask error:", error);
    await ctx.reply("❌ Ошибка при обработке вопроса.");
  }
});

bot.command("search", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) {
    await ctx.reply("Эта команда работает только в группах.");
    return;
  }

  const query = ctx.text?.split(" ").slice(1).join(" ") || "";
  if (!query.trim()) {
    await ctx.reply("🔍 Введите запрос: /search <текст>");
    return;
  }

  await ctx.reply(`🔍 Ищу: "${query}"...`);

  try {
    const messages = await ctx.chatHistory.getRecent(chat.id, 99999);
    const results = messages.filter((m) => m.content.toLowerCase().includes(query.toLowerCase()));

    if (results.length === 0) {
      await ctx.reply("Ничего не найдено.");
      return;
    }

    const formatted = results
      .slice(0, 20)
      .map((m) => `${m.userName}: ${m.content.slice(0, 200)}`)
      .join("\n\n");

    await ctx.reply(`🔍 <b>Результаты (${results.length}):</b>\n\n${formatted}`, {
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error("Search error:", error);
    await ctx.reply("❌ Ошибка при поиске.");
  }
});

bot.command("note", async (ctx) => {
  await ctx.reply("📝 Извлечение заметок в разработке. Скоро будет доступно!");
});

bot.command("config", async (ctx) => {
  await ctx.reply(
    "⚙️ <b>Настройки</b>\n\n" +
      "Доступные параметры:\n" +
      "• Язык: автоматически\n" +
      "• Стиль саммари: подробный\n" +
      "• Хранение: 99999 сообщений\n\n" +
      "(Расширенные настройки в разработке)",
    { parse_mode: "HTML" },
  );
});

bot.command("digest", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ctx.reply("📬 Дайджест в разработке. Будет отправлен в ЛС когда готов.");
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
