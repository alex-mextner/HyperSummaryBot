export interface MessageContext {
  text?: string;
  caption?: string;
  voice?: boolean;
  forwardOrigin?: {
    type: "user" | "chat" | "hidden_user" | "channel" | "supergroup";
    senderUser?: { firstName?: string };
    senderChat?: { title?: string };
  };
  replyMessage?: {
    text?: string;
    caption?: string;
    from?: { firstName?: string };
  };
}

export function buildMessageContent(ctx: MessageContext): string {
  let content = ctx.text || ctx.caption || "";

  // Voice placeholder
  if (ctx.voice) {
    content = "[Voice message - transcribing...]";
  }

  // Forward enrichment
  if (ctx.forwardOrigin) {
    const forwardName = buildForwardFromName(ctx.forwardOrigin);
    content = `Forwarded from ${forwardName}: ${content}`;
  }

  // Reply enrichment
  if (ctx.replyMessage) {
    const replyText = ctx.replyMessage.text || ctx.replyMessage.caption || "";
    const replyUser = ctx.replyMessage.from?.firstName || "User";
    content = `Reply to ${replyUser} («${replyText.slice(0, 100)}...»): ${content}`;
  }

  return content;
}

function buildForwardFromName(forwardOrigin: MessageContext["forwardOrigin"]): string {
  if (!forwardOrigin) return "Forwarded message";

  if (forwardOrigin.type === "user") {
    return forwardOrigin.senderUser?.firstName || "User";
  }
  if (forwardOrigin.type === "chat") {
    return forwardOrigin.senderChat?.title || "Chat";
  }
  return "Forwarded message";
}

export function buildForwardFromNameForDb(
  forwardOrigin: MessageContext["forwardOrigin"],
): string | null {
  if (!forwardOrigin) return null;

  if (forwardOrigin.type === "user") {
    return forwardOrigin.senderUser?.firstName || null;
  }
  if (forwardOrigin.type === "chat") {
    return forwardOrigin.senderChat?.title || null;
  }
  return null;
}

export interface SummaryArgs {
  type: string;
  count: number;
}

export function parseSummaryArgs(text: string): SummaryArgs {
  const args = text.split(" ").slice(1);
  const type = args[0] || "general";
  const count = Math.min(Number.parseInt(args[1] || "50", 10), 200);
  return { type, count };
}

export function parseSearchQuery(text: string): string {
  return text.split(" ").slice(1).join(" ");
}

export function parseAskQuestion(text: string): string {
  return text.split(" ").slice(1).join(" ");
}

export function formatChatStatsText(options: {
  chatName: string;
  total: number;
  percentage: string;
  earliest: string;
  latest: string;
}): string {
  return `• <b>${options.chatName}</b>: ${options.total} сообщений (${options.percentage}%)\n  с ${options.earliest} по ${options.latest}\n\n`;
}
