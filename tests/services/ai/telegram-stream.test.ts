import { mock, describe, test, expect, beforeEach } from "bun:test";
import "../../setup";
import { createMockBot, resetGramioMocks, gramioApiCalls } from "../../setup";
import { TelegramStreamWriter } from "../../../src/services/ai/telegram-stream";

describe("TelegramStreamWriter", () => {
  beforeEach(() => {
    resetGramioMocks();
  });

  test("initPlaceholder sends waiting message", async () => {
    const bot = createMockBot();
    new TelegramStreamWriter(bot as any, 123);
    await new Promise((r) => setTimeout(r, 50));

    const sendCalls = gramioApiCalls.filter((c) => c.method === "sendMessage");
    expect(sendCalls.length).toBeGreaterThan(0);
    expect(sendCalls[0]!.text).toBe("⏳");
    expect(sendCalls[0]!.chat_id).toBe(123);
  });

  test("appendText schedules flush and edits message with plain text", async () => {
    const bot = createMockBot();
    const writer = new TelegramStreamWriter(bot as any, 123);
    await new Promise((r) => setTimeout(r, 50));

    writer.appendText("Hello");
    await new Promise((r) => setTimeout(r, 100));

    const editCalls = gramioApiCalls.filter((c) => c.method === "editMessageText");
    expect(editCalls.length).toBeGreaterThan(0);
    expect(editCalls[0]!.text).toContain("Hello");
    // No parse_mode during streaming — plain text avoids HTML parse errors
    expect(editCalls[0]!.parse_mode).toBeUndefined();
  });

  test("finalize stops typing and sends final HTML chunks", async () => {
    const bot = createMockBot();
    const writer = new TelegramStreamWriter(bot as any, 123);
    await new Promise((r) => setTimeout(r, 50));

    writer.appendText("Final text");
    await writer.finalize();

    // Should delete the placeholder and send new HTML-formatted messages
    const deleteCalls = gramioApiCalls.filter((c) => c.method === "deleteMessage");
    const sendCalls = gramioApiCalls.filter((c) => c.method === "sendMessage");
    expect(deleteCalls.length).toBeGreaterThan(0);
    expect(sendCalls.length).toBeGreaterThan(0);
    // Final messages should have HTML parse mode
    const htmlSends = sendCalls.filter((c) => c.parse_mode === "HTML");
    expect(htmlSends.length).toBeGreaterThan(0);
  });

  test("setToolLabel and markToolResult update tool lines", async () => {
    const bot = createMockBot();
    const writer = new TelegramStreamWriter(bot as any, 123);
    await new Promise((r) => setTimeout(r, 50));

    writer.setToolLabel("get_summary");
    writer.markToolResult(true);
    writer.appendText("Done");
    await new Promise((r) => setTimeout(r, 100));

    const editCalls = gramioApiCalls.filter((c) => c.method === "editMessageText");
    expect(editCalls.length).toBeGreaterThan(0);
    expect(editCalls[0]!.text).toContain("✅");
    expect(editCalls[0]!.text).toContain("Генерирую саммари");
  });

  test("deleteMessage removes the placeholder", async () => {
    const bot = createMockBot();
    const writer = new TelegramStreamWriter(bot as any, 123);
    await new Promise((r) => setTimeout(r, 50));

    await writer.deleteMessage();

    const deleteCalls = gramioApiCalls.filter((c) => c.method === "deleteMessage");
    expect(deleteCalls.length).toBeGreaterThan(0);
    expect(deleteCalls[0]!.chat_id).toBe(123);
  });

  test("deleteMessage does nothing when messageId is null", async () => {
    const bot = createMockBot();
    const writer = new TelegramStreamWriter(bot as any, 123);
    await writer.deleteMessage();

    const deleteCalls = gramioApiCalls.filter((c) => c.method === "deleteMessage");
    expect(deleteCalls.length).toBe(0);
  });

  test("deleteMessage ignores API failures", async () => {
    const bot = {
      api: {
        sendMessage: mock(async () => ({ message_id: 42 })),
        deleteMessage: mock(async () => {
          throw new Error("Message not found");
        }),
        sendChatAction: mock(async () => true),
        editMessageText: mock(async () => true),
      },
    };
    const writer = new TelegramStreamWriter(bot as any, 123);
    await new Promise((r) => setTimeout(r, 50));

    await expect(writer.deleteMessage()).resolves.toBeUndefined();
  });

  test("finalize splits long text over 4000 chars into multiple HTML messages", async () => {
    const bot = createMockBot();
    const writer = new TelegramStreamWriter(bot as any, 123);
    await new Promise((r) => setTimeout(r, 50));

    // Create ~6000 chars of realistic markdown text with paragraphs
    const longText =
      "# Заголовок\n\n" +
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(
        60,
      ) +
      "\n\n## Второй раздел\n\n" +
      "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. ".repeat(
        40,
      );

    writer.appendText(longText);
    await writer.finalize();

    const sendCalls = gramioApiCalls.filter(
      (c) => c.method === "sendMessage" && c.parse_mode === "HTML",
    );
    expect(sendCalls.length).toBeGreaterThanOrEqual(2);
    // Each chunk should be under the limit
    for (const call of sendCalls as unknown as Array<{ text: string }>) {
      expect(call.text.length).toBeLessThanOrEqual(4000);
    }
  });

  test("processThinkTags removes think sections", async () => {
    const bot = createMockBot();
    const writer = new TelegramStreamWriter(bot as any, 123);
    await new Promise((r) => setTimeout(r, 50));

    writer.appendText("Hello  <think>something secret</think> world");
    await new Promise((r) => setTimeout(r, 100));

    const editCalls = gramioApiCalls.filter((c) => c.method === "editMessageText");
    expect(editCalls.length).toBeGreaterThan(0);
    expect(editCalls[0]!.text).toContain("Hello");
    expect(editCalls[0]!.text).not.toContain("secret");
  });

  test("handles rate limit by rescheduling flush", async () => {
    let attempts = 0;
    const bot = {
      api: {
        sendMessage: mock(async () => ({ message_id: 1 })),
        editMessageText: mock(async () => {
          attempts++;
          if (attempts === 1) {
            const err = new Error("retry after 3") as any;
            err.code = 429;
            throw err;
          }
          return true;
        }),
        deleteMessage: mock(async () => true),
        sendChatAction: mock(async () => true),
      },
    };

    const writer = new TelegramStreamWriter(bot as any, 123);
    await new Promise((r) => setTimeout(r, 50));

    writer.appendText("Retry me");
    await new Promise((r) => setTimeout(r, 1500));

    expect(attempts).toBeGreaterThanOrEqual(2);
  });
});
