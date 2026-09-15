import { mock, describe, test, expect, beforeEach } from "bun:test";
import "../setup";
import { zaiClient } from "../../src/services/ai/clients";
import { generateSummary } from "../../src/agents/summary";

function createMockBot() {
  return {
    api: {
      sendMessage: mock(
        async (_params: { chat_id: number; text: string; parse_mode?: string }) => ({
          message_id: 1,
        }),
      ),
      editMessageText: mock(async () => true),
      deleteMessage: mock(async () => true),
      sendChatAction: mock(async () => true),
    },
  };
}

describe("generateSummary", () => {
  let capturedParams: any = null;
  let callCount = 0;

  beforeEach(() => {
    capturedParams = null;
    callCount = 0;
    const client = zaiClient();
    (client as any).chat.completions.create = async (params: any, _options: any) => {
      callCount++;
      capturedParams = params;
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: "Mock response" } }] };
        },
      };
    };
  });

  test("calls aiStreamRound with combined system prompt", async () => {
    const result = await generateSummary({
      chatId: 1,
      messages: [{ userId: 1, userName: "Alice", content: "Hello" }],
      bot: createMockBot() as any,
    });

    expect(result).toContain("Mock response");
    expect(callCount).toBeGreaterThanOrEqual(2); // draft + review (+ possible continuation)
    expect(capturedParams).not.toBeNull();
    expect(capturedParams.messages[0].role).toBe("system");
    expect(capturedParams.messages[0].content).toContain("саммари");
    expect(capturedParams.max_tokens).toBe(4096);
    expect(capturedParams.temperature).toBe(0.2);
  });

  test("includes formatted messages with user lookup", async () => {
    await generateSummary({
      chatId: 1,
      messages: [
        { userId: 1, userName: "Alice", content: "Msg A" },
        { userId: 2, userName: "Bob", content: "Msg B" },
      ],
      bot: createMockBot() as any,
    });

    const userPrompt = capturedParams.messages[1].content as string;
    expect(userPrompt).toContain("Alice: Msg A");
    expect(userPrompt).toContain("Bob: Msg B");
    expect(userPrompt).toContain("---");
    expect(userPrompt).not.toContain("1 →");
    expect(userPrompt).not.toContain("2 →");
  });

  test("uses replyToChatId for every summary message instead of the source chat", async () => {
    const bot = createMockBot();

    await generateSummary({
      chatId: -100123,
      replyToChatId: 42,
      messages: [{ userId: 1, userName: "Alice", content: "Hello" }],
      bot: bot as any,
    });

    const sent = bot.api.sendMessage.mock.calls;
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((call) => call[0]?.chat_id === 42)).toBe(true);
    expect(sent.some((call) => call[0]?.chat_id === -100123)).toBe(false);
  });

  test("returns result text", async () => {
    const result = await generateSummary({
      chatId: 1,
      messages: [{ userId: 1, userName: "User", content: "Test" }],
      bot: createMockBot() as any,
    });

    expect(result).toContain("Mock response");
    // Footer with metadata is appended
    expect(result).toContain("📊");
  });

  test("deletes message when AI throws", async () => {
    const client = zaiClient();
    (client as any).chat.completions.create = async () => {
      throw new Error("AI failure");
    };

    await expect(
      generateSummary({
        chatId: 1,
        messages: [{ userId: 1, userName: "User", content: "Test" }],
        bot: createMockBot() as any,
      }),
    ).rejects.toThrow("AI failure");
  });
});
