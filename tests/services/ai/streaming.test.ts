import { mock, describe, test, expect, beforeEach } from "bun:test";
import "../../setup";

import { zaiClient, hfClient, geminiClient } from "../../../src/services/ai/clients";
import { aiStreamRound } from "../../../src/services/ai/streaming";

function setClientResponse(
  client: any,
  behavior: { chunks?: any[]; throw?: Error; iterator?: () => AsyncGenerator<any, void, unknown> },
) {
  client.chat.completions.create = mock(async () => {
    if (behavior.throw) throw behavior.throw;
    if (behavior.iterator) {
      return { [Symbol.asyncIterator]: behavior.iterator };
    }
    const chunks = behavior.chunks ?? [];
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };
  });
}

describe("aiStreamRound", () => {
  beforeEach(() => {
    for (const client of [zaiClient(), hfClient(), geminiClient()]) {
      setClientResponse(client, { chunks: [] });
    }
  });

  test("streams text and returns full result", async () => {
    setClientResponse(zaiClient(), {
      chunks: [
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: " world" } }] },
      ],
    });

    const deltas: string[] = [];
    const result = await aiStreamRound(
      { messages: [{ role: "user", content: "Hi" }], maxTokens: 10 },
      { onTextDelta: (text) => deltas.push(text) },
    );

    expect(result.text).toBe("Hello world");
    expect(deltas).toEqual(["Hello", " world"]);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.assistantMessage.role).toBe("assistant");
  });

  test("falls back to next provider on retryable error", async () => {
    setClientResponse(zaiClient(), { throw: new Error("timeout") });
    setClientResponse(hfClient(), {
      chunks: [{ choices: [{ delta: { content: "Fallback" } }] }],
    });

    const result = await aiStreamRound(
      { messages: [{ role: "user", content: "Hi" }], maxTokens: 10 },
      {},
    );

    expect(result.text).toBe("Fallback");
  });

  test("fallbacks if text was short (< 500 chars) and model failed", async () => {
    setClientResponse(zaiClient(), {
      iterator: async function* () {
        yield { choices: [{ delta: { content: "Partial" } }] };
        throw new Error("network error after partial text");
      },
    });
    setClientResponse(hfClient(), {
      chunks: [{ choices: [{ delta: { content: "HF continued" } }] }],
    });

    const result = await aiStreamRound(
      { messages: [{ role: "user", content: "Hi" }], maxTokens: 10 },
      {},
    );

    expect(result.text).toContain("HF continued");
  });

  test("does not fallback if substantial text (> 500 chars) was already emitted", async () => {
    setClientResponse(zaiClient(), {
      iterator: async function* () {
        yield { choices: [{ delta: { content: "a".repeat(600) } }] };
        throw new Error("network error after substantial text");
      },
    });

    await expect(
      aiStreamRound({ messages: [{ role: "user", content: "Hi" }], maxTokens: 10 }, {}),
    ).rejects.toThrow("network error after substantial text");
  });

  test("handles z.ai quirk (empty content with reasoning_content)", async () => {
    setClientResponse(zaiClient(), {
      chunks: [{ choices: [{ delta: { content: "", reasoning_content: "..." } }] }],
    });
    setClientResponse(hfClient(), {
      chunks: [{ choices: [{ delta: { content: "HF result" } }] }],
    });

    const result = await aiStreamRound(
      { messages: [{ role: "user", content: "Hi" }], maxTokens: 10 },
      {},
    );

    expect(result.text).toBe("HF result");
  });

  test("accumulates tool calls across chunks", async () => {
    setClientResponse(zaiClient(), {
      chunks: [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { name: "search_messages", arguments: '{"q":' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }],
              },
            },
          ],
        },
      ],
    });

    const result = await aiStreamRound(
      { messages: [{ role: "user", content: "Hi" }], maxTokens: 10, tools: [] },
      {},
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe("search_messages");
    expect(result.toolCalls[0]!.arguments).toBe('{"q":"hello"}');
    expect((result.assistantMessage as any).tool_calls).toBeDefined();
    expect((result.assistantMessage as any).tool_calls).toHaveLength(1);
  });

  test("throws when all providers fail", async () => {
    setClientResponse(zaiClient(), { throw: new Error("502") });
    setClientResponse(hfClient(), { throw: new Error("503") });
    setClientResponse(geminiClient(), { throw: new Error("500") });

    await expect(
      aiStreamRound({ messages: [{ role: "user", content: "Hi" }], maxTokens: 10 }, {}),
    ).rejects.toThrow("All AI providers failed");
  });

  test("fast flag uses fast models", async () => {
    let usedModel = "";
    setClientResponse(zaiClient(), {
      chunks: [{ choices: [{ delta: { content: "Fast" } }] }],
    });

    const originalCreate = (zaiClient() as any).chat.completions.create;
    (zaiClient() as any).chat.completions.create = mock(async (params: any) => {
      usedModel = params.model;
      return originalCreate(params);
    });

    await aiStreamRound(
      { messages: [{ role: "user", content: "Hi" }], maxTokens: 10, fast: true },
      {},
    );

    expect(usedModel).toBe("test-zai-fast");
  });

  test("supports AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort();

    let capturedSignal: AbortSignal | undefined;
    const originalCreate = (zaiClient() as any).chat.completions.create;
    (zaiClient() as any).chat.completions.create = mock(async (params: any, options: any) => {
      capturedSignal = options?.signal;
      return originalCreate(params, options);
    });

    await aiStreamRound(
      { messages: [{ role: "user", content: "Hi" }], maxTokens: 10, signal: controller.signal },
      {},
    );

    expect(capturedSignal).toBe(controller.signal);
  });

  test("non-retryable error is thrown immediately", async () => {
    setClientResponse(zaiClient(), { throw: new Error("Invalid API key") });
    setClientResponse(hfClient(), { chunks: [] });

    await expect(
      aiStreamRound({ messages: [{ role: "user", content: "Hi" }], maxTokens: 10 }, {}),
    ).rejects.toThrow("Invalid API key");
  });
});
