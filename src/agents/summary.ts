import type OpenAI from "openai";
import { aiStreamRound } from "../services/ai/streaming";
import { TelegramStreamWriter } from "../services/ai/telegram-stream";
import {
  formatMessagesForPrompt,
  containsRawUserIds,
  sanitizeAttributions,
} from "../utils/message-formatter";
import { renderTable } from "../utils/table-renderer";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBot = any;

interface SummaryAgentOptions {
  chatId: number;
  replyToChatId?: number;
  messages: Array<{ userId: number; userName: string | null; content: string; messageId?: number }>;
  bot: AnyBot;
  placeholderText?: string;
  debtTracker?: import("../services/debt-tracker").DebtTracker;
}

const DRAFT_SYSTEM_PROMPT = `Ты — ассистент для анализа групповых чатов. Создай максимально подробное комбинированное саммари.

ПРАВИЛА ВЫВОДА (пользователь видит КАЖДЫЙ символ в реальном времени, это критично):
1. Начни с живого скана: <i>🔍 Сканирую сообщения…</i> — потом покажи найденные темы по мере обнаружения.
2. Показывай прогресс: <i>→ Нашёл тему "Участники" (15 сообщений)</i>, <i>→ Нашёл тему "Расходы" (8 сообщений)</i>.
3. После скана пиши секции: <b>### Участники</b>, <b>### Место</b>, <b>### Расходы</b> и т.д.
4. Под каждым заголовком — факты. Каждый факт с именем.
5. После каждой секции добавь статус: <i>✓ Проверено: N фактов</i>.
6. НЕ используй markdown (**__, ||таблицы) — только HTML теги.
7. Для таблиц — инструмент render_table. Для долгов — инструмент track_debt.

ИМЕНА:
- Только имена из сообщений. НИКОГДА не пиши "участник", "пользователь", "user"
- Если имя неизвестно — используй "@ник" или перефразируй без имени

КОНКРЕТИКА:
- Каждый факт приписан конкретному человеку по имени
- "разбить в указанном месте" → "разбить палатки у домиков по ссылке"
- НЕ придумывай фактов — только из сообщений
- Если нет информации — напиши "Не обсуждалось"
- Язык: русский`;

const SUMMARY_TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "render_table",
      description:
        "Render a structured table (action items, decisions, comparisons) as HTML. Use this INSTEAD of writing markdown tables in the main text. Cell values may use markdown formatting (**bold**, *italic*, [links](url)) — it will be converted to HTML automatically.",
      parameters: {
        type: "object",
        properties: {
          headers: {
            type: "array",
            items: { type: "string" },
            description: "Column headers",
          },
          rows: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
            description:
              "Table rows, each is an array of cell strings. Markdown formatting is allowed in cells and will be converted to HTML.",
          },
          title: {
            type: "string",
            description: "Optional table title/caption",
          },
        },
        required: ["headers", "rows"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "track_debt",
      description:
        "Record a debt/liability from chat messages. Use when someone explicitly states they owe money, paid for someone else, or requests reimbursement. Stores amount in smallest currency unit (integer cents). Normalizes informal currency names (динар→RSD, евро→EUR, доллар→USD, рубль→RUB).",
      parameters: {
        type: "object",
        properties: {
          creditorName: {
            type: "string",
            description: "Name of the person who is owed money (who paid/lent)",
          },
          debtorName: {
            type: "string",
            description: "Name of the person who owes money (who needs to pay back)",
          },
          amount: {
            type: "integer",
            description:
              "Amount in smallest currency unit (e.g. 3500 for 35.00, 150000 for 1500.00 RSD). Must be integer, not float.",
          },
          currency: {
            type: "string",
            description: "Normalized currency code: RSD, EUR, USD, RUB, CHF, GBP, etc.",
          },
          description: {
            type: "string",
            description: "What the debt is for (e.g. 'газировка', 'бензин', 'продукты')",
          },
          sourceMessageId: {
            type: "integer",
            description: "Telegram message ID where this debt was mentioned",
          },
        },
        required: ["creditorName", "debtorName", "amount", "currency", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "settle_debt",
      description:
        "Mark a debt as settled/paid. Use when someone explicitly confirms they paid back money.",
      parameters: {
        type: "object",
        properties: {
          creditorName: {
            type: "string",
            description: "Name of the person who was owed money",
          },
          debtorName: {
            type: "string",
            description: "Name of the person who paid back",
          },
          description: {
            type: "string",
            description: "What the settled debt was for",
          },
        },
        required: ["creditorName", "debtorName", "description"],
      },
    },
  },
];

const REVIEW_SYSTEM_PROMPT = `Ты — редактор саммари. Проверь и перепиши черновик.

ПРОЦЕСС (пользователь видит каждый шаг):
1. Начни с <i>🔍 Проверяю факты…</i>
2. Проверяй по секциям — показывай что исправляешь: <i>→ Исправлено: "указанное место" → "домики по ссылке"</i>.
3. Уточняй противоречия: <i>⚠️ Противоречие: Вася сказал X, Марина — Y. Решение не принято.</i>
4. Удали додуманное: <i>🗑️ Удалено: неподтверждённый факт</i>.
5. После проверки каждой секции: <i>✓ Секция "Название" проверена</i>.
6. Выдай финальный текст секция за секцией.

Правила:
- Замени markdown на HTML
- Для таблиц — инструмент render_table`;

async function generateDraft(
  formattedMessages: string,
  callbacks: {
    onTextDelta?: (text: string) => void;
    onToolCallStart?: (name: string, input: Record<string, unknown>) => void;
    onToolCallResult?: (name: string, result: unknown) => void;
  },
): Promise<{ text: string; toolCalls: Array<{ name: string; arguments: string; id: string }> }> {
  const result = await aiStreamRound(
    {
      messages: [
        { role: "system", content: DRAFT_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Проанализируй сообщения и создай подробное комбинированное саммари.\n\n${formattedMessages}`,
        },
      ],
      tools: SUMMARY_TOOLS,
      maxTokens: 4096,
      temperature: 0.3,
    },
    callbacks,
  );
  return { text: result.text, toolCalls: result.toolCalls };
}

async function reviewAndRefine(
  draft: string,
  formattedMessages: string,
  callbacks: {
    onTextDelta?: (text: string) => void;
    onToolCallStart?: (name: string, input: Record<string, unknown>) => void;
    onToolCallResult?: (name: string, result: unknown) => void;
  } = {},
): Promise<{ text: string; toolCalls: Array<{ name: string; arguments: string; id: string }> }> {
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
      tools: SUMMARY_TOOLS,
      maxTokens: 4096,
      temperature: 0.2,
    },
    callbacks,
  );
  return { text: result.text, toolCalls: result.toolCalls };
}

export async function generateSummary(options: SummaryAgentOptions): Promise<string> {
  const writer = new TelegramStreamWriter(
    options.bot,
    options.replyToChatId ?? options.chatId,
    options.placeholderText,
  );

  const { text: formattedMessages, lookup } = formatMessagesForPrompt(options.messages);

  const totalStart = Date.now();
  console.log(
    `[summary] Starting generation — ${options.messages.length} messages for chat ${options.chatId}`,
  );

  try {
    // Phase 1: Draft with streaming (user sees live text)
    const draftStart = Date.now();
    const draftResult = await generateDraft(formattedMessages, {
      onTextDelta: (text) => writer.appendText(text),
    });
    console.log(
      `[summary] Draft phase complete — ${draftResult.text.length} chars, ${Date.now() - draftStart}ms`,
    );

    // Phase 2: Review and refine — streamed live so user sees each fact being checked
    let reviewAccumulator = "";
    const reviewStart = Date.now();
    let reviewResult = {
      text: draftResult.text,
      toolCalls: [] as Array<{ name: string; arguments: string; id: string }>,
    };
    try {
      const reviewPromise = reviewAndRefine(draftResult.text, formattedMessages, {
        onTextDelta: (delta) => {
          reviewAccumulator += delta;
          writer.replaceText(reviewAccumulator);
        },
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        const id = setTimeout(() => {
          clearTimeout(id);
          reject(new Error("Review phase timed out after 60s"));
        }, 60_000);
      });
      reviewResult = await Promise.race([reviewPromise, timeoutPromise]);
      console.log(
        `[summary] Review phase complete — ${reviewResult.text.length} chars, ${Date.now() - reviewStart}ms`,
      );
    } catch (reviewError) {
      console.warn(
        `[summary] Review phase failed after ${Date.now() - reviewStart}ms, falling back to draft:`,
        reviewError,
      );
      reviewResult = draftResult;
      writer.replaceText(draftResult.text);
    }
    let final = reviewResult.text;

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

    // Render tool calls (structured tables) and append
    const allToolCalls = [...draftResult.toolCalls, ...reviewResult.toolCalls];

    // Process debt tracking tool calls
    if (options.debtTracker) {
      const userNameToId = new Map<string, number>();
      for (const m of options.messages) {
        if (m.userName) userNameToId.set(m.userName, m.userId);
      }
      for (const tc of allToolCalls) {
        if (tc.name === "track_debt") {
          try {
            const args = JSON.parse(tc.arguments) as {
              creditorName: string;
              debtorName: string;
              amount: number;
              currency: string;
              description: string;
              sourceMessageId?: number;
            };
            const creditorId = userNameToId.get(args.creditorName) ?? 0;
            const debtorId = userNameToId.get(args.debtorName) ?? 0;
            await options.debtTracker.saveDebt({
              chatId: options.chatId,
              creditorUserId: creditorId,
              creditorUserName: args.creditorName,
              debtorUserId: debtorId,
              debtorUserName: args.debtorName,
              amount: args.amount,
              currency: args.currency.toUpperCase(),
              description: args.description,
              sourceMessageIds: args.sourceMessageId
                ? JSON.stringify([args.sourceMessageId])
                : null,
            });
            console.log(
              `[debt] tracked: ${args.debtorName} → ${args.creditorName} ${args.amount} ${args.currency} for ${args.description}`,
            );
          } catch (e) {
            console.error("[summary] Failed to track debt:", e);
          }
        } else if (tc.name === "settle_debt") {
          try {
            const args = JSON.parse(tc.arguments) as {
              creditorName: string;
              debtorName: string;
              description: string;
            };
            const creditorId = userNameToId.get(args.creditorName) ?? 0;
            const debtorId = userNameToId.get(args.debtorName) ?? 0;
            await options.debtTracker.settleDebt(
              options.chatId,
              creditorId,
              debtorId,
              args.description,
            );
            console.log(
              `[debt] settled: ${args.debtorName} → ${args.creditorName} for ${args.description}`,
            );
          } catch (e) {
            console.error("[summary] Failed to settle debt:", e);
          }
        }
      }
    }
    const tableHtmlParts: string[] = [];
    for (const tc of allToolCalls) {
      if (tc.name === "render_table") {
        try {
          const args = JSON.parse(tc.arguments) as {
            headers: string[];
            rows: string[][];
            title?: string;
          };
          const tableRows = args.rows.map((cells) => {
            const row: Record<string, string> = {};
            for (let i = 0; i < args.headers.length; i++) {
              const header = args.headers[i];
              if (header !== undefined) {
                row[header] = cells[i] ?? "";
              }
            }
            return row;
          });
          const tableHtml = renderTable(args.headers, tableRows);
          if (args.title) {
            tableHtmlParts.push(`<b>${args.title}</b>\n${tableHtml}`);
          } else {
            tableHtmlParts.push(tableHtml);
          }
        } catch (e) {
          console.error("[summary] Failed to render tool table:", e);
        }
      }
    }
    if (tableHtmlParts.length > 0) {
      final += "\n\n" + tableHtmlParts.join("\n\n");
    }

    // If review produced almost nothing, fallback to draft + warn user
    if (reviewResult.text.length < 50 && draftResult.text.length > 100) {
      final = draftResult.text;
      final += "\n\n<i>⚠️ Проверка фактов не завершена (черновик)</i>";
      console.warn("[summary] Review returned empty text, falling back to draft");
    }

    // Footer: progress indicator with metadata
    // Sections may be wrapped in <b> tags: <b>### Title</b> or ### Title
    const sectionCount = (final.match(/<b>###\s+|###\s+/g) || []).length;
    const processingTime = Math.round((Date.now() - totalStart) / 1000);
    final += `\n\n<i>📊 ${options.messages.length} сообщений | ${sectionCount} секций | ⏱ ${processingTime}с</i>`;

    // Replace streamed draft with refined final version
    writer.replaceText(final);

    await writer.finalize();
    console.log(`[summary] Done — total ${Date.now() - totalStart}ms, final ${final.length} chars`);
    return final;
  } catch (error) {
    console.error(`[summary] FAILED after ${Date.now() - totalStart}ms:`, error);
    await writer.deleteMessage();
    throw error;
  }
}
