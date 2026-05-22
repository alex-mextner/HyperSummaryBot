import { Bot } from "gramio";
import { session } from "@gramio/session";
import { sqliteStorage } from "@gramio/storage-sqlite";
import { loadConfig } from "./config/env";
import { MAX_CHAT_HISTORY } from "./config/constants";
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

bot.command("digest", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  await ctx.reply("📬 Дайджест в разработке. Будет отправлен в ЛС когда готов.");
});

// In-memory store for pending MTProto auth promises
const pendingAuthCodes = new Map<
  number,
  { resolve: (code: string) => void; reject: (err: Error) => void }
>();

// MTProto account connection (DM only)
bot.command("connect_account", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || chat.type !== "private") {
    await ctx.reply("Эта команда работает только в личных сообщениях со мной.");
    return;
  }

  const { isMtProtoConfigured } = await import("./services/mtproto");

  if (!(await isMtProtoConfigured())) {
    await ctx.reply(
      "⚠️ MTProto не настроен на сервере.\n\n" +
        "Администратор должен добавить MTPROTO_API_ID и MTPROTO_API_HASH в .env",
    );
    return;
  }

  // Show import status for all chats
  const allChatIds = await chatHistory.getAllChatIds();
  let statusText = "📊 <b>Статус импорта истории</b>\n\n";

  if (allChatIds.length === 0) {
    statusText += "История еще не импортирована ни в один чат.\n\n";
  } else {
    for (const chatId of allChatIds.slice(0, 10)) {
      const stats = await chatHistory.getChatStats(chatId);
      if (stats.total > 0) {
        let chatName: string;
        try {
          const chatInfo = await bot.api.getChat({ chat_id: chatId });
          chatName = "title" in chatInfo ? chatInfo.title || String(chatId) : String(chatId);
        } catch {
          chatName = String(chatId);
        }
        const earliest = stats.earliestDate ? stats.earliestDate.toLocaleDateString("ru-RU") : "?";
        const latest = stats.latestDate ? stats.latestDate.toLocaleDateString("ru-RU") : "?";
        const pct = Math.min((stats.total / MAX_CHAT_HISTORY) * 100, 100).toFixed(1);
        statusText += `• <b>${chatName}</b>: ${stats.total} сообщений (${pct}%)\n  с ${earliest} по ${latest}\n\n`;
      }
    }
  }

  statusText +=
    "🔐 <b>Подключение Telegram аккаунта</b>\n\n" +
    "Это нужно для импорта истории чатов до момента добавления бота.\n\n" +
    "Отправьте ваш номер телефона в формате <code>+79123456789</code>:";

  await ctx.reply(statusText, { parse_mode: "HTML" });
});

// Handle MTProto auth flow in DMs
bot.on("message", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || chat.type !== "private") return;

  const text = ctx.text || "";
  const userId = ctx.from?.id;
  if (!userId) return;

  // Check if user has a pending code promise
  const pendingAuth = pendingAuthCodes.get(userId);
  if (pendingAuth) {
    const code = text.trim().replace(/-/g, "");
    pendingAuth.resolve(code);
    pendingAuthCodes.delete(userId);
    return;
  }

  // Handle phone number input for MTProto auth
  if (/^\+\d{10,15}$/.test(text.trim())) {
    const phone = text.trim();

    await ctx.reply(`📱 Номер: ${phone}\n\n` + "Отправляю запрос на код подтверждения...");

    try {
      const { TelegramClient } = await import("@mtcute/bun");
      const client = new TelegramClient({
        apiId: config.MTPROTO_API_ID!,
        apiHash: config.MTPROTO_API_HASH!,
        storage: "data/mtcute-session",
      });

      // Start auth and wait for code
      await client.start({
        phone,
        code: async () => {
          await ctx.reply(
            "🔑 <b>Код отправлен в Telegram</b>\n\n" +
              "Введите код из сообщения от Telegram (без дефисов):",
            { parse_mode: "HTML" },
          );

          return new Promise<string>((resolve, reject) => {
            pendingAuthCodes.set(userId, { resolve, reject });
          });
        },
      });

      await ctx.reply("✅ <b>Аккаунт подключен!</b>", { parse_mode: "HTML" });

      // Auto-import history from all user groups
      const { getUserGroups, importChatHistory } = await import("./services/mtproto");
      const groups = await getUserGroups();

      if (groups.length === 0) {
        await ctx.reply("Группы не найдены. Добавь меня в группу — я начну собирать историю.");
      } else {
        await ctx.reply(`📥 Найдено ${groups.length} групп. Начинаю импорт истории в фоне...`);

        for (const group of groups) {
          (async () => {
            try {
              const result = await importChatHistory(chatHistory, group.id, {
                limit: MAX_CHAT_HISTORY,
              });
              console.log(
                `Auto-imported ${result.imported} messages from ${group.title} (${group.id})`,
              );
            } catch (err) {
              console.error(`Failed to import ${group.title}:`, err);
            }
          })();
        }

        await ctx.reply(
          `🚀 Импорт запущен для ${groups.length} групп.\n\n` +
            "История будет доступна для /summary и /search.",
        );
      }
    } catch (error) {
      pendingAuthCodes.delete(userId);
      console.error("MTProto auth error:", error);
      await ctx.reply(
        `❌ Ошибка авторизации: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
    return;
  }
});

// Auto-import history when bot is added to a group and MTProto is configured
bot.on("my_chat_member", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;

  const oldStatus = ctx.oldChatMember?.status;
  const newStatus = ctx.newChatMember?.status;

  // Bot was just added to the group
  if (oldStatus !== "member" && newStatus === "member") {
    const { isMtProtoConfigured, importChatHistory } = await import("./services/mtproto");

    if (await isMtProtoConfigured()) {
      // Silent import in background
      (async () => {
        try {
          await importChatHistory(chatHistory, chat.id, { limit: MAX_CHAT_HISTORY });
        } catch (error) {
          console.error("Auto MTProto import error:", error);
        }
      })();
    }
  }
});

// Handle file uploads for chat dump import
bot.on("message", async (ctx) => {
  if (!ctx.chat) return;

  const fileName = ctx.document?.fileName?.toLowerCase() || "";
  if (fileName.endsWith(".json") || fileName.endsWith(".csv")) {
    await ctx.reply(`📁 Получен файл ${fileName}. Импорт в разработке.`);
  }
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
    content = "[Voice message - transcribing...]";

    // Transcribe asynchronously
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
          const prefix = content.split("🎙")[0]; // Keep any "Reply to..." or "Forwarded from..." prefix
          const transcribedContent = `${prefix}🎙 <i>Voice message:</i> ${transcription.text}`;
          await chatHistory.updateContent(chat.id, ctx.id, transcribedContent);

          console.log(
            `Transcribed voice message ${ctx.id}: ${transcription.text.slice(0, 100)}...`,
          );
        }
      } catch (error) {
        console.error("Voice transcription error:", error);
        await chatHistory.updateContent(chat.id, ctx.id, "[Voice message - transcription failed]");
      }
    })();
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
      {
        command: "connect_account",
        description: "🔐 Connect Telegram account for MTProto (DM only)",
      },
    ],
  });
  console.log("✅ Bot commands registered");
}

// Start bot
async function main() {
  console.log(`🚀 Starting ${config.BOT_USERNAME}...`);

  await registerBotCommands();

  if (config.NODE_ENV === "development") {
    // Use polling for local dev
    await bot.start();
  } else {
    // Production: use polling until webhook server is configured
    await bot.start();
  }
}

main().catch((err) => {
  console.error("Failed to start bot:", err);
  process.exit(1);
});
