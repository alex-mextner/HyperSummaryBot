import { aiStreamRound } from "../services/ai/streaming";
import { TelegramStreamWriter } from "../services/ai/telegram-stream";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBot = any;

export type SummaryType =
  | "general"
  | "action_items"
  | "unanswered_questions"
  | "new_facts"
  | "decisions"
  | "discussions"
  | "updates"
  | "controversial"
  | "resources"
  | "announcements";

interface SummaryAgentOptions {
  chatId: number;
  messages: Array<{ userName: string | null; content: string }>;
  type: SummaryType;
  language?: string;
  bot: AnyBot;
}

const SUMMARY_PROMPTS: Record<SummaryType, string> = {
  general: `Проанализируй сообщения и создай структурированное саммари. Выдели:
- Основные темы обсуждения
- Ключевые моменты
- Важные решения или вопросы
Формат: markdown с заголовками и списками.`,

  action_items: `Извлеки из сообщений все action items и задачи. Для каждого укажи:
- Что нужно сделать
- Кто упоминался как ответственный (если есть)
- Дедлайн или временные рамки (если указаны)
Формат: список checkbox'ов markdown.`,

  unanswered_questions: `Найди все вопросы, на которые не был дан ответ. Для каждого:
- Текст вопроса
- Кто задал
- Контекст
Формат: нумерованный список.`,

  new_facts: `Выдели новые факты, открытия или инсайты из обсуждения. Что участники узнали или чему научились?
Формат: список с пояснениями.`,

  decisions: `Найди все принятые решения. Для каждого:
- Что решили
- Кто участвовал в обсуждении
- Аргументы за/против (если были)
Формат: список решений.`,

  discussions: `Выдели активные дискуссии и разные точки зрения. Для каждой:
- Тема дискуссии
- Кто какую позицию занимал
- Была ли достигнута договоренность
Формат: структурированный текст.`,

  updates: `Собери все апдейты, новости и объявления. Что изменилось или было анонсировано?
Формат: хронологический список.`,

  controversial: `Найди спорные или противоречивые моменты. Где участники не сошлись во мнениях?
Формат: список с аргументами сторон.`,

  resources: `Извлеки все полезные ссылки, инструменты, книги, ресурсы, которыми поделились участники.
Формат: список ссылок с описаниями.`,

  announcements: `Найди важные анонсы и объявления (не личные апдейты, а важная информация для группы).
Формат: список с указанием автора.`,
};

export async function generateSummary(options: SummaryAgentOptions): Promise<string> {
  const writer = new TelegramStreamWriter(options.bot, options.chatId);

  const formattedMessages = options.messages
    .map((m) => `${m.userName || "User"}: ${m.content}`)
    .join("\n---\n");

  const systemPrompt = `Ты — ассистент для анализа групповых чатов. Твоя задача — анализировать сообщения и создавать структурированные саммари.

Правила:
1. Используй только информацию из предоставленных сообщений
2. Не придумывай факты, которых нет в сообщениях
3. Сохраняй контекст и отношения между участниками
4. Используй markdown для форматирования
5. Отвечай на языке чата (или на ${options.language || "русском"} если не уверен)
6. Если нет релевантного контента — честно скажи об этом

${SUMMARY_PROMPTS[options.type]}`;

  try {
    const result = await aiStreamRound(
      {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Сообщения для анализа:\n\n${formattedMessages}` },
        ],
        maxTokens: 4096,
        temperature: 0.5,
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
