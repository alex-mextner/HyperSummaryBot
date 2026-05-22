import { Bot } from "gramio";

export class TelegramStreamWriter {
  private bot: Bot;
  private chatId: number;
  private messageId: number | null = null;
  private fullText = "";
  private toolLines: string[] = [];
  private pendingIndicators: string[] = [];
  private typingInterval: Timer | null = null;
  private flushPromise: Promise<void> = Promise.resolve();

  constructor(bot: Bot, chatId: number) {
    this.bot = bot;
    this.chatId = chatId;
    this.startTyping();
    this.initPlaceholder();
  }

  private async initPlaceholder() {
    try {
      const msg = await this.bot.api.sendMessage({
        chat_id: this.chatId,
        text: "⏳...",
      });
      this.messageId = msg.message_id;
    } catch {
      // Silently fail, will send message on first flush
    }
  }

  private startTyping() {
    this.typingInterval = setInterval(() => {
      this.bot.api.sendChatAction({ chat_id: this.chatId, action: "typing" }).catch(() => {});
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

  private formatToolLabel(name: string, input?: Record<string, unknown>): string {
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
    const text = this.buildText(final);
    if (!text) return;

    try {
      if (this.messageId) {
        await this.bot.api.editMessageText({
          chat_id: this.chatId,
          message_id: this.messageId,
          text,
          parse_mode: "HTML",
        });
      } else {
        const msg = await this.bot.api.sendMessage({
          chat_id: this.chatId,
          text,
          parse_mode: "HTML",
        });
        this.messageId = msg.message_id;
      }
    } catch (error) {
      // Rate limit or message not modified
      if (error instanceof Error && error.message.includes("rate limit")) {
        await new Promise((r) => setTimeout(r, 1000));
        this.scheduleFlush(final);
      }
    }
  }

  private buildText(final: boolean): string {
    const processed = this.processThinkTags(this.fullText.trim());
    if (!processed && this.toolLines.length === 0) return "⏳...";

    let result = "";
    if (this.toolLines.length > 0) {
      result += `<blockquote expandable>⚙️ <b>Инструменты</b>\n${this.toolLines.join("\n")}</blockquote>\n\n`;
    }
    result += processed || "...";

    return result;
  }

  private processThinkTags(text: string): string {
    // Remove <think>...</think> sections
    return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  }

  async finalize(): Promise<void> {
    this.stopTyping();
    await this.flush(true);
    await this.sendRemainingChunks();
  }

  private async sendRemainingChunks(): Promise<void> {
    const text = this.buildText(true);
    if (!text || text.length <= 4000) return;

    const chunks = this.splitIntoChunks(text, 4000);
    for (let i = 1; i < chunks.length; i++) {
      await this.bot.api.sendMessage({
        chat_id: this.chatId,
        text: chunks[i]!,
        parse_mode: "HTML",
      });
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private splitIntoChunks(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxLength) {
      let splitIndex = remaining.lastIndexOf("\n", maxLength);
      if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", maxLength);
      if (splitIndex === -1) splitIndex = maxLength;
      chunks.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }

  async deleteMessage(): Promise<void> {
    if (!this.messageId) return;
    try {
      await this.bot.api.deleteMessage({
        chat_id: this.chatId,
        message_id: this.messageId,
      });
    } catch {
      // Ignore delete failures
    }
  }
}
