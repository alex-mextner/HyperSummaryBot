import { Bot } from "gramio";
import {
  closeUnclosedHtmlTags,
  markdownToHtml,
  sanitizeTelegramHtml,
  splitHtmlText,
  TG_MSG_LIMIT,
  sleep,
  ChatRateLimiter,
  isTelegramRateLimit,
  getRetryDelay,
} from "../../utils/message-safety";

/** HTML streaming writer for Telegram.
 *  Streams HTML directly — AI outputs <b>, <i>, <a> tags live.
 *  On every flush: closes unclosed tags so Telegram accepts the edit,
 *  then continues streaming inside the same tags on next flush.
 *  Adaptive rate limiting: starts fast, backs off on 429. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** HTML streaming writer for Telegram.
 *  Streams HTML directly — AI outputs <b>, <i>, <a> tags live.
 *  On every flush: closes unclosed tags so Telegram accepts the edit,
 *  then continues streaming inside the same tags on next flush.
 *  Adaptive rate limiting: starts fast, backs off on 429.
 *  Animated placeholder spinner while waiting for AI output. */
export class TelegramStreamWriter {
  private bot: Bot;
  private chatId: number;
  private messageId: number | null = null;

  private buffer = "";
  private lastSentText = "";
  private lastEditTime = 0;
  private baseIntervalMs = 180;
  private currentIntervalMs = 180;
  private consecutiveErrors = 0;

  private flushTimer: Timer | null = null;
  private typingInterval: Timer | null = null;
  private spinnerTimer: Timer | null = null;
  private isFinalized = false;
  private placeholderText: string;
  private spinnerFrame = 0;
  private hasRealContent = false;

  /** IDs of messages sent as live chunks (> limit). Tracked so they can be
   *  deleted when the text is replaced with the final version. */
  private sentMessageIds: number[] = [];

  /** Number of chars from the buffer already committed as live messages.
   *  The full buffer is kept intact so finalize() can send the complete text. */
  private liveOffset = 0;

  constructor(bot: Bot, chatId: number, placeholderText = "⏳") {
    this.bot = bot;
    this.chatId = chatId;
    this.placeholderText = placeholderText;
    this.startTyping();
    this.initPlaceholder();
    this.startSpinner();
  }

  private async initPlaceholder() {
    try {
      const sendMessage = this.bot.api?.sendMessage;
      if (!sendMessage) return;
      const msg = await sendMessage({
        chat_id: this.chatId,
        text: this.placeholderText,
        parse_mode: "HTML",
      });
      this.messageId = msg.message_id;
    } catch {
      // Silently fail, will send message on first flush
    }
  }

  private startTyping() {
    const sendChatAction = this.bot.api?.sendChatAction;
    if (!sendChatAction) return;
    this.typingInterval = setInterval(() => {
      sendChatAction({ chat_id: this.chatId, action: "typing" }).catch(() => {});
    }, 4000);
  }

  private stopTyping() {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }

  /** Animate placeholder with spinner until real AI content arrives. */
  private startSpinner() {
    const editMessageText = this.bot.api?.editMessageText;
    if (!editMessageText) return;
    this.spinnerTimer = setInterval(async () => {
      if (this.isFinalized || this.hasRealContent || !this.messageId) return;
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      try {
        await editMessageText({
          chat_id: this.chatId,
          message_id: this.messageId,
          text: `${this.placeholderText} ${SPINNER_FRAMES[this.spinnerFrame]}`,
          parse_mode: "HTML",
        });
      } catch {
        // ignore edit failures during spinner
      }
    }, 250);
  }

  private stopSpinner() {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  /** Append delta (chars / HTML tags) to the streaming buffer. */
  appendText(delta: string): void {
    if (this.isFinalized) return;
    if (!this.hasRealContent && delta.trim()) {
      this.hasRealContent = true;
      this.stopSpinner();
    }
    this.buffer += delta;
    this.scheduleFlush();
  }

  /** Replace entire buffer (used for review phase rewrite).
   *  Deletes any previously sent live chunks so stale drafts don't linger. */
  replaceText(text: string): void {
    if (this.isFinalized) return;
    if (this.sentMessageIds.length > 0) {
      const ids = [...this.sentMessageIds];
      this.sentMessageIds = [];
      this.deleteChunkMessages(ids).catch(() => {});
    }
    this.buffer = text;
    this.liveOffset = 0;
    this.lastSentText = ""; // force re-send, previous draft is irrelevant
    this.scheduleFlush();
  }

  private async deleteChunkMessages(ids: number[]): Promise<void> {
    const deleteMessage = this.bot.api?.deleteMessage;
    if (!deleteMessage) return;
    for (const id of ids) {
      try {
        await deleteMessage({ chat_id: this.chatId, message_id: id });
      } catch {
        // ignore
      }
    }
  }

  /** Add an inline fact-check indicator into the buffer. */
  addFactCheckIndicator(
    label: string,
    status: "checking" | "verified" | "corrected" | "removed",
  ): void {
    const emoji = { checking: "🔍", verified: "✅", corrected: "📝", removed: "🗑️" };
    this.buffer += `\n${emoji[status]} ${label}`;
    this.scheduleFlush();
  }

  /** Push a tool-call indicator line (shown during streaming). */
  setToolLabel(name: string, _input?: Record<string, unknown>): void {
    const labels: Record<string, string> = {
      get_summary: "Генерирую саммари",
      extract_notes: "Извлекаю заметки",
      search_messages: "Ищу сообщения",
      answer_question: "Анализирую вопрос",
    };
    this.buffer += `\n⚙️ ${labels[name] || name}…`;
    this.scheduleFlush();
  }

  /** Mark the last tool indicator as done or failed. */
  markToolResult(success: boolean): void {
    // Replace the last "…" with result emoji
    if (this.buffer.endsWith("…")) {
      this.buffer = this.buffer.slice(0, -1) + (success ? " ✅" : " ❌");
      this.scheduleFlush();
    }
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    const now = Date.now();
    const delay = Math.max(0, this.currentIntervalMs - (now - this.lastEditTime));
    this.flushTimer = setTimeout(() => this.flush(), delay);
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    if (this.isFinalized) return;

    const rawText = this.buildSafeHtml();
    if (!rawText || rawText === this.lastSentText) return;

    const remaining = rawText.slice(this.liveOffset);

    // If uncommitted portion exceeds limit, commit a chunk as a live message.
    // The full buffer is kept intact — only liveOffset advances.
    if (remaining.length > TG_MSG_LIMIT) {
      let splitPoint = TG_MSG_LIMIT;
      for (let i = TG_MSG_LIMIT; i > TG_MSG_LIMIT * 0.5; i--) {
        if (remaining[i] === "\n" && remaining[i + 1] === "\n") {
          splitPoint = i;
          break;
        }
        if (remaining[i] === "\n" && splitPoint === TG_MSG_LIMIT) {
          splitPoint = i;
        }
      }
      if (splitPoint === TG_MSG_LIMIT) {
        const spaceIdx = remaining.lastIndexOf(" ", TG_MSG_LIMIT);
        if (spaceIdx > TG_MSG_LIMIT * 0.5) splitPoint = spaceIdx;
      }

      const chunk = remaining.slice(0, splitPoint);
      const closedChunk = closeUnclosedHtmlTags(chunk);

      const sendMessage = this.bot.api?.sendMessage;
      if (sendMessage) {
        try {
          const msg = await sendMessage({
            chat_id: this.chatId,
            text: closedChunk,
            parse_mode: "HTML",
          });
          this.sentMessageIds.push(msg.message_id);
          this.liveOffset += chunk.length;
          this.lastSentText = rawText; // mark this version as sent
          this.messageId = null; // next uncommitted portion creates a new placeholder
          this.lastEditTime = Date.now();
          this.onSuccess();
        } catch (err) {
          this.onError(err);
        }
      }
      return;
    }

    // Normal path: close tags and edit the existing placeholder message
    const text = closeUnclosedHtmlTags(remaining);

    const editMessageText = this.bot.api?.editMessageText;
    if (!editMessageText || !this.messageId) {
      const sendMessage = this.bot.api?.sendMessage;
      if (sendMessage) {
        try {
          const msg = await sendMessage({
            chat_id: this.chatId,
            text,
            parse_mode: "HTML",
          });
          this.messageId = msg.message_id;
          this.lastSentText = rawText;
          this.lastEditTime = Date.now();
          this.onSuccess();
        } catch (err) {
          this.onError(err);
        }
      }
      return;
    }

    try {
      await editMessageText({
        chat_id: this.chatId,
        message_id: this.messageId,
        text,
        parse_mode: "HTML",
      });
      this.lastSentText = rawText;
      this.lastEditTime = Date.now();
      this.onSuccess();
    } catch (err) {
      this.onError(err);
      if (isTelegramRateLimit(err)) {
        await sleep(getRetryDelay(this.consecutiveErrors, 500));
        this.scheduleFlush();
      }
    }
  }

  private onSuccess() {
    this.consecutiveErrors = 0;
    this.currentIntervalMs = Math.max(this.baseIntervalMs, this.currentIntervalMs - 20);
  }

  private onError(err: unknown) {
    if (isTelegramRateLimit(err)) {
      this.consecutiveErrors++;
      this.currentIntervalMs = Math.min(1500, this.currentIntervalMs + 100);
    } else if (
      err instanceof Error &&
      (err.message.includes("message is not modified") ||
        err.message.includes("MESSAGE_NOT_MODIFIED"))
    ) {
      // not an error
    } else {
      console.error("[stream] Edit failed:", err);
    }
  }

  /** Build safe HTML for live editing.
   *  Strips  think blocks, runs markdown→HTML (AI sometimes mixes markdown
   *  into HTML output). Does NOT close tags or truncate — flush() handles that. */
  private buildSafeHtml(): string {
    let text = this.buffer.trim();
    if (!text) return this.placeholderText;

    // Remove think tags (some models emit reasoning in  think blocks)
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    // AI occasionally outputs markdown syntax (# headings, **bold**, etc.)
    // even when instructed to use HTML only. Normalize it.
    text = markdownToHtml(text);

    return text;
  }

  async finalize(): Promise<void> {
    if (this.isFinalized) return;
    this.isFinalized = true;
    this.stopTyping();
    this.stopSpinner();
    this.stopFlushTimer();

    console.log(`[stream] Finalizing message ${this.messageId} — text=${this.buffer.length} chars`);

    // Final flush of any remaining buffer
    await this.flush();

    // Delete any live chunks that are still lingering before sending the final version
    if (this.sentMessageIds.length > 0) {
      const ids = [...this.sentMessageIds];
      this.sentMessageIds = [];
      await this.deleteChunkMessages(ids);
    }

    // Reset offset so the final send sees the full buffer, not just the remainder
    this.liveOffset = 0;

    // Sanitize and chunk the final HTML
    await this.sendFinalHtml();
    console.log(`[stream] Finalize complete for chat ${this.chatId}`);
  }

  private async sendFinalHtml(): Promise<void> {
    const text = this.buffer.trim();
    if (!text || text === this.placeholderText) {
      console.warn("[stream] sendFinalHtml: empty or placeholder text, skipping");
      return;
    }

    // Sanitize (strip non-allowed tags). We do NOT close tags here — splitHtmlText
    // will close them per-chunk so tag state stays correct across boundaries.
    let safeHtml = sanitizeTelegramHtml(text);
    const chunks = splitHtmlText(safeHtml, TG_MSG_LIMIT);
    console.log(
      `[stream] sendFinalHtml: ${text.length} chars → ${chunks.length} chunk(s), lengths=[${chunks.map((c) => c.length).join(", ")}]`,
    );

    const deleteMessage = this.bot.api?.deleteMessage;
    const sendMessage = this.bot.api?.sendMessage;

    if (this.messageId && deleteMessage) {
      try {
        await deleteMessage({
          chat_id: this.chatId,
          message_id: this.messageId,
        });
        console.log(`[stream] Deleted placeholder ${this.messageId}`);
      } catch {
        // ignore
      }
      this.messageId = null;
    }

    if (!sendMessage) {
      console.warn("[stream] sendMessage not available, skipping final chunks");
      return;
    }

    const rateLimiter = new ChatRateLimiter(350);
    let sentCount = 0;
    for (const chunk of chunks) {
      await rateLimiter.wait(this.chatId);
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await sendMessage({
            chat_id: this.chatId,
            text: chunk,
            parse_mode: "HTML",
          });
          sentCount++;
          break;
        } catch (error) {
          if (isTelegramRateLimit(error) && attempt < 4) {
            await sleep(getRetryDelay(attempt));
            continue;
          }
          if (error instanceof Error && error.message.includes("parse")) {
            console.warn(`[stream] Parse error on chunk ${sentCount + 1}, sending as plain text`);
            await sendMessage({ chat_id: this.chatId, text: chunk });
            sentCount++;
            break;
          }
          console.error(
            `[stream] Failed to send final chunk ${sentCount + 1}/${chunks.length}:`,
            error,
          );
          break;
        }
      }
    }
    console.log(`[stream] sendFinalHtml sent ${sentCount}/${chunks.length} chunks`);
  }

  private stopFlushTimer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  async deleteMessage(): Promise<void> {
    this.stopTyping();
    this.stopSpinner();
    this.stopFlushTimer();
    if (!this.messageId) return;
    const deleteMessage = this.bot.api?.deleteMessage;
    if (!deleteMessage) return;
    try {
      await deleteMessage({
        chat_id: this.chatId,
        message_id: this.messageId,
      });
    } catch {
      // Ignore
    }
  }
}
