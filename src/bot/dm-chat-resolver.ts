import { loadConfig } from "../config/env";

export interface DMChatChoice {
  chatId: number;
  title: string;
}

/** Convert MTProto peer ID to Bot API chat ID used in DB and live messages. */
export function toBotApiChatId(mtprotoId: number, type: "group" | "channel"): number {
  if (type === "channel") return -1000000000000 - mtprotoId; // -100<channelId>
  return -mtprotoId; // regular group
}

/** Resolve which group to use when user runs a command in DM.
 * 0 groups → null (already replied with hint)
 * 1 group  → auto-select
 * >1       → inline keyboard, null (user must pick)
 */
export async function resolveDMChat(ctx: any): Promise<DMChatChoice | null> {
  const userId = ctx.from?.id;
  if (!userId) return null;

  const session = ctx.session as Record<string, unknown>;

  // Reuse cached selection
  if (typeof session.selectedChatId === "number" && typeof session.selectedChatTitle === "string") {
    return { chatId: session.selectedChatId, title: session.selectedChatTitle };
  }

  const config = loadConfig();
  const { getCommonGroups } = await import("../services/mtproto");
  const groups = await getCommonGroups(config.BOT_USERNAME);

  if (groups.length === 0) {
    await ctx.reply(
      "📭 Нет общих групп. Добавь меня в группу и используй /connect_account, чтобы я увидел историю.",
      { parse_mode: "HTML" },
    );
    return null;
  }

  if (groups.length === 1) {
    const g = groups[0]!;
    const chatId = toBotApiChatId(g.id, g.type);
    session.selectedChatId = chatId;
    session.selectedChatTitle = g.title;
    return { chatId, title: g.title };
  }

  // Multiple groups — ask user to pick
  const keyboard = groups.map((g) => [
    {
      text: g.title,
      callback_data: `select_chat:${g.id}:${g.type}`,
    },
  ]);

  await ctx.reply("📋 У тебя несколько групп. Выбери, с какой работать:", {
    reply_markup: { inline_keyboard: keyboard },
  });

  return null;
}
