# Claude Primary and Reserve Routing

Task: UB-178. Base revision: `fd817fd9aed5f0b26561aa919d160ff7b1aec349`.

## Changes

Add optional Claude Sonnet 5.5 and Haiku 5.5 through the existing OpenAI-compatible adapter. Claude is primary when either credential is configured, followed by z.ai and finally Hugging Face. The default attempt limit is three so the reserve is reachable. A deployment without Claude credentials retains its two configured providers.

Claude requests omit sampling parameters and reserve 8192 output tokens for adaptive thinking in addition to the caller's allowance. Both credentials use the same model and request settings; identical keys are deduplicated. A credential-level 401, 402, 403, 429 or Anthropic's specific low-credit 400 may open the stream once with the backup credential, under the same provider deadline. Model 404 does not rotate credentials. Failed or incomplete streams never deliver partial text.

Remove the obsolete provider's environment fields, client, routing and test fixtures. No replacement prohibition or model-name filter is added. Authentication, quota and model-not-found failures may continue to an independent provider. Ordinary invalid requests and cancellation still abort, and exhausting providers throws an explicit error. Logs carry provider, model and fixed failure category without private prompts or keys.

Update GLM to 5.3 / 5.3 Flash. The HF smart model is `Qwen/Qwen3.8-2.4T-A95B:deepinfra`; the fast model is `meta-llama/Llama-4-Scout-17B-16E-Instruct:deepinfra`. Exact GLM 5.3 and Qwen 3.8 2.4T requests use low reasoning effort and at least 4096 output tokens.

## Verification

Focused Bun tests cover environment defaults, client configuration, two-key fallback, 404 behavior, complete text/tool output, deadline enforcement and fallback order. The isolated harness resolves OpenAI 6.34 from the installed calendar dependencies; the target lock is 6.39. This is disclosed rather than represented as a pinned-SDK or whole-suite gate. Live account checks are separate.

## Production Plan

Publish source first. After separate rollout approval, provision `CLAUDE_API_TOKEN` and optional `CLAUDE_API_TOKEN2` from the already working bot credentials through the trusted secret path. Set `CLAUDE_BASE_URL=https://api.anthropic.com/v1/`, `CLAUDE_MODEL=claude-sonnet-5-5`, `CLAUDE_FAST_MODEL=claude-haiku-5-5`. Update existing GLM/HF model variables to the values above and remove obsolete bot-local provider entries. Do not revoke shared keys. HF access repair does not block Claude activation. Deploy the approved SHA, verify a bounded Claude text/tool request, and retain the preceding release and configuration for rollback.

## Attribution

The inspected deployed service had no Claude integration or credential. No evidence ties it to the three November 8 retired-model calls. Adding Claude is a new priority-provider change, not a claim that this service caused that incident.
