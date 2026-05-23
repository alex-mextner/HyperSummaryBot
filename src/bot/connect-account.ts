import type { ChatHistoryRepository } from "../db/repositories/chat-history";
import { formatChatStatsText } from "./message-processor";
import { MAX_CHAT_HISTORY } from "../config/constants";

export interface ConnectAccountContext {
  chat?: { id: number; type: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reply: (text: string, opts?: any) => Promise<unknown>;
}

export async function buildConnectAccountStatus(options: {
  isMtProtoConfigured: boolean;
  chatHistory: ChatHistoryRepository;
}): Promise<string> {
  if (!options.isMtProtoConfigured) {
    return (
      "⚠️ MTProto не настроен на сервере.\n\n" +
      "Администратор должен добавить MTPROTO_API_ID и MTPROTO_API_HASH в .env"
    );
  }

  const allChatIds = await options.chatHistory.getAllChatIds();
  let statusText = "📊 <b>Статус импорта истории</b>\n\n";

  if (allChatIds.length === 0) {
    statusText += "История еще не импортирована ни в один чат.\n\n";
  } else {
    for (const chatId of allChatIds.slice(0, 10)) {
      const stats = await options.chatHistory.getChatStats(chatId);
      if (stats.total > 0) {
        const chatInfo = await options.chatHistory.getChat(chatId);
        const chatName = chatInfo?.title || String(chatId);
        const earliest = stats.earliestDate ? stats.earliestDate.toLocaleDateString("ru-RU") : "?";
        const latest = stats.latestDate ? stats.latestDate.toLocaleDateString("ru-RU") : "?";
        const pct = Math.min((stats.total / MAX_CHAT_HISTORY) * 100, 100).toFixed(1);
        statusText += formatChatStatsText({
          chatName,
          total: stats.total,
          percentage: pct,
          earliest,
          latest,
        });
      }
    }
  }

  statusText +=
    "🔐 <b>Подключение Telegram аккаунта</b>\n\n" +
    "Это нужно для импорта истории чатов до момента добавления бота.\n\n" +
    "Отправьте ваш номер телефона в формате <code>+79123456789</code>:";

  return statusText;
}

export async function handleConnectAccount(
  ctx: ConnectAccountContext,
  chatHistory: ChatHistoryRepository,
  opts: { mtprotoConfigured: boolean } = { mtprotoConfigured: true },
): Promise<void> {
  try {
    const chat = ctx.chat;
    if (!chat || chat.type !== "private") {
      await ctx.reply("Эта команда работает только в личных сообщениях со мной.");
      return;
    }

    const statusText = await buildConnectAccountStatus({
      isMtProtoConfigured: opts.mtprotoConfigured,
      chatHistory,
    });

    await ctx.reply(statusText, { parse_mode: "HTML" });
  } catch (error) {
    console.error("Connect account error:", error);
    await ctx.reply("❌ Что-то пошло не так. Попробуйте позже или используйте /help.");
  }
}
