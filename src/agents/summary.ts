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

const DRAFT_SYSTEM_PROMPT = `Ты — ассистент для анализа групповых чатов. Создай максимально подробное комбинированное саммари.

ИМЕНА:
- Используй ТОЛЬКО имена из сообщений. НИКОГДА не пиши "участник", "пользователь", "user", "человек"
- Если имя неизвестно — используй "@ник" или перефразируй без имени

КОНКРЕТИКА (запрещено → как надо):
- "разбить в указанном месте" → "разбить палатки у домиков по ссылке"
- "участники начинают сбрасывать деньги" → "@Вася скинул 1500₽, @Марина — 2900₽ за еду в Макдональдсе"
- "сообщение о трате" → "@Марина написала, что потратила 2900₽ в Макдональдсе"
- "обсуждали варианты" → "@Вася предложил X, @Марина — Y"
- Каждый факт приписан конкретному человеку по имени

ФОРМАТИРОВАНИЕ — ТОЛЬКО Telegram HTML (никакого markdown!):
- Жирный: <b>текст</b>
- Курсив: <i>текст</i>
- Зачёркнутый: <s>текст</s>
- Ссылка: <a href="https://...">текст</a>
- Цитата: <blockquote>текст</blockquote>
- Код: <code>текст</code>
- Спойлер: <span class="tg-spoiler">текст</span>
- НЕ используй markdown
- НЕ придумывай фактов — только из сообщений
- Если нет информации — напиши "Не обсуждалось"
- Язык: русский`;

const REVIEW_SYSTEM_PROMPT = `Ты — редактор саммари. Проверь черновик и выдай финальную версию.

ПРОВЕРЬ:
1. Есть ли расплывчатые формулировки ("указанном месте", "начинают", "обсуждали")?
   Замени на конкретных людей, факты, цифры, ссылки.
2. Есть ли противоречия в сообщениях? (один сказал X, другой — не-X)
   Отрази обе точки зрения или уточни, что решение не принято.
3. Все ли факты подтверждены цитатами? Убери додуманное.
4. Каждый факт приписан конкретному человеку по имени?
5. Нет ли markdown (#, **, __)? Замени на HTML теги.

Выдай ТОЛЬКО финальный текст. Не пиши "Исправлено:" или комментарии.`;

async function generateDraft(
  formattedMessages: string,
  callbacks: { onTextDelta?: (text: string) => void },
): Promise<string> {
  const result = await aiStreamRound(
    {
      messages: [
        { role: "system", content: DRAFT_SYSTEM_PROMPT },
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
        { role: "system", content: DRAFT_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Проанализируй сообщения и создай подробное комбинированное саммари.\n\n${formattedMessages}`,
        },
        { role: "assistant", content: draft },
        { role: "user", content: REVIEW_SYSTEM_PROMPT },
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
    // Phase 1: Draft with streaming (user sees live text)
    const draft = await generateDraft(formattedMessages, {
      onTextDelta: (text) => writer.appendText(text),
    });

    // Phase 2: Review and refine (silent)
    writer.appendText("\n\n[проверка фактов…]");
    let final: string;
    try {
      final = await reviewAndRefine(draft, formattedMessages);
    } catch (reviewError) {
      console.warn("[summary] Review phase failed, falling back to draft:", reviewError);
      final = draft;
    }

    // Post-process: clean up attributions
    final = sanitizeAttributions(final, lookup);

    // Safety: force-replace any remaining raw IDs
    const knownIds = Array.from(lookup.names.keys());
    if (containsRawUserIds(final, knownIds)) {
      console.warn("[summary] Raw IDs in output, forcing replacement");
      for (const [userId, name] of lookup.names) {
        final = final.replace(new RegExp(`\\b${userId}\\b`, "g"), name);
      }
    }

    // Replace streamed draft with refined final version
    writer.replaceText(final);

    await writer.finalize();
    return final;
  } catch (error) {
    await writer.deleteMessage();
    throw error;
  }
}
