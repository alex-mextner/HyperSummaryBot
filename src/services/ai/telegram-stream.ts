import { Bot } from "gramio";
import {
  closeUnclosedHtmlTags,
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

  /** Replace entire buffer (used for review phase rewrite). */
  replaceText(text: string): void {
    if (this.isFinalized) return;
    this.buffer = text;
    this.scheduleFlush();
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

    const text = this.buildSafeHtml();
    if (!text || text === this.lastSentText) return;

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
          this.lastSentText = text;
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
      this.lastSentText = text;
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
   *  Removes <think> blocks, closes any unclosed tags so Telegram accepts the edit.
   *  The raw buffer stays unchanged — AI continues inside open tags. */
  private buildSafeHtml(): string {
    let text = this.buffer.trim();
    if (!text) return this.placeholderText;

    // Remove think tags (some models emit reasoning in <think>…</think>)
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    // Hard cap during streaming (leave headroom for closing tags)
    if (text.length > TG_MSG_LIMIT - 200) {
      text = text.slice(0, TG_MSG_LIMIT - 203) + "...";
    }

    // Close unclosed tags before sending to Telegram
    return closeUnclosedHtmlTags(text);
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

    // Sanitize and chunk the final HTML
    await this.sendFinalHtml();
    console.log(`[stream] Finalize complete for chat ${this.chatId}`);
  }

  private async sendFinalHtml(): Promise<void> {
    const text = this.buffer.trim();
    if (!text || text === this.placeholderText) return;

    // Sanitize (strip non-allowed tags), close any remaining unclosed tags, chunk
    let safeHtml = sanitizeTelegramHtml(text);
    safeHtml = closeUnclosedHtmlTags(safeHtml);
    const chunks = splitHtmlText(safeHtml, TG_MSG_LIMIT);

    const deleteMessage = this.bot.api?.deleteMessage;
    const sendMessage = this.bot.api?.sendMessage;

    if (this.messageId && deleteMessage) {
      try {
        await deleteMessage({
          chat_id: this.chatId,
          message_id: this.messageId,
        });
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
    for (const chunk of chunks) {
      await rateLimiter.wait(this.chatId);
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await sendMessage({
            chat_id: this.chatId,
            text: chunk,
            parse_mode: "HTML",
          });
          break;
        } catch (error) {
          if (isTelegramRateLimit(error) && attempt < 4) {
            await sleep(getRetryDelay(attempt));
            continue;
          }
          if (error instanceof Error && error.message.includes("parse")) {
            await sendMessage({ chat_id: this.chatId, text: chunk });
            break;
          }
          console.error("[stream] Failed to send final chunk:", error);
          break;
        }
      }
    }
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
