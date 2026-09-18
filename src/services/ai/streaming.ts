import type OpenAI from "openai";
import { zaiClient, hfClient, geminiClient } from "./clients";
import { loadConfig } from "../../config/env";

const MAX_TOOL_CALLS = 16;
const MAX_OUTPUT_CHARS = 131072;
const MAX_STREAM_FRAMES = 8192;
const MAX_TOOL_NAME_CHARS = 128;
const MAX_TOOL_ID_CHARS = 256;

export interface StreamCallbacks {
  /** Called only after one complete, validated attempt succeeds. */
  onTextDelta?: (text: string) => void;
  onToolCallStart?: (name: string, input: Record<string, unknown>) => void;
  onToolCallResult?: (name: string, result: unknown) => void;
}
export interface StreamRoundOptions {
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
  maxTokens: number;
  temperature?: number;
  fast?: boolean;
  signal?: AbortSignal;
  deadlineMs?: number;
  maxProviders?: number;
}
type ToolCall = { name: string; arguments: string; id: string };
export interface StreamRoundResult {
  text: string;
  toolCalls: ToolCall[];
  assistantMessage: OpenAI.ChatCompletionMessageParam;
  provider?: string;
  model?: string;
  elapsedMs?: number;
}

export class AIExecutionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AIExecutionError";
  }
}
function classifyError(error: unknown): AIExecutionError {
  if (error instanceof AIExecutionError) return error;
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : undefined;
  if (status !== undefined) {
    if (status === 401 || status === 403)
      return new AIExecutionError(
        "Invalid API key or permission for AI provider",
        "authentication",
      );
    if (status === 429) return new AIExecutionError("AI rate limit", "rate_limit", true);
    if (status === 408) return new AIExecutionError("AI provider timeout", "timeout", true);
    return new AIExecutionError(
      "AI provider request failed",
      "http_" + status,
      status >= 500 && status < 600,
    );
  }
  const text = error instanceof Error ? error.message.toLowerCase() : "";
  if (/\b(401|403)\b|invalid api key|incorrect api key|token expired/.test(text))
    return new AIExecutionError("Invalid API key or permission for AI provider", "authentication");
  if (/rate limit|\b429\b/.test(text))
    return new AIExecutionError("AI rate limit", "rate_limit", true);
  if (/timeout|timed out/.test(text))
    return new AIExecutionError("AI provider timeout", "timeout", true);

  if (/network|fetch failed|connection|\b50[0234]\b/.test(text))
    return new AIExecutionError("AI provider connection failed", "network", true);
  return new AIExecutionError("AI provider request failed", "provider_error");
}
function abortError(signal: AbortSignal): AIExecutionError {
  return signal.reason instanceof AIExecutionError
    ? signal.reason
    : new AIExecutionError("AI request cancelled", "cancelled");
}
function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}
/** A deadline must settle locally even when a transport ignores AbortSignal.
 * Both fulfillment and rejection are observed, preventing late unhandled errors. */
async function abortable<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  checkSignal(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        cleanup();
        if (signal.aborted) reject(abortError(signal));
        else resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(signal.aborted ? abortError(signal) : error);
      },
    );
    // Defend against a custom thenable synchronously triggering cancellation.
    if (signal.aborted) abort();
  });
}
interface ProviderSlot {
  name: string;
  client: () => OpenAI;
  model: string;
}
function buildChain(fast: boolean): ProviderSlot[] {
  const config = loadConfig();
  return [
    { name: "z.ai", client: zaiClient, model: fast ? config.ZAI_FAST_MODEL : config.ZAI_MODEL },
    { name: "HF", client: hfClient, model: fast ? config.HF_FAST_MODEL : config.HF_MODEL },
    {
      name: "Gemini",
      client: geminiClient,
      model: fast ? config.GEMINI_FAST_MODEL : config.GEMINI_MODEL,
    },
  ];
}
function assertBoundedInteger(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
}

export async function aiStreamRound(
  options: StreamRoundOptions,
  callbacks: StreamCallbacks,
): Promise<StreamRoundResult> {
  const deadlineMs = options.deadlineMs ?? 20_000;
  const maxProviders = options.maxProviders ?? 2;
  assertBoundedInteger("deadlineMs", deadlineMs, 120_000);
  assertBoundedInteger("maxProviders", maxProviders, 3);
  assertBoundedInteger("maxTokens", options.maxTokens, 32768);
  const overall = new AbortController();
  const cancel = () => overall.abort(new AIExecutionError("AI request cancelled", "cancelled"));
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const started = performance.now();
  const timer = setTimeout(
    () => overall.abort(new AIExecutionError("AI deadline exceeded", "deadline")),
    deadlineMs,
  );
  try {
    checkSignal(overall.signal);
    const chain = buildChain(options.fast ?? false).slice(0, maxProviders);
    const originalMessages = structuredClone(options.messages);
    let lastCode = "not_started";
    for (const [index, slot] of chain.entries()) {
      checkSignal(overall.signal);
      const attempt = new AbortController();
      const propagate = () => attempt.abort(abortError(overall.signal));
      overall.signal.addEventListener("abort", propagate, { once: true });
      // Reserve remaining budget for fallback, rather than letting a hung primary
      // consume the entire deadline before a healthy fallback can be attempted.
      const remaining = Math.max(1, deadlineMs - (performance.now() - started));
      const budget = Math.max(1, Math.floor(remaining / (chain.length - index)));
      const attemptTimer = setTimeout(
        () => attempt.abort(new AIExecutionError("AI provider deadline exceeded", "timeout", true)),
        budget,
      );
      let accepted: { result: StreamRoundResult; deltas: string[] };
      try {
        accepted = await consumeProvider(
          slot,
          { ...options, messages: structuredClone(originalMessages) },
          attempt.signal,
          performance.now() + budget,
        );
        checkSignal(overall.signal);
      } catch (error) {
        checkSignal(overall.signal);
        const failure = classifyError(error);
        lastCode = failure.code;
        console.warn("[ai] attempt failed", { provider: slot.name, code: failure.code });
        if (!failure.retryable) throw failure;
        continue;
      } finally {
        clearTimeout(attemptTimer);
        overall.signal.removeEventListener("abort", propagate);
        // Release the request transport on both failure and successful finish.
        attempt.abort(new AIExecutionError("AI attempt finished", "finished"));
      }
      // No application callback is run inside the retryable provider section.
      // Failed attempts cannot leak partial text or replay a callback side effect.
      for (const delta of accepted.deltas) {
        checkSignal(overall.signal);
        callbacks.onTextDelta?.(delta);
      }
      checkSignal(overall.signal);
      const elapsedMs = Math.round(performance.now() - started);
      console.log("[ai] completed", { provider: slot.name, model: slot.model, elapsedMs });
      return { ...accepted.result, provider: slot.name, model: slot.model, elapsedMs };
    }
    throw new AIExecutionError(`All ${chain.length} AI providers failed (${lastCode})`, lastCode);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

async function consumeProvider(
  slot: ProviderSlot,
  options: StreamRoundOptions,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<{ result: StreamRoundResult; deltas: string[] }> {
  checkSignal(signal);
  const stream = await abortable(
    slot.client().chat.completions.create(
      {
        model: slot.model,
        messages: options.messages,
        tools: options.tools,
        max_tokens: options.maxTokens,
        temperature: options.temperature ?? 0.7,
        stream: true,
      },
      { signal },
    ),
    signal,
  );
  const iterator = stream[Symbol.asyncIterator]();
  const deltas: string[] = [];
  const calls = new Map<number, ToolCall>();
  let finishReason: string | null = null;
  let outputChars = 0;
  let frames = 0;
  try {
    while (true) {
      const next = await abortable(iterator.next(), signal);
      checkSignal(signal);
      if (next.done) break;
      if (++frames > MAX_STREAM_FRAMES || performance.now() >= deadlineAt) {
        throw new AIExecutionError("AI stream budget exceeded", "timeout", true);
      }
      const choice = next.value.choices[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.content) {
        deltas.push(delta.content);
        outputChars += delta.content.length;
      }
      // Reasoning is not user-visible output. A reasoning-only frame is normal.
      for (const tc of delta.tool_calls ?? []) {
        const index = tc.index;
        if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_TOOL_CALLS)
          throw new AIExecutionError("Invalid AI tool index", "invalid_response", true);
        const call = calls.get(index) ?? { name: "", arguments: "", id: "" };
        if (tc.id) {
          if (tc.id.length > MAX_TOOL_ID_CHARS)
            throw new AIExecutionError("AI tool ID too large", "invalid_response", true);
          if (call.id && call.id !== tc.id)
            throw new AIExecutionError("Conflicting AI tool ID", "invalid_response", true);
          call.id = tc.id;
        }
        if (tc.function?.name) {
          call.name += tc.function.name;
          outputChars += tc.function.name.length;
          if (call.name.length > MAX_TOOL_NAME_CHARS)
            throw new AIExecutionError("AI tool name too large", "invalid_response", true);
        }
        if (tc.function?.arguments) {
          call.arguments += tc.function.arguments;
          outputChars += tc.function.arguments.length;
        }
        calls.set(index, call);
      }
      if (outputChars > MAX_OUTPUT_CHARS)
        throw new AIExecutionError("AI output budget exceeded", "invalid_response", true);
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
        break;
      }
    }
  } finally {
    // Do not await a misbehaving iterator's return promise: cleanup must not
    // turn a bounded request back into an unbounded wait.
    try {
      if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {});
    } catch {
      // Transport cleanup must not replace an already classified result/error.
      console.warn("[ai] stream cleanup failed");
    }
  }
  checkSignal(signal);
  if (finishReason === "content_filter")
    throw new AIExecutionError("AI response filtered", "filtered");
  if (finishReason !== "stop" && finishReason !== "tool_calls")
    throw new AIExecutionError("AI response incomplete", "incomplete", true);
  const text = deltas.join("");
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  const allowedTools = new Set(
    (options.tools ?? []).flatMap((tool) => (tool.type === "function" ? [tool.function.name] : [])),
  );
  for (const call of toolCalls) {
    if (!call.id || !allowedTools.has(call.name))
      throw new AIExecutionError("Unrequested or invalid AI tool call", "invalid_response", true);
    try {
      const args: unknown = JSON.parse(call.arguments);
      if (typeof args !== "object" || args === null || Array.isArray(args))
        throw new Error("object expected");
    } catch {
      throw new AIExecutionError("Invalid AI tool arguments", "invalid_response", true);
    }
  }
  // OpenAI-compatible endpoints may finish valid tool calls with "stop".
  // Tool IDs, requested names and JSON arguments were independently validated.
  if (finishReason === "tool_calls" && toolCalls.length === 0)
    throw new AIExecutionError("AI finish state mismatch", "invalid_response", true);
  if (!text.trim() && !toolCalls.length)
    throw new AIExecutionError("AI response empty", "empty", true);
  const assistantMessage: OpenAI.ChatCompletionMessageParam = {
    role: "assistant",
    content: text,
    ...(toolCalls.length
      ? {
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
  };
  return { result: { text, toolCalls, assistantMessage }, deltas };
}
