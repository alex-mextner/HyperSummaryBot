import { beforeEach, describe, expect, mock, test } from "bun:test";
import "../../setup";
import { zaiClient, hfClient, geminiClient } from "../../../src/services/ai/clients";
import { aiStreamRound } from "../../../src/services/ai/streaming";

const request = { messages: [{ role: "user" as const, content: "Synthetic test" }], maxTokens: 50 };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function success(text = "valid") {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { choices: [{ delta: { content: text } }] };
      yield { choices: [{ delta: {}, finish_reason: "stop" }] };
    },
  };
}
function setCreate(
  client: ReturnType<typeof zaiClient>,
  implementation: (...args: any[]) => Promise<any>,
) {
  (client as any).chat.completions.create = mock(implementation);
}
beforeEach(() => {
  for (const client of [zaiClient(), hfClient(), geminiClient()])
    setCreate(client, async () => success());
});

describe("AI execution contract", () => {
  test("hard deadline rejects startup even when the provider ignores cancellation", async () => {
    let signal: AbortSignal | undefined;
    setCreate(zaiClient(), async (_body, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const outcome = await Promise.race([
      aiStreamRound({ ...request, deadlineMs: 15, maxProviders: 1 }, {}).then(
        () => "success",
        () => "rejected",
      ),
      wait(100).then(() => "hung"),
    ]);
    expect(outcome).toBe("rejected");
    expect(signal?.aborted).toBe(true);
  });

  test("late stream content cannot turn a timed out request into success", async () => {
    const received: string[] = [];
    setCreate(zaiClient(), async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: "unverified" } }] };
        await wait(60);
        yield { choices: [{ delta: { content: "late" } }] };
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      },
    }));
    await expect(
      aiStreamRound(
        { ...request, deadlineMs: 10, maxProviders: 1 },
        { onTextDelta: (x) => received.push(x) },
      ),
    ).rejects.toThrow();
    await wait(70);
    expect(received).toEqual([]);
  });

  test("failed-attempt text never reaches callbacks or changes original prompt", async () => {
    const received: string[] = [];
    const original = JSON.stringify(request);
    setCreate(zaiClient(), async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: "PRIVATE_BAD_PARTIAL" } }] };
        throw new Error("network error");
      },
    }));
    const result = await aiStreamRound(request, { onTextDelta: (x) => received.push(x) });
    expect(result.text).toBe("valid");
    expect(received).toEqual(["valid"]);
    expect(JSON.stringify(request)).toBe(original);
  });

  test("structured authentication failures never retry another provider", async () => {
    setCreate(zaiClient(), async () => {
      throw Object.assign(new Error("401 unauthorized"), { status: 401 });
    });
    await expect(aiStreamRound(request, {})).rejects.toThrow();
    expect((hfClient() as any).chat.completions.create).not.toHaveBeenCalled();
  });

  test("truncated output is rejected instead of being presented as complete", async () => {
    setCreate(zaiClient(), async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: "truncated" }, finish_reason: "length" }] };
      },
    }));
    await expect(aiStreamRound({ ...request, maxProviders: 1 }, {})).rejects.toThrow();
  });

  test("a clean EOF without a terminal finish reason is not a complete response", async () => {
    setCreate(zaiClient(), async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: "not finished" } }] };
      },
    }));
    await expect(aiStreamRound({ ...request, maxProviders: 1 }, {})).rejects.toThrow();
  });

  test("invalid budgets fail before starting providers", async () => {
    for (const deadlineMs of [0, -1, NaN, Infinity]) {
      await expect(aiStreamRound({ ...request, deadlineMs }, {})).rejects.toThrow();
    }
    expect((zaiClient() as any).chat.completions.create).not.toHaveBeenCalled();
  });

  test("reasoning chunks followed by valid text use one provider", async () => {
    setCreate(zaiClient(), async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: "", reasoning_content: "internal" } }] };
        yield { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] };
      },
    }));
    expect((await aiStreamRound(request, {})).text).toBe("answer");
    expect((hfClient() as any).chat.completions.create).not.toHaveBeenCalled();
  });
  test("a stalled primary leaves time for the fallback", async () => {
    setCreate(zaiClient(), async () => new Promise(() => {}));
    const started = performance.now();
    expect((await aiStreamRound({ ...request, deadlineMs: 120 }, {})).text).toBe("valid");
    expect(performance.now() - started).toBeLessThan(120);
  });

  test("structured 400 is nonretryable even when its body contains retry keywords", async () => {
    setCreate(zaiClient(), async () => {
      throw Object.assign(new Error("network 503 PRIVATE"), { status: 400 });
    });
    await expect(aiStreamRound(request, {})).rejects.toThrow("AI provider request failed");
    expect((hfClient() as any).chat.completions.create).not.toHaveBeenCalled();
  });

  test("malformed or unsolicited tool calls are never accepted", async () => {
    setCreate(zaiClient(), async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "test_call", function: { name: "delete_data", arguments: "{" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        };
      },
    }));
    await expect(aiStreamRound({ ...request, maxProviders: 1 }, {})).rejects.toThrow();
  });
  test("terminal frame without a delta is accepted", async () => {
    setCreate(zaiClient(), async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: "answer" } }] };
        yield { choices: [{ finish_reason: "stop" }] };
      },
    }));
    expect((await aiStreamRound(request, {})).text).toBe("answer");
  });

  test("legacy compatible stop frame accepts complete requested tools", async () => {
    setCreate(zaiClient(), async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "synthetic",
                    function: { name: "render_table", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        };
        yield { choices: [{ finish_reason: "stop" }] };
      },
    }));
    const tools = [
      {
        type: "function" as const,
        function: { name: "render_table", parameters: { type: "object" } },
      },
    ];
    const result = await aiStreamRound({ ...request, tools }, {});
    expect(result.toolCalls[0]?.name).toBe("render_table");
  });
  test("oversized tool names fail before growing unbounded", async () => {
    setCreate(zaiClient(), async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "synthetic",
                    function: { name: "a".repeat(129), arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        };
      },
    }));
    await expect(aiStreamRound({ ...request, maxProviders: 1 }, {})).rejects.toThrow();
  });
});
