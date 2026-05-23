import { mock, describe, test, expect, beforeEach } from "bun:test";
import "../setup";
import { zaiClient } from "../../src/services/ai/clients";
import { generateSummary } from "../../src/agents/summary";

function createMockBot() {
  return {
    api: {
      sendMessage: mock(async () => ({ message_id: 1 })),
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

    expect(result).toBe("Mock response");
    expect(callCount).toBe(1); // single-phase
    expect(capturedParams).not.toBeNull();
    expect(capturedParams.messages).toHaveLength(2); // system + user
    expect(capturedParams.messages[0].role).toBe("system");
    expect(capturedParams.messages[0].content).toContain("саммари");
    expect(capturedParams.max_tokens).toBe(4096);
    expect(capturedParams.temperature).toBe(0.3);
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

  test("returns result text", async () => {
    const result = await generateSummary({
      chatId: 1,
      messages: [{ userId: 1, userName: "User", content: "Test" }],
      bot: createMockBot() as any,
    });

    expect(result).toBe("Mock response");
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
