import { aiStreamRound } from "../services/ai/streaming";
import { TelegramStreamWriter } from "../services/ai/telegram-stream";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBot = any;

interface SummaryAgentOptions {
  chatId: number;
  messages: Array<{ userName: string | null; content: string }>;
  bot: AnyBot;
}

const COMBINED_SUMMARY_PROMPT = `Ты — ассистент для анализа групповых чатов. Создай максимально подробное комбинированное саммари.

Обязательно охвати ВСЕ эти аспекты:

1. 📋 ОБЩАЯ КАРТИНА
   - Краткий обзор обсуждения: о чём говорили, какие темы
   - Общее настроение и динамика (конструктивно, спорно, расслабленно)
   - Ключевые участники и их роли в дискуссии

2. ✅ РЕШЕНИЯ И ДОГОВОРЁННОСТИ
   - Все принятые решения, соглашения, планы
   - Кто за что отвечает (если назначали)
   - Сроки и дедлайны (если обсуждали)

3. ❓ ОТКРЫТЫЕ ВОПРОСЫ
   - Вопросы, на которые не ответили
   - Темы, которые требуют продолжения

4. 📌 ACTION ITEMS
   - Конкретные задачи и todo
   - Ответственные и сроки

5. 🔗 РЕСУРСЫ И ССЫЛКИ
   - Полезные ссылки, инструменты, книги, файлы
   - Контакты и рекомендации

6. ⚡ НОВОСТИ И АПДЕЙТЫ
   - Важные анонсы и объявления
   - Что изменилось

7. 💬 АКТИВНЫЕ ДИСКУССИИ
   - Спорные моменты, разные точки зрения
   - Аргументы сторон
   - Была ли достигнута договорённость

8. 🎯 ГЛАВНЫЕ ВЫВОДЫ
   - 3-5 ключевых инсайтов или фактов
   - Что стало ясно из обсуждения

Правила форматирования:
- Используй markdown: заголовки, списки, жирный текст
- Указывай авторов сообщений при цитировании
- Не придумывай фактов — только из предоставленных сообщений
- Если какого-то аспекта нет в сообщениях — честно напиши "Не обсуждалось"
- Язык: русский (или язык чата, если большинство сообщений на другом)`;

export async function generateSummary(options: SummaryAgentOptions): Promise<string> {
  const writer = new TelegramStreamWriter(options.bot, options.chatId);

  const formattedMessages = options.messages
    .map((m) => `${m.userName || "User"}: ${m.content}`)
    .join("\n---\n");

  try {
    const result = await aiStreamRound(
      {
        messages: [
          { role: "system", content: COMBINED_SUMMARY_PROMPT },
          {
            role: "user",
            content:
              `Проанализируй сообщения и создай подробное комбинированное саммари.\n\n` +
              `Сообщения для анализа (${options.messages.length} шт.):\n\n${formattedMessages}`,
          },
        ],
        maxTokens: 4096,
        temperature: 0.3,
      },
      {
        onTextDelta: (text) => writer.appendText(text),
      },
    );

    await writer.finalize();
    return result.text;
  } catch (error) {
    await writer.deleteMessage();
    throw error;
  }
}
