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
    expect(sendCalls[0]!.text).toBe("⏳...");
    expect(sendCalls[0]!.chat_id).toBe(123);
  });

  test("appendText schedules flush and edits message", async () => {
    const bot = createMockBot();
    const writer = new TelegramStreamWriter(bot as any, 123);
    await new Promise((r) => setTimeout(r, 50));

    writer.appendText("Hello");
    await new Promise((r) => setTimeout(r, 50));

    const editCalls = gramioApiCalls.filter((c) => c.method === "editMessageText");
    expect(editCalls.length).toBeGreaterThan(0);
    expect(editCalls[0]!.text).toContain("Hello");
    expect(editCalls[0]!.parse_mode).toBe("HTML");
  });

  test("finalize stops typing and sends final text", async () => {
    const bot = createMockBot();
    const writer = new TelegramStreamWriter(bot as any, 123);
    await new Promise((r) => setTimeout(r, 50));

    writer.appendText("Final text");
    await writer.finalize();

    const editCalls = gramioApiCalls.filter((c) => c.method === "editMessageText");
    expect(editCalls.length).toBeGreaterThan(0);
    expect(editCalls[editCalls.length - 1]!.text).toContain("Final text");
  });

  test("setToolLabel and markToolResult update tool lines", async () => {
    const bot = createMockBot();
    const writer = new TelegramStreamWriter(bot as any, 123);
    await new Promise((r) => setTimeout(r, 50));

    writer.setToolLabel("get_summary");
    writer.markToolResult(true);
    writer.appendText("Done");
    await new Promise((r) => setTimeout(r, 50));

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

  test("sendRemainingChunks splits text over 4000 chars", async () => {
    const bot = createMockBot();
    const writer = new TelegramStreamWriter(bot as any, 123);
    await new Promise((r) => setTimeout(r, 50));

    const longText = "A".repeat(5000);
    writer.appendText(longText);
    await writer.finalize();

    const sendCalls = gramioApiCalls.filter((c) => c.method === "sendMessage");
    expect(sendCalls.length).toBeGreaterThanOrEqual(2);
  });

  test("processThinkTags removes think sections", async () => {
    const bot = createMockBot();
    const writer = new TelegramStreamWriter(bot as any, 123);
    await new Promise((r) => setTimeout(r, 50));

    writer.appendText("Hello  <think>something secret</think> world");
    await new Promise((r) => setTimeout(r, 50));

    const editCalls = gramioApiCalls.filter((c) => c.method === "editMessageText");
    expect(editCalls.length).toBeGreaterThan(0);
    expect(editCalls[0]!.text).toContain("Hello");
    expect(editCalls[0]!.text).not.toContain("secret");
  });

  test("buildText returns placeholder when no content", async () => {
    const bot = createMockBot();
    const writer = new TelegramStreamWriter(bot as any, 123);
    await new Promise((r) => setTimeout(r, 50));

    await writer.finalize();

    const editCalls = gramioApiCalls.filter((c) => c.method === "editMessageText");
    expect(editCalls.length).toBeGreaterThan(0);
  });

  test("handles rate limit by rescheduling flush", async () => {
    let attempts = 0;
    const bot = {
      api: {
        sendMessage: mock(async () => ({ message_id: 1 })),
        editMessageText: mock(async () => {
          attempts++;
          if (attempts === 1) {
            throw new Error("rate limit exceeded");
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
    await new Promise((r) => setTimeout(r, 1200));

    expect(attempts).toBeGreaterThanOrEqual(2);
  });
});
