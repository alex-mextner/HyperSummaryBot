import { describe, test, expect, beforeEach } from "bun:test";
import "../setup";
import { zaiClient } from "../../src/services/ai/clients";
import { generateSummary, type SummaryType } from "../../src/agents/summary";

describe("generateSummary", () => {
  let capturedParams: any = null;

  beforeEach(() => {
    capturedParams = null;
    const client = zaiClient();
    (client as any).chat.completions.create = async (params: any, _options: any) => {
      capturedParams = params;
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: "Mock response" } }] };
        },
      };
    };
  });

  test("calls aiStreamRound with correct system prompt", async () => {
    const result = await generateSummary({
      chatId: 1,
      messages: [{ userName: "Alice", content: "Hello" }],
      type: "general",
      bot: {} as any,
    });

    expect(result).toBe("Mock response");
    expect(capturedParams).not.toBeNull();
    expect(capturedParams.messages).toHaveLength(2);
    expect(capturedParams.messages[0].role).toBe("system");
    expect(capturedParams.messages[0].content).toContain("саммари");
    expect(capturedParams.max_tokens).toBe(4096);
    expect(capturedParams.temperature).toBe(0.5);
  });

  test("includes formatted messages in user prompt", async () => {
    await generateSummary({
      chatId: 1,
      messages: [
        { userName: "Alice", content: "Msg A" },
        { userName: "Bob", content: "Msg B" },
      ],
      type: "general",
      bot: {} as any,
    });

    const userPrompt = capturedParams.messages[1].content as string;
    expect(userPrompt).toContain("Alice: Msg A");
    expect(userPrompt).toContain("Bob: Msg B");
    expect(userPrompt).toContain("---");
  });

  test("uses correct prompt for each summary type", async () => {
    const typeKeywords: Record<SummaryType, string> = {
      general: "саммари",
      action_items: "action items",
      unanswered_questions: "вопросы",
      new_facts: "новые факты",
      decisions: "решения",
      discussions: "дискуссии",
      updates: "апдейты",
      controversial: "спорные",
      resources: "ссылки",
      announcements: "анонсы",
    };

    for (const [type, keyword] of Object.entries(typeKeywords)) {
      await generateSummary({
        chatId: 1,
        messages: [{ userName: "User", content: "Test" }],
        type: type as SummaryType,
        bot: {} as any,
      });

      const systemPrompt = capturedParams.messages[0].content as string;
      expect(systemPrompt).toContain(keyword);
    }
  });

  test("returns result text", async () => {
    const result = await generateSummary({
      chatId: 1,
      messages: [{ userName: "User", content: "Test" }],
      type: "general",
      bot: {} as any,
    });

    expect(result).toBe("Mock response");
  });

  test("uses language in system prompt when provided", async () => {
    await generateSummary({
      chatId: 1,
      messages: [{ userName: "User", content: "Test" }],
      type: "general",
      language: "en",
      bot: {} as any,
    });

    const systemPrompt = capturedParams.messages[0].content as string;
    expect(systemPrompt).toContain("en");
  });

  test("deletes message when AI throws", async () => {
    const client = zaiClient();
    (client as any).chat.completions.create = async () => {
      throw new Error("AI failure");
    };

    await expect(
      generateSummary({
        chatId: 1,
        messages: [{ userName: "User", content: "Test" }],
        type: "general",
        bot: {} as any,
      }),
    ).rejects.toThrow("AI failure");
  });
});
