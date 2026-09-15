export interface DmBot {
  api: {
    sendChatAction(params: { chat_id: number; action: "typing" }): Promise<unknown>;
    sendMessage(params: { chat_id: number; text: string }): Promise<unknown>;
  };
}

export interface DmFallbackContext {
  chat?: { type: string };
  reply(text: string): Promise<unknown>;
}

const OPEN_DM_HINT = "🔒 Открой личный чат со мной, чтобы получить результат.";

export async function requireDmDelivery(
  bot: DmBot,
  ctx: DmFallbackContext,
  recipientUserId: number,
): Promise<boolean> {
  try {
    await bot.api.sendChatAction({ chat_id: recipientUserId, action: "typing" });
    return true;
  } catch {
    console.warn("[delivery] DM preflight failed");
    await sendNeutralHint(ctx);
    return false;
  }
}

async function sendNeutralHint(ctx: DmFallbackContext): Promise<void> {
  if (ctx.chat?.type === "private") return;
  try {
    await ctx.reply(OPEN_DM_HINT);
  } catch {
    console.warn("[delivery] Failed to send neutral DM hint");
  }
}

export async function sendDmText(bot: DmBot, recipientUserId: number, text: string): Promise<void> {
  await bot.api.sendMessage({ chat_id: recipientUserId, text });
}

export async function deliverDmText(
  bot: DmBot,
  ctx: DmFallbackContext,
  recipientUserId: number,
  text: string,
): Promise<boolean> {
  try {
    await sendDmText(bot, recipientUserId, text);
    return true;
  } catch {
    console.warn("[delivery] DM send failed");
    await sendNeutralHint(ctx);
    return false;
  }
}
