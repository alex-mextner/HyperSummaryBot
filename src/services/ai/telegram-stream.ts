import { Bot } from "gramio";
import {
  markdownToHtml,
  splitHtmlText,
  TG_MSG_LIMIT,
  sleep,
  ChatRateLimiter,
  isTelegramRateLimit,
  getRetryDelay,
  sanitizeTelegramHtml,
} from "../../utils/message-safety";

export class TelegramStreamWriter {
  private bot: Bot;
  private chatId: number;
  private messageId: number | null = null;
  private fullText = "";
  private toolLines: string[] = [];
  private pendingIndicators: string[] = [];
  private typingInterval: Timer | null = null;
  private flushPromise: Promise<void> = Promise.resolve();
  private rateLimiter: ChatRateLimiter;
  private isFinalized = false;

  constructor(bot: Bot, chatId: number) {
    this.bot = bot;
    this.chatId = chatId;
    this.rateLimiter = new ChatRateLimiter(1200);
    this.startTyping();
    this.initPlaceholder();
  }

  private async initPlaceholder() {
    try {
      const sendMessage = this.bot.api?.sendMessage;
      if (!sendMessage) return;
      const msg = await sendMessage({
        chat_id: this.chatId,
        text: "⏳",
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

  appendText(delta: string): void {
    this.fullText += delta;
    this.scheduleFlush(false);
  }

  replaceText(text: string): void {
    this.fullText = text;
    this.scheduleFlush(false);
  }

  setToolLabel(name: string, input?: Record<string, unknown>): void {
    const label = this.formatToolLabel(name, input);
    this.pendingIndicators.push(label);
    this.scheduleFlush(false);
  }

  markToolResult(success: boolean): void {
    const indicator = this.pendingIndicators.pop();
    if (indicator) {
      this.toolLines.push(`${success ? "✅" : "❌"} <i>${indicator}</i>`);
    }
    this.scheduleFlush(false);
  }

  private formatToolLabel(name: string, _input?: Record<string, unknown>): string {
    const labels: Record<string, string> = {
      get_summary: "Генерирую саммари",
      extract_notes: "Извлекаю заметки",
      search_messages: "Ищу сообщения",
      answer_question: "Анализирую вопрос",
    };
    return labels[name] || name;
  }

  private scheduleFlush(final: boolean) {
    this.flushPromise = this.flushPromise.then(() => this.flush(final));
  }

  private async flush(final: boolean): Promise<void> {
    if (this.isFinalized) return;

    const text = this.buildPlainText(final);
    if (!text) return;

    const editMessageText = this.bot.api?.editMessageText;
    const sendMessage = this.bot.api?.sendMessage;
    if (!editMessageText && !sendMessage) {
      console.warn("[stream] No Telegram API methods available");
      return;
    }

    // Rate limit: min 1.2s between edits to same chat
    await this.rateLimiter.wait(this.chatId);

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        if (this.messageId && editMessageText) {
          await editMessageText({
            chat_id: this.chatId,
            message_id: this.messageId,
            text,
          });
        } else if (sendMessage) {
          const msg = await sendMessage({
            chat_id: this.chatId,
            text,
          });
          this.messageId = msg.message_id;
        }
        return;
      } catch (error) {
        if (isTelegramRateLimit(error) && attempt < 4) {
          await sleep(getRetryDelay(attempt));
          continue;
        }
        if (
          error instanceof Error &&
          (error.message.includes("message is not modified") ||
            error.message.includes("MESSAGE_NOT_MODIFIED"))
        ) {
          return;
        }
        console.error("[stream] Edit failed:", error);
        return;
      }
    }
  }

  private buildPlainText(final: boolean): string {
    let processed = this.processThinkTags(this.fullText.trim());

    const limit = final ? TG_MSG_LIMIT : TG_MSG_LIMIT - 200;
    if (processed.length > limit) {
      processed = processed.slice(0, limit) + (final ? "" : " …");
    }

    if (!processed && this.toolLines.length === 0) return "⏳";

    let result = "";
    if (this.toolLines.length > 0) {
      result += `⚙️ Инструменты:\n${this.toolLines.join("\n")}\n\n`;
    }
    result += processed || "…";

    return result;
  }

  private processThinkTags(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  }

  async finalize(): Promise<void> {
    if (this.isFinalized) return;
    this.isFinalized = true;

    this.stopTyping();
    await this.flush(true);
    await this.sendFinalHtmlChunks();
  }

  private async sendFinalHtmlChunks(): Promise<void> {
    const plainText = this.buildPlainText(true);
    if (!plainText || plainText === "⏳") return;

    const html = markdownToHtml(plainText);
    const safeHtml = sanitizeTelegramHtml(html);
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
        // ignore delete failures
      }
      this.messageId = null;
    }

    if (!sendMessage) {
      console.warn("[stream] sendMessage not available, skipping final chunks");
      return;
    }

    for (const chunk of chunks) {
      await this.rateLimiter.wait(this.chatId);
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
            await sendMessage({
              chat_id: this.chatId,
              text: chunk,
            });
            break;
          }
          console.error("[stream] Failed to send final chunk:", error);
          break;
        }
      }
    }
  }

  async deleteMessage(): Promise<void> {
    this.stopTyping();
    if (!this.messageId) return;
    const deleteMessage = this.bot.api?.deleteMessage;
    if (!deleteMessage) return;
    try {
      await deleteMessage({
        chat_id: this.chatId,
        message_id: this.messageId,
      });
    } catch {
      // Ignore delete failures
    }
  }
}
