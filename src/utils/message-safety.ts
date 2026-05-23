/** Message sending safety utilities — HTML tag closing, chunking, rate limiting. */

// Telegram message limit (keeping 96 chars buffer for safety)
export const TG_MSG_LIMIT = 4000;

// Void / self-closing HTML tags that don't need closing
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Close any unclosed HTML tags at the end of a string. */
export function closeUnclosedHtmlTags(html: string): string {
  const openTags: string[] = [];
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*?>/g;
  let match;

  while ((match = tagRegex.exec(html)) !== null) {
    const fullTag = match[0];
    const tagName = match[1]!.toLowerCase();

    if (fullTag.startsWith("</")) {
      // Closing tag: remove matching open tag (last occurrence)
      const idx = openTags.lastIndexOf(tagName);
      if (idx !== -1) openTags.splice(idx, 1);
    } else if (!fullTag.endsWith("/>") && !VOID_TAGS.has(tagName)) {
      // Opening tag (not self-closing, not void)
      openTags.push(tagName);
    }
  }

  // Close tags in reverse order (LIFO)
  return (
    html +
    openTags
      .reverse()
      .map((t) => `</${t}>`)
      .join("")
  );
}

/** Split HTML text into chunks under maxLength, closing tags per chunk.
 *  Splits at paragraph boundaries (\n\n) or line boundaries when possible. */
export function splitHtmlText(html: string, maxLength: number = TG_MSG_LIMIT): string[] {
  const chunks: string[] = [];
  let remaining = html;

  while (remaining.length > maxLength) {
    let splitPoint = maxLength;

    // Walk backward looking for a good boundary
    for (let i = maxLength; i > maxLength * 0.6; i--) {
      // Prefer paragraph boundary
      if (remaining[i] === "\n" && remaining[i + 1] === "\n") {
        splitPoint = i;
        break;
      }
      // Then line boundary
      if (remaining[i] === "\n" && splitPoint === maxLength) {
        splitPoint = i;
      }
    }

    // If still no good boundary, look for space
    if (splitPoint === maxLength) {
      const spaceIdx = remaining.lastIndexOf(" ", maxLength);
      if (spaceIdx > maxLength * 0.6) {
        splitPoint = spaceIdx;
      }
    }

    const chunk = remaining.slice(0, splitPoint).trimEnd();
    chunks.push(closeUnclosedHtmlTags(chunk));
    remaining = remaining.slice(splitPoint).trimStart();
  }

  if (remaining) {
    chunks.push(closeUnclosedHtmlTags(remaining));
  }

  return chunks;
}

/** Basic markdown → Telegram HTML conversion. */
export function markdownToHtml(text: string): string {
  let html = text;

  // Escape raw HTML first (but preserve our own tags)
  html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Code blocks
  html = html.replace(/```([\s\S]*?)```/g, "<pre>$1</pre>");

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  html = html.replace(/__([^_]+)__/g, "<b>$1</b>");

  // Italic
  html = html.replace(/\*([^*]+)\*/g, "<i>$1</i>");
  html = html.replace(/_([^_]+)_/g, "<i>$1</i>");

  // Strikethrough
  html = html.replace(/~~([^~]+)~~/g, "<s>$1</s>");

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Headings
  html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Bullet lists
  html = html.replace(/^[-*]\s+(.+)$/gm, "• $1");

  // Numbered lists
  html = html.replace(/^\d+\.\s+(.+)$/gm, "$1");

  return html;
}

/** Rate limiter for per-chat Telegram API calls. */
export class ChatRateLimiter {
  private lastSendTime = new Map<number, number>();
  private minIntervalMs: number;

  constructor(minIntervalMs: number = 1500) {
    this.minIntervalMs = minIntervalMs;
  }

  async wait(chatId: number): Promise<void> {
    const now = Date.now();
    const last = this.lastSendTime.get(chatId) ?? 0;
    const delta = now - last;
    if (delta < this.minIntervalMs) {
      await sleep(this.minIntervalMs - delta);
    }
    this.lastSendTime.set(chatId, Date.now());
  }
}

/** Exponential backoff delay for Telegram 429 errors. */
export function getRetryDelay(attempt: number, baseMs: number = 1000): number {
  return Math.min(baseMs * 2 ** attempt, 30000);
}

/** Simple sleep helper. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Check if a Telegram error is a rate limit (429 / RetryAfter). */
export function isTelegramRateLimit(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("retry after") ||
    msg.includes("too many requests") ||
    msg.includes("rate limit") ||
    msg.includes("flood") ||
    msg.includes("429")
  );
}

/** Send a message safely: chunk if too long, handle rate limits, close HTML tags. */
export async function safeSendMessage(
  bot: any,
  chatId: number,
  text: string,
  options: { parseMode?: "HTML" | "MarkdownV2"; rateLimiter?: ChatRateLimiter } = {},
): Promise<void> {
  const limiter = options.rateLimiter ?? new ChatRateLimiter();
  let content = text;

  // Convert markdown to HTML if using HTML parse mode
  if (options.parseMode === "HTML") {
    content = markdownToHtml(content);
  }

  const chunks =
    options.parseMode === "HTML"
      ? splitHtmlText(content, TG_MSG_LIMIT)
      : splitPlainText(content, TG_MSG_LIMIT);

  for (const chunk of chunks) {
    await limiter.wait(chatId);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await bot.api.sendMessage({
          chat_id: chatId,
          text: chunk,
          parse_mode: options.parseMode,
        });
        break;
      } catch (err) {
        if (isTelegramRateLimit(err) && attempt < 4) {
          await sleep(getRetryDelay(attempt));
          continue;
        }
        throw err;
      }
    }
  }
}

/** Split plain text into chunks at natural boundaries. */
function splitPlainText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitPoint = maxLength;

    // Walk backward for paragraph / line / word boundary
    for (let i = maxLength; i > maxLength * 0.6; i--) {
      if (remaining[i] === "\n" && remaining[i + 1] === "\n") {
        splitPoint = i;
        break;
      }
      if (remaining[i] === "\n" && splitPoint === maxLength) {
        splitPoint = i;
      }
    }
    if (splitPoint === maxLength) {
      const spaceIdx = remaining.lastIndexOf(" ", maxLength);
      if (spaceIdx > maxLength * 0.6) splitPoint = spaceIdx;
    }

    chunks.push(remaining.slice(0, splitPoint).trimEnd());
    remaining = remaining.slice(splitPoint).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
