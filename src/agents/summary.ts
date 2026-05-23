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

ПРАВИЛА ИМЁН:
- Используй ТОЛЬКО имена из справочника участников в конце сообщений
- НИКОГДА не используй числовые ID (716928723) в тексте
- НИКОГДА не пиши "участник", "пользователь", "user" — всегда конкретное имя или @ник
- Если имя неизвестно — используй @ник или "человек с ником X"

ПРАВИЛА КОНКРЕТИКИ:
- Запрещено: "разбить в указанном месте" → пиши конкретно: "разбить палатки у домиков по ссылке [url]"
- Запрещено: "участники начинают сбрасывать деньги" → пиши: "Алекс сбросил 1500₽, Марина — 2900₽ за еду в Макдональдсе"
- Запрещено: "гибридное размещение" → пиши: "палатки + домики по ссылке, обсуждали удобство каждого"
- Запрещено: "сообщение о трате" → пиши: "Марина написала, что потратила 2900₽ в Макдональдсе"
- Каждый факт должен быть приписан конкретному человеку по имени

ФОРМАТИРОВАНИЕ:
- Используй markdown: заголовки, списки, **жирный текст**
- Для action items используй markdown-таблицу
- Не придумывай фактов — только из предоставленных сообщений
- Если чего-то нет — честно напиши "Не обсуждалось"
- Язык: русский`;

const REVIEW_PROMPT = `Ты — редактор саммари. Проверь текст на ошибки и неточности.

Проверь каждый пункт:
1. Есть ли сырые числовые ID? Если да — замени на имена из справочника
2. Есть ли безликие формулировки ("участники", "указанном месте", "начинают")? Замени на конкретных людей и факты
3. Каждый факт приписан конкретному человеку по имени?
4. Есть ли противоречия? (например, один говорит "да", другой "нет" на тот же вопрос)
5. Всё ли выводы подтверждены цитатами из сообщений?

Выдай ИСПРАВЛЕННУЮ версию полностью. Не комментарии — только финальный текст.`;

async function generateDraft(
  formattedMessages: string,
  callbacks: { onTextDelta?: (text: string) => void },
): Promise<string> {
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
    callbacks,
  );
  return result.text;
}

async function reviewAndRefine(draft: string, formattedMessages: string): Promise<string> {
  const result = await aiStreamRound(
    {
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Проанализируй сообщения и создай подробное комбинированное саммари.\n\n${formattedMessages}`,
        },
        { role: "assistant", content: draft },
        { role: "user", content: REVIEW_PROMPT },
      ],
      maxTokens: 4096,
      temperature: 0.2,
    },
    {},
  );
  return result.text;
}

export async function generateSummary(options: SummaryAgentOptions): Promise<string> {
  const writer = new TelegramStreamWriter(options.bot, options.chatId);

  const { text: formattedMessages, lookup } = formatMessagesForPrompt(options.messages);

  try {
    // Phase 1: Generate draft with streaming (user sees live text)
    const draft = await generateDraft(formattedMessages, {
      onTextDelta: (text) => writer.appendText(text),
    });

    // Phase 2: Review and refine (silent, no streaming)
    writer.appendText("\n\n[проверка фактов…]");
    let final = await reviewAndRefine(draft, formattedMessages);

    // Sanitize any remaining ID leaks
    final = sanitizeAttributions(final, lookup);

    // Safety check
    const knownIds = Array.from(lookup.names.keys());
    if (containsRawUserIds(final, knownIds)) {
      console.warn("[summary] Raw user IDs still present after sanitization");
    }

    // Replace the streamed draft with the refined final version
    writer.replaceText(final);

    await writer.finalize();
    return final;
  } catch (error) {
    await writer.deleteMessage();
    throw error;
  }
}
