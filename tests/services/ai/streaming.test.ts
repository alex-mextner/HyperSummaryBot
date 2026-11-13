import { mock, describe, test, expect, beforeEach, spyOn } from "bun:test";
import "../../setup";

import { claudeClient, claudeClients, zaiClient, hfClient } from "../../../src/services/ai/clients";
import { aiStreamRound } from "../../../src/services/ai/streaming";

function setClientResponse(
  client: any,
  behavior: {
    chunks?: any[];
    throw?: Error;
    iterator?: () => AsyncGenerator<any, void, unknown>;
    onCreate?: () => void;
  },
) {
  client.chat.completions.create = mock(async () => {
    behavior.onCreate?.();
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
        const hasTools = chunks.some((chunk) =>
          chunk.choices?.some((choice: any) => choice.delta?.tool_calls),
        );
        yield { choices: [{ delta: {}, finish_reason: hasTools ? "tool_calls" : "stop" }] };
      },
    };
  });
}

describe("aiStreamRound", () => {
  beforeEach(() => {
    for (const client of [zaiClient(), hfClient()]) {
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

  test("discards partial output and retries original request on provider failure", async () => {
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

    expect(result.text).toBe("HF continued");
  });

  test("ignores reasoning-only chunks and falls back only if no final content", async () => {
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
                  {
                    index: 0,
                    id: "synthetic_call_1",
                    function: { name: "search_messages", arguments: '{"q":' },
                  },
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
      {
        messages: [{ role: "user", content: "Hi" }],
        maxTokens: 10,
        tools: [
          {
            type: "function",
            function: { name: "search_messages", parameters: { type: "object" } },
          },
        ],
      },
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

    await expect(
      aiStreamRound({ messages: [{ role: "user", content: "Hi" }], maxTokens: 10 }, {}),
    ).rejects.toThrow("All 2 AI providers failed");
  });

  test("uses two configured providers when Claude has no credential", async () => {
    setClientResponse(zaiClient(), { throw: new Error("502") });
    setClientResponse(hfClient(), { throw: new Error("503") });
    await expect(
      aiStreamRound({ messages: [{ role: "user", content: "Hi" }], maxTokens: 10 }, {}),
    ).rejects.toThrow("All 2 AI providers failed");
    expect(zaiClient().chat.completions.create).toHaveBeenCalledTimes(1);
    expect(hfClient().chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test("does not create an unconfigured third provider", async () => {
    setClientResponse(zaiClient(), { throw: new Error("502") });
    setClientResponse(hfClient(), { throw: new Error("503") });
    const unexpectedFetch = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Unexpected network call"),
    );
    try {
      await expect(
        aiStreamRound(
          { messages: [{ role: "user", content: "Hi" }], maxTokens: 10, maxProviders: 3 },
          {},
        ),
      ).rejects.toThrow("All 2 AI providers failed");
      expect(unexpectedFetch).not.toHaveBeenCalled();
    } finally {
      unexpectedFetch.mockRestore();
    }
  });

  test("default deadline preserves ten seconds per provider after a stalled Claude attempt", async () => {
    const originalPrimary = process.env.CLAUDE_API_TOKEN;
    const originalBackup = process.env.CLAUDE_API_TOKEN2;
    const clock = spyOn(performance, "now").mockReturnValue(0);
    const timers = spyOn(globalThis, "setTimeout");
    try {
      process.env.CLAUDE_API_TOKEN = "test-claude-key";
      delete process.env.CLAUDE_API_TOKEN2;
      setClientResponse(claudeClient(), {
        iterator: async function* () {
          await new Promise<void>(() => {});
          yield { choices: [{ delta: { content: "must not finish" } }] };
        },
      });
      setClientResponse(zaiClient(), {
        chunks: [{ choices: [{ delta: { content: "Fallback after Claude timeout" } }] }],
      });
      const pending = aiStreamRound(
        { messages: [{ role: "user", content: "Hi" }], maxTokens: 100 },
        {},
      );
      const primaryTimer = timers.mock.calls[1];
      if (!primaryTimer || typeof primaryTimer[0] !== "function") {
        throw new Error("Primary timeout was not scheduled");
      }
      clock.mockReturnValue(10_000);
      primaryTimer[0]();
      const result = await pending;
      expect(result.provider).toBe("z.ai");
      expect(primaryTimer[1]).toBeGreaterThanOrEqual(10_000);
      expect(timers.mock.calls[2]?.[1]).toBeGreaterThanOrEqual(10_000);
      expect(timers.mock.calls[0]?.[1]).toBeLessThanOrEqual(30_000);
      expect(hfClient().chat.completions.create).not.toHaveBeenCalled();
    } finally {
      timers.mockRestore();
      clock.mockRestore();
      if (originalPrimary === undefined) delete process.env.CLAUDE_API_TOKEN;
      else process.env.CLAUDE_API_TOKEN = originalPrimary;
      if (originalBackup === undefined) delete process.env.CLAUDE_API_TOKEN2;
      else process.env.CLAUDE_API_TOKEN2 = originalBackup;
    }
  });

  test.each([false, true])(
    "Claude is primary with valid 5.5 request settings, fast=%s",
    async (fast) => {
      const original = process.env.CLAUDE_API_TOKEN;
      try {
        process.env.CLAUDE_API_TOKEN = "test-claude-key";
        const client = claudeClient();
        setClientResponse(client, {
          chunks: [{ choices: [{ delta: { content: "Claude primary" } }] }],
        });
        const result = await aiStreamRound(
          { messages: [{ role: "user", content: "Hi" }], maxTokens: 100, temperature: 0.2, fast },
          {},
        );
        expect(result.provider).toBe("Claude");
        expect(result.model).toBe(fast ? "claude-haiku-5-5" : "claude-sonnet-5-5");
        const params = (client.chat.completions.create as ReturnType<typeof mock>).mock
          .calls[0]?.[0];
        expect(params).not.toHaveProperty("temperature");
        expect(params).not.toHaveProperty("top_p");
        expect(params).not.toHaveProperty("top_k");
        expect(params).not.toHaveProperty("reasoning_effort");
        expect(params).toMatchObject({ max_tokens: 8292 });
        expect(zaiClient().chat.completions.create).not.toHaveBeenCalled();
        expect(hfClient().chat.completions.create).not.toHaveBeenCalled();
      } finally {
        if (original === undefined) delete process.env.CLAUDE_API_TOKEN;
        else process.env.CLAUDE_API_TOKEN = original;
      }
    },
  );

  test("a retired Claude model falls through priority providers before the HF reserve", async () => {
    const original = process.env.CLAUDE_API_TOKEN;
    const order: string[] = [];
    try {
      process.env.CLAUDE_API_TOKEN = "test-claude-key";
      setClientResponse(claudeClient(), {
        onCreate: () => order.push("Claude"),
        throw: Object.assign(new Error("model not found"), { status: 404 }),
      });
      setClientResponse(zaiClient(), {
        onCreate: () => order.push("z.ai"),
        throw: Object.assign(new Error("quota exhausted"), { status: 402 }),
      });
      setClientResponse(hfClient(), { chunks: [{ choices: [{ delta: { content: "Reserve" } }] }] });
      const result = await aiStreamRound(
        { messages: [{ role: "user", content: "Hi" }], maxTokens: 100 },
        {},
      );
      expect(order).toEqual(["Claude", "z.ai"]);
      expect(result.provider).toBe("HF");
      expect(hfClient().chat.completions.create).toHaveBeenCalledTimes(1);
    } finally {
      if (original === undefined) delete process.env.CLAUDE_API_TOKEN;
      else process.env.CLAUDE_API_TOKEN = original;
    }
  });

  test.each([400, 401, 402, 403, 429])(
    "Claude credential status %s uses its backup before another provider",
    async (status) => {
      try {
        process.env.CLAUDE_API_TOKEN = "test-claude-key";
        process.env.CLAUDE_API_TOKEN2 = "test-claude-backup";
        const [primary, backup] = claudeClients();
        setClientResponse(primary, {
          throw: Object.assign(
            new Error(
              status === 400
                ? "Your credit balance is too low to access the Anthropic API"
                : "credential unavailable",
            ),
            { status },
          ),
        });
        setClientResponse(backup, {
          chunks: [{ choices: [{ delta: { content: "Backup Claude" } }] }],
        });
        const result = await aiStreamRound(
          { messages: [{ role: "user", content: "Hi" }], maxTokens: 100 },
          {},
        );
        expect(result.provider).toBe("Claude");
        expect(result.text).toBe("Backup Claude");
        expect(primary!.chat.completions.create).toHaveBeenCalledTimes(1);
        expect(backup!.chat.completions.create).toHaveBeenCalledTimes(1);
        expect(zaiClient().chat.completions.create).not.toHaveBeenCalled();
      } finally {
        delete process.env.CLAUDE_API_TOKEN;
        delete process.env.CLAUDE_API_TOKEN2;
      }
    },
  );

  test("Claude model 404 skips credential retry and uses the independent provider", async () => {
    try {
      process.env.CLAUDE_API_TOKEN = "test-claude-key";
      process.env.CLAUDE_API_TOKEN2 = "test-claude-backup";
      const [primary, backup] = claudeClients();
      setClientResponse(primary, {
        throw: Object.assign(new Error("model not found"), { status: 404 }),
      });
      setClientResponse(backup, {
        chunks: [{ choices: [{ delta: { content: "must not run" } }] }],
      });
      setClientResponse(zaiClient(), {
        chunks: [{ choices: [{ delta: { content: "z.ai fallback" } }] }],
      });
      expect(
        (await aiStreamRound({ messages: [{ role: "user", content: "Hi" }], maxTokens: 100 }, {}))
          .provider,
      ).toBe("z.ai");
      expect(backup!.chat.completions.create).not.toHaveBeenCalled();
    } finally {
      delete process.env.CLAUDE_API_TOKEN;
      delete process.env.CLAUDE_API_TOKEN2;
    }
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

  test.each([
    { envName: "ZAI_MODEL", model: "glm-5.3", fast: false, fallback: false },
    { envName: "ZAI_FAST_MODEL", model: "glm-5.3-flash", fast: true, fallback: false },
    { envName: "HF_MODEL", model: "Qwen/Qwen3.8-2.4T-A95B", fast: false, fallback: true },
    {
      envName: "HF_MODEL",
      model: "Qwen/Qwen3.8-2.4T-A95B:deepinfra",
      fast: false,
      fallback: true,
    },
  ])("reserves output for required reasoning in %o", async ({ envName, model, fast, fallback }) => {
    const original = process.env[envName];
    process.env[envName] = model;
    const client = fallback ? hfClient() : zaiClient();
    if (fallback) setClientResponse(zaiClient(), { throw: new Error("503") });
    setClientResponse(client, {
      chunks: [{ choices: [{ delta: { content: "Answer" } }] }],
    });
    try {
      await aiStreamRound({ messages: [{ role: "user", content: "Hi" }], maxTokens: 64, fast }, {});
      expect(client.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({ model, max_tokens: 4096, reasoning_effort: "low" }),
        expect.anything(),
      );
    } finally {
      if (original === undefined) delete process.env[envName];
      else process.env[envName] = original;
    }
  });

  test("preserves a larger caller output budget for required reasoning", async () => {
    const original = process.env.ZAI_MODEL;
    process.env.ZAI_MODEL = "glm-5.3";
    setClientResponse(zaiClient(), {
      chunks: [{ choices: [{ delta: { content: "Answer" } }] }],
    });
    try {
      await aiStreamRound({ messages: [{ role: "user", content: "Hi" }], maxTokens: 8192 }, {});
      expect(zaiClient().chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 8192, reasoning_effort: "low" }),
        expect.anything(),
      );
    } finally {
      if (original === undefined) delete process.env.ZAI_MODEL;
      else process.env.ZAI_MODEL = original;
    }
  });

  test("preserves the small output budget and request settings for Llama 4 Scout", async () => {
    const original = process.env.HF_MODEL;
    process.env.HF_MODEL = "meta-llama/Llama-4-Scout-17B-16E-Instruct:deepinfra";
    setClientResponse(zaiClient(), { throw: new Error("503") });
    setClientResponse(hfClient(), {
      chunks: [{ choices: [{ delta: { content: "Answer" } }] }],
    });
    try {
      await aiStreamRound({ messages: [{ role: "user", content: "Hi" }], maxTokens: 64 }, {});
      expect(hfClient().chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 64 }),
        expect.anything(),
      );
      expect(hfClient().chat.completions.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ reasoning_effort: expect.anything() }),
        expect.anything(),
      );
    } finally {
      if (original === undefined) delete process.env.HF_MODEL;
      else process.env.HF_MODEL = original;
    }
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

    await expect(
      aiStreamRound(
        { messages: [{ role: "user", content: "Hi" }], maxTokens: 10, signal: controller.signal },
        {},
      ),
    ).rejects.toBeDefined();

    expect(capturedSignal).toBeUndefined();
  });

  test.each([401, 402, 403, 404])(
    "an unavailable provider with HTTP %s fails over without retrying it",
    async (status) => {
      setClientResponse(zaiClient(), {
        throw: Object.assign(new Error("Provider unavailable"), { status }),
      });
      setClientResponse(hfClient(), {
        chunks: [{ choices: [{ delta: { content: "Allowed fallback" } }] }],
      });
      const result = await aiStreamRound(
        { messages: [{ role: "user", content: "Hi" }], maxTokens: 10 },
        {},
      );
      expect(result.text).toBe("Allowed fallback");
      expect(zaiClient().chat.completions.create).toHaveBeenCalledTimes(1);
      expect(hfClient().chat.completions.create).toHaveBeenCalledTimes(1);
    },
  );

  test("all unavailable providers fail explicitly without delivering partial output", async () => {
    setClientResponse(zaiClient(), {
      throw: Object.assign(new Error("Retired model"), { status: 404 }),
    });
    setClientResponse(hfClient(), {
      throw: Object.assign(new Error("Unavailable account"), { status: 401 }),
    });
    const onTextDelta = mock();
    await expect(
      aiStreamRound(
        { messages: [{ role: "user", content: "Hi" }], maxTokens: 10 },
        { onTextDelta },
      ),
    ).rejects.toThrow("All 2 AI providers failed (authentication)");
    expect(zaiClient().chat.completions.create).toHaveBeenCalledTimes(1);
    expect(hfClient().chat.completions.create).toHaveBeenCalledTimes(1);
    expect(onTextDelta).not.toHaveBeenCalled();
  });
});
