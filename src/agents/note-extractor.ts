import { aiStreamRound } from "../services/ai/streaming";
import { formatMessagesForPrompt } from "../utils/message-formatter";

export interface ExtractedNote {
  title: string;
  summary: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: Array<{ task: string; owner?: string; deadline?: string }>;
  tags: string[];
}

const NOTE_SYSTEM_PROMPT = `Ты — ассистент для извлечения структурированных заметок из групповых чатов.

ЗАДАЧА: Проанализируй сообщения и извлеки полезную заметку в формате JSON.

ТРЕБОВАНИЯ:
- title: краткий заголовок (3-7 слов), отражающий суть
- summary: 2-3 предложения о чём речь
- keyPoints: список ключевых фактов/выводов (не более 7)
- decisions: принятые решения (если есть)
- actionItems: задачи с указанием кто ответственный и дедлайн (если есть)
- tags: категории заметки (например: "Техническое", "Организационное", "Встреча", "Договорённость")

ПРАВИЛА:
- Каждый факт привяжи к конкретному человеку по имени
- Не додумывай — только из сообщений
- Если action item без ответственного — поставь "?"
- Дедлайны: извлеки дату если есть ("завтра", "в пятницу" → укажи как есть)

ФОРМАТ: строго валидный JSON без markdown-форматирования:
{
  "title": "...",
  "summary": "...",
  "keyPoints": ["..."],
  "decisions": ["..."],
  "actionItems": [{"task": "...", "owner": "...", "deadline": "..."}],
  "tags": ["..."]
}`;

export async function extractNote(
  messages: Array<{ userId: number; userName: string | null; content: string }>,
): Promise<ExtractedNote> {
  const { text: formattedMessages } = formatMessagesForPrompt(messages);

  const result = await aiStreamRound(
    {
      messages: [
        { role: "system", content: NOTE_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Извлеки заметку из этих сообщений:\n\n${formattedMessages}`,
        },
      ],
      maxTokens: 4096,
      temperature: 0.3,
    },
    {},
  );

  // Parse JSON from AI response
  const text = result.text.trim();

  // Try to extract JSON block if wrapped in markdown code fences
  const jsonMatch =
    text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/```\s*([\s\S]*?)\s*```/);
  const jsonStr = jsonMatch ? jsonMatch[1]!.trim() : text;

  try {
    const parsed = JSON.parse(jsonStr) as Partial<ExtractedNote>;

    return {
      title: parsed.title || "Заметка из чата",
      summary: parsed.summary || "",
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      actionItems: Array.isArray(parsed.actionItems)
        ? parsed.actionItems.filter((item) => item && typeof item.task === "string")
        : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    };
  } catch (parseError) {
    console.error("[note] Failed to parse AI response as JSON:", parseError, "Raw text:", text);
    // Fallback: treat entire response as summary
    return {
      title: "Заметка из чата",
      summary: text.slice(0, 2000),
      keyPoints: [],
      decisions: [],
      actionItems: [],
      tags: [],
    };
  }
}
