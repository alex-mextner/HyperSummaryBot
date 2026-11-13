# Claude Primary and Reserve Routing

Task: UB-178. Base revision: `fd817fd9aed5f0b26561aa919d160ff7b1aec349`.

## Changes

Add optional Claude Sonnet 5.5 and Haiku 5.5 through the existing OpenAI-compatible adapter. Claude is primary when either credential is configured, followed by z.ai and finally Hugging Face. The default attempt limit is three so the reserve is reachable. A deployment without Claude credentials retains its two configured providers.

Claude requests omit sampling parameters and add 8192 tokens of headroom to the caller's allowance. This is one shared total for adaptive thinking and response text, not a separate guaranteed visible-output cap. Claude 5 thinking is enabled by default through the [OpenAI compatibility API](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk#thinking-support), and [thinking tokens count toward max_tokens](https://platform.claude.com/docs/en/build-with-claude/thinking). Both credentials use the same model and request settings; identical keys are deduplicated. A credential-level 401, 402, 403, 429 or Anthropic's specific low-credit 400 may open the stream once with the backup credential, under the same provider deadline. Model 404 does not rotate credentials. Failed or incomplete streams never deliver partial text.

Remove the obsolete provider's environment fields, client, routing and test fixtures. No replacement prohibition or model-name filter is added. Authentication, quota and model-not-found failures may continue to an independent provider. Ordinary invalid requests and cancellation still abort, and exhausting providers throws an explicit error. Logs carry provider, model and fixed failure category without private prompts or keys.

Update GLM to 5.3 / 5.3 Flash. The HF smart model is `Qwen/Qwen3.8-2.4T-A95B:deepinfra`; the fast model is `meta-llama/Llama-4-Scout-17B-16E-Instruct:deepinfra`. Exact GLM 5.3 and Qwen 3.8 2.4T requests use low reasoning effort and at least 4096 output tokens.

## Execution budgets

The default total deadline is 30 seconds for three selected providers and 20 seconds for one or two. The remaining time is divided among remaining attempts, preserving approximately ten seconds per provider after a stalled primary in the three-provider chain. An explicit `deadlineMs` remains the total hard limit. These are configured targets, not measured response-time guarantees.

Summary failures stay visible through fixed owner-DM error messages and structured provider logs. Background history import does not use the AI adapter; its failures produce a sanitized history_import log with the chat ID, without posting an unrelated summary error to the group.

## Verification

The initial 65 focused Bun tests covered environment defaults, client configuration, two-key fallback, 404 behavior, complete text/tool output, deadline enforcement and fallback order in an isolated OpenAI 6.34 harness. Release preparation then reproduced and fixed two SDK mock type errors and the diluted default deadline. The complete TypeScript check and 45 streaming/contract tests passed on the offload server using frozen dependencies, Bun 1.4.2 and the target OpenAI 6.39 SDK. The new deterministic deadline test failed at 6666 ms before the fix and passed afterward. This is not a whole-suite or Telegram E2E claim; live account checks remain separate.

## Production Plan

Publish source first. Under the separately approved rollout, provision `CLAUDE_API_TOKEN` and optional `CLAUDE_API_TOKEN2` from the already working bot credentials through the trusted secret path. Set `CLAUDE_BASE_URL=https://api.anthropic.com/v1/`, `CLAUDE_MODEL=claude-sonnet-5-5`, `CLAUDE_FAST_MODEL=claude-haiku-5-5`. Update existing GLM/HF model variables to the values above and remove obsolete bot-local provider entries. Do not revoke shared keys. HF access repair does not block Claude activation. Deploy the approved SHA, verify a bounded Claude text/tool request, and retain the preceding release and configuration for rollback.

## Attribution

The inspected deployed service had no Claude integration or credential. No evidence ties it to the three November 8 retired-model calls. Adding Claude is a new priority-provider change, not a claim that this service caused that incident.
