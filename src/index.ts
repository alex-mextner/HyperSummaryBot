import { Bot } from "gramio";
import { session } from "@gramio/session";
import { sqliteStorage } from "@gramio/storage-sqlite";
import { loadConfig } from "./config/env";
import { MAX_CHAT_HISTORY } from "./config/constants";
import { initDatabase } from "./db/client";
import { ChatHistoryRepository } from "./db/repositories/chat-history";
import { generateSummary, type SummaryType } from "./agents/summary";
import {
  buildMessageContent,
  buildForwardFromNameForDb,
  parseSummaryArgs,
  parseSearchQuery,
  parseAskQuestion,
} from "./bot/message-processor";
import { handleConnectAccount } from "./bot/connect-account";

const config = loadConfig();

// Init database
const db = initDatabase(config.DATABASE_PATH);
const chatHistory = new ChatHistoryRepository(db);

// Track chats where the bot is actually present — used to filter MTProto import
const knownGroupIds = new Set<number>();
// Pre-populate from existing database records
chatHistory
  .getAllChatIds()
  .then((ids) => {
    for (const id of ids) knownGroupIds.add(id);
    console.log(`📋 Pre-loaded ${knownGroupIds.size} known chats from DB`);
  })
  .catch(() => {});

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

  const args = parseSummaryArgs(ctx.text || "");
  const type = args.type as SummaryType;
  const count = args.count;

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

  const question = parseAskQuestion(ctx.text || "");
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

  const query = parseSearchQuery(ctx.text || "");
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

// In-memory store for pending 2FA password promises
const pendingPasswords = new Map<
  number,
  { resolve: (password: string) => void; reject: (err: Error) => void }
>();

// Cooldown and attempt tracking per user
const CONNECT_COOLDOWN_MS = 60_000;
const MAX_CODE_ATTEMPTS = 3;
const MAX_PASSWORD_ATTEMPTS = 3;
const connectAttempts = new Map<number, number>();
const codeAttemptCounts = new Map<number, number>();
const passwordAttemptCounts = new Map<number, number>();

function isConnectCooldownActive(userId: number): boolean {
  const last = connectAttempts.get(userId);
  return last !== undefined && Date.now() - last < CONNECT_COOLDOWN_MS;
}

/** Strip spaces, dashes, parentheses; ensure leading '+'. */
function normalizePhone(raw: string): string | undefined {
  const normalized = raw.replace(/[\s\-()]/g, "");
  if (!normalized) return undefined;
  return normalized.startsWith("+") ? normalized : `+${normalized}`;
}

/** Strip spaces and dashes from OTP (users add separators to avoid Telegram anti-phishing). */
function normalizeOtpCode(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

async function startMtProtoAuth(ctx: any, userId: number, phone: string): Promise<void> {
  if (isConnectCooldownActive(userId)) {
    const last = connectAttempts.get(userId)!;
    const remaining = Math.ceil((CONNECT_COOLDOWN_MS - (Date.now() - last)) / 1000);
    await ctx.reply(`⏳ Подождите ${remaining} секунд перед следующей попыткой.`);
    return;
  }

  connectAttempts.set(userId, Date.now());
  codeAttemptCounts.set(userId, 0);

  try {
    console.log("[connect_account] importing TelegramClient...");
    const { TelegramClient } = await import("@mtcute/bun");
    console.log("[connect_account] TelegramClient imported, creating client...");
    const client = new TelegramClient({
      apiId: config.MTPROTO_API_ID!,
      apiHash: config.MTPROTO_API_HASH!,
      storage: "data/mtcute-session",
    });
    console.log("[connect_account] client created, calling start...");

    // Start auth and wait for code / password
    await client.start({
      phone,
      code: async () => {
        console.log("[connect_account] prompting for auth code");
        await ctx.reply(
          "🔑 <b>Код отправлен в Telegram</b>\n\n" +
            "Введи код через пробелы или дефисы (напр. <code>1 2 3 4 5</code> или <code>123-45</code>):",
          { parse_mode: "HTML" },
        );

        return new Promise<string>((resolve, reject) => {
          pendingAuthCodes.set(userId, { resolve, reject });
        });
      },
      password: async () => {
        console.log("[connect_account] prompting for 2fa password");
        passwordAttemptCounts.set(userId, 0);

        // mtcute does NOT pass hint as argument — fetch it manually from Telegram API
        let hint: string | undefined;
        try {
          const pwInfo = await client.call({ _: "account.getPassword" });
          hint = (pwInfo as any).hint || undefined;
          console.log("[connect_account] 2fa hint fetched:", hint ?? "(none)");
        } catch (e) {
          console.log("[connect_account] failed to fetch 2fa hint:", e);
        }

        let msg =
          "🔒 <b>Включена двухэтапная аутентификация</b>\n\n" +
          "Введи <b>пароль</b>, который ты задал в Telegram в разделе <i>Настройки → Конфиденциальность → Двухэтапная аутентификация</i>.\n\n" +
          "<i>Это не SMS-код — это твой постоянный пароль от аккаунта.</i>";

        if (hint) {
          msg += `\n\n💡 <b>Подсказка:</b> <i>${hint}</i>`;
        }

        await ctx.reply(msg, { parse_mode: "HTML" });

        return new Promise<string>((resolve, reject) => {
          pendingPasswords.set(userId, { resolve, reject });
        });
      },
    });

    console.log("[connect_account] client.start completed successfully");
    codeAttemptCounts.delete(userId);
    passwordAttemptCounts.delete(userId);
    connectAttempts.delete(userId);
    await ctx.reply("✅ <b>Аккаунт подключен!</b>", { parse_mode: "HTML" });

    // Auto-import history from all user groups
    console.log("[connect_account] fetching user groups...");
    const { getUserGroups, importChatHistory } = await import("./services/mtproto");
    const groups = await getUserGroups();
    console.log("[connect_account] user groups count:", groups.length);

    if (groups.length === 0) {
      await ctx.reply("Группы не найдены. Добавь меня в группу — я начну собирать историю.");
    } else {
      const importableGroups = groups.filter((g) => knownGroupIds.has(g.id));
      console.log(
        "[connect_account] importable groups:",
        importableGroups.length,
        "/",
        groups.length,
      );

      if (importableGroups.length === 0) {
        await ctx.reply(
          "📭 Вижу твои группы в Telegram, но меня в них пока не добавили.\n\n" +
            "Добавь меня в нужные группы, и я начну собирать историю автоматически.",
        );
      } else {
        await ctx.reply(
          `📥 Найдено ${importableGroups.length} групп, где я есть. Начинаю импорт истории в фоне...`,
        );

        for (const group of importableGroups) {
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
          `🚀 Импорт запущен для ${importableGroups.length} групп.\n\n` +
            "История будет доступна для /summary и /search.",
        );
      }
    }
  } catch (error) {
    pendingAuthCodes.delete(userId);
    pendingPasswords.delete(userId);
    codeAttemptCounts.delete(userId);
    passwordAttemptCounts.delete(userId);
    console.error("[connect_account] MTProto auth error:", error);
    await ctx.reply(
      `❌ Ошибка авторизации: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

// MTProto account connection (DM only)
bot.command("connect_account", async (ctx) => {
  console.log("[connect_account] command handler triggered", {
    userId: ctx.from?.id,
    chatId: ctx.chat?.id,
    chatType: ctx.chat?.type,
  });
  try {
    const { isMtProtoConfigured } = await import("./services/mtproto");
    const mtprotoOk = await isMtProtoConfigured();
    console.log("[connect_account] isMtProtoConfigured:", mtprotoOk);
    await handleConnectAccount(ctx, chatHistory, {
      mtprotoConfigured: mtprotoOk,
    });
    console.log("[connect_account] handleConnectAccount completed");
  } catch (error) {
    console.error("[connect_account] command handler ERROR:", error);
    await ctx.reply("❌ Ошибка при обработке команды. Попробуйте позже.");
  }
});

// Handle MTProto auth flow in DMs
bot.on("message", async (ctx) => {
  const chat = ctx.chat;
  if (!chat || chat.type !== "private") return;

  const text = ctx.text || "";
  const userId = ctx.from?.id;
  if (!userId) return;

  // Check if user has a pending 2FA password promise
  const pendingPass = pendingPasswords.get(userId);
  if (pendingPass) {
    const password = text.trim();
    if (!password) {
      await ctx.reply(
        "❌ Облачный пароль не может быть пустым. Введи пароль двухэтапной аутентификации:",
      );
      return;
    }

    const attempts = (passwordAttemptCounts.get(userId) ?? 0) + 1;
    passwordAttemptCounts.set(userId, attempts);

    if (attempts > MAX_PASSWORD_ATTEMPTS) {
      pendingPasswords.delete(userId);
      passwordAttemptCounts.delete(userId);
      pendingPass.reject(new Error("Too many password attempts"));
      await ctx.reply("❌ Слишком много попыток. Начни заново: /connect_account");
      return;
    }

    pendingPass.resolve(password);
    pendingPasswords.delete(userId);
    return;
  }

  // Check if user has a pending code promise
  const pendingAuth = pendingAuthCodes.get(userId);
  if (pendingAuth) {
    // Normalize: strip spaces and dashes that user added to avoid Telegram anti-phishing
    const rawCode = text.trim();
    const code = normalizeOtpCode(rawCode);

    // Validate: must be 5 digits after normalization
    if (!/^\d{5}$/.test(code)) {
      await ctx.reply(
        "❌ Неверный код. Введи 5 цифр через пробелы или дефисы (напр. <code>1 2 3 4 5</code> или <code>123-45</code>).",
        { parse_mode: "HTML" },
      );
      return;
    }

    const attempts = (codeAttemptCounts.get(userId) ?? 0) + 1;
    codeAttemptCounts.set(userId, attempts);

    if (attempts > MAX_CODE_ATTEMPTS) {
      pendingAuthCodes.delete(userId);
      codeAttemptCounts.delete(userId);
      await ctx.reply("❌ Слишком много попыток. Начни заново: /connect_account");
      return;
    }

    pendingAuth.resolve(code);
    pendingAuthCodes.delete(userId);
    return;
  }

  // Handle shared contact (phone number button)
  const contactPhone = ctx.contact?.phoneNumber;
  if (contactPhone) {
    console.log("[connect_account] contact received", { userId, contactPhone });
    const phone = normalizePhone(contactPhone);
    if (!phone) {
      await ctx.reply("❌ Не удалось распознать номер из контакта. Введи вручную: +79123456789");
      return;
    }
    await ctx.reply(`📱 Получен номер: ${phone}\n\n` + "Отправляю запрос на код подтверждения...", {
      reply_markup: { remove_keyboard: true },
    });
    await startMtProtoAuth(ctx, userId, phone);
    return;
  }

  // Handle phone number input for MTProto auth
  const normalizedPhone = text.trim() ? normalizePhone(text.trim()) : undefined;
  if (normalizedPhone && /^\+\d{7,15}$/.test(normalizedPhone)) {
    console.log("[connect_account] phone number received", { userId, phone: normalizedPhone });

    await ctx.reply(
      `📱 Номер: ${normalizedPhone}\n\n` + "Отправляю запрос на код подтверждения...",
      {
        reply_markup: { remove_keyboard: true },
      },
    );
    await startMtProtoAuth(ctx, userId, normalizedPhone);
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
    knownGroupIds.add(chat.id);
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

  // Bot was removed from the group
  if (oldStatus === "member" && newStatus !== "member") {
    knownGroupIds.delete(chat.id);
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
  knownGroupIds.add(chat.id);

  const content = buildMessageContent({
    text: ctx.text,
    caption: ctx.caption,
    voice: !!ctx.voice,
    forwardOrigin: ctx.forwardOrigin,
    replyMessage: ctx.replyMessage,
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

  await chatHistory.save({
    chatId: chat.id,
    messageId: ctx.id,
    userId: ctx.from?.id ?? 0,
    userName: ctx.from?.firstName || null,
    role: "user",
    content,
    replyToMessageId: ctx.replyMessage?.id || null,
    forwardFromName: buildForwardFromNameForDb(ctx.forwardOrigin),
  });

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

  // MTProto real-time sync disabled at startup to avoid crash loop
  // when session is incomplete. Re-enable after successful auth.
  // if (config.MTPROTO_API_ID && config.MTPROTO_API_HASH) {
  //   try {
  //     const { startRealtimeSync } = await import("./services/mtproto");
  //     const dispose = await startRealtimeSync(chatHistory);
  //     console.log("📡 MTProto real-time sync started");
  //   } catch (err) {
  //     console.warn("⚠️ MTProto sync failed (not authenticated yet):", err);
  //   }
  // }

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
