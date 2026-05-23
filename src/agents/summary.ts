import { aiStreamRound } from "../services/ai/streaming";
import { TelegramStreamWriter } from "../services/ai/telegram-stream";
import {
  formatMessagesForPrompt,
  containsRawUserIds,
  sanitizeAttributions,
} from "../utils/message-formatter";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBot = any;

interface SummaryAgentOptions {
  chatId: number;
  messages: Array<{ userId: number; userName: string | null; content: string }>;
  bot: AnyBot;
}

const SUMMARY_SYSTEM_PROMPT = `Ты — ассистент для анализа групповых чатов. Создай максимально подробное комбинированное саммари.

САМОЕ ВАЖНОЕ — ИМЕНА:
- В начале сообщений тебе дадут справочник: "123456 → @Вася"
- Ты ДОЛЖЕН использовать ТОЛЬКО имя справа от стрелки (@Вася)
- НИКОГДА не используй числовые ID (123456) в ответе
- НИКОГДА не пиши "участник", "пользователь", "user", "человек"
- Если имя неизвестно — используй "@ник" или перефразируй без имени

КОНКРЕТИКА (запрещено → как надо):
- "разбить в указанном месте" → "разбить палатки у домиков по ссылке maps.app.goo.gl/..."
- "участники начинают сбрасывать деньги" → "@Вася скинул 1500₽, @Марина — 2900₽ за еду в Макдональдсе"
- "сообщение о трате" → "@Марина написала, что потратила 2900₽ в Макдональдсе"
- "обсуждали варианты" → "@Вася предложил X, @Марина — Y"
- Каждый факт приписан конкретному человеку по имени

ФОРМАТ:
- Markdown: заголовки, списки, **жирный текст**
- Таблицы допустимы для action items (markdown-синтаксис)
- Не придумывай фактов — только из сообщений
- Если нет информации — напиши "Не обсуждалось"
- Язык: русский`;

export async function generateSummary(options: SummaryAgentOptions): Promise<string> {
  const writer = new TelegramStreamWriter(options.bot, options.chatId);

  const { text: formattedMessages, lookup } = formatMessagesForPrompt(options.messages);

  try {
    // Single-phase: generate and stream directly
    const result = await aiStreamRound(
      {
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Проанализируй сообщения и создай подробное комбинированное саммари.\n\n${formattedMessages}`,
          },
        ],
        maxTokens: 4096,
        temperature: 0.3,
      },
      {
        onTextDelta: (text) => writer.appendText(text),
      },
    );

    let final = sanitizeAttributions(result.text, lookup);

    // Post-process: if raw IDs still present, do a quick replacement
    const knownIds = Array.from(lookup.names.keys());
    if (containsRawUserIds(final, knownIds)) {
      console.warn("[summary] Raw IDs in output, forcing replacement");
      for (const [userId, name] of lookup.names) {
        final = final.replace(new RegExp(`\\b${userId}\\b`, "g"), name);
      }
    }

    // Replace streamed text with cleaned version for final HTML rendering
    writer.replaceText(final);

    await writer.finalize();
    return final;
  } catch (error) {
    await writer.deleteMessage();
    throw error;
  }
}
