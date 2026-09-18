# HyperSummaryBot — working rules

## Scope and architecture

TypeScript, Bun 1.4.2, GramIO, SQLite/Drizzle, mtcute and an OpenAI-compatible
provider adapter. Keep the system a modular monolith unless measurements justify
more infrastructure. Entry point `src/index.ts`; configuration `src/config/env.ts`.

## Non-negotiable data and delivery boundaries

- Owner and source allowlists are fail-closed numeric-ID checks. A username is not
  authorization. Never expand the allowlist to make a test pass.
- All substantive command responses go through the owner DM delivery path. A
  blocked DM may produce a neutral group hint, never a public summary fallback.
- Webhooks require a valid secret before dispatch. Test/debug endpoints must not
  become an alternate unauthenticated ingestion path.
- Summary generation is read-only. No debt writes, arbitrary tools or actions
  derived from instructions inside chat text. Chat text is untrusted data.
- Source-ID membership is only a reference check, not proof that a claim follows
  from a message. Do not describe current summaries as semantically verified.
- Never print tokens, sessions, OTPs, passwords, transcript excerpts or chat bodies
  in diagnostics/proof artifacts. Prefer stable IDs, counts and error categories.

## Message history

`created_at` is the legacy first-ingestion timestamp. `source_created_at` and
`source_edited_at` are the actual source dates; NULL means unknown, not now.
Bot API/raw TL dates are Unix seconds; mtcute 0.29.7 high-level dates are Date.
Use `sourceDate` at transport boundaries and the repository merge policy for
idempotent writes. Same-chat reply IDs must not reference another chat.

Latest-message queries use stable per-chat Telegram IDs. Time filters only use
known source dates. Reimport must not downgrade transcription to a placeholder or
replace a newer edit with older text. Content versions change on meaningful
content/metadata updates. Do not invent source dates during migration.

`migrateApplicationDatabase` is the production migration path. Tests use it too;
do not create a parallel hand-written test schema. Rehearse migrations against a
consistent private DB backup, including a second no-op application. Copying only
a live WAL database file is not a consistent backup.

## AI execution and summary output

Ordinary summaries use one bounded generation pass, not mandatory draft/review
full-history passes. The adapter enforces one total deadline, reserves time for a
fallback and buffers unverified partial output. It validates terminal frames and
requested tools; missing/truncated responses are failures. Reasoning-only frames
are not final text and are not automatically provider errors. Authentication
failures are not transient retries. Keep timing targets separate from measurements.

## Telegram handlers and account lifecycle

Handler registration order is critical:
1. Global `onError` handler.
2. All `bot.command(...)` handlers.
3. Membership (`my_chat_member`) handlers.
4. Specific/guarded `message` handlers.
5. Catch-all `message` handlers last.

Never place any `bot.on("message", ...)` handler, including a guarded one, before
commands: it can swallow commands. Keep edit handling explicit.

Telegram text messages are limited to 4096 characters, captions to 1024, and
callback_data to 64 bytes. Preserve safe HTML/entity-aware chunking; do not slice
arbitrary tags. Handle per-chat/global rate limits using returned retry_after,
not rapid edit loops. Verify current Bot API limits before changing delivery.
The bot never accepts account phone/OTP/2FA in chat. Trusted-terminal account
administration is documented in `docs/operations/mtproto-admin.md`; stop the bot
before using its shared session. Do not run a second SDK client against a live
session. Shutdown disposes exact listeners and destroys the SDK client.

## Development and release gates

Use kebab-case file names, PascalCase classes/types and camelCase functions.
Log sanitized exceptions as structured `{ err: sanitizedError }` plus category/
IDs; never emit raw private payloads or turn them into unstructured strings.

Use isolated worktrees and atomic commits. Reproduce bugs with a failing test,
then run `bun x tsc --noEmit`, `bun run lint`, `bun run fmt:check`, and `bun test`.
Review staged diffs with the provisioned review tooling before committing. Read
and address real review findings; unavailable reviewers are not successful passes.
Do not bypass hooks with `--no-verify` or change policy to manufacture green gates.
Never stage all files without inspecting status. No new production `any` casts,
raw SQL interpolation from user input, or silently swallowed operational errors.

Use PRs and exact tested SHAs. GitHub Actions deploys main through the configured
workflow; unavailable hosted CI requires the established local gates, not omitted
checks. Before migration/reload, verify the actual runtime path and preserve dirty
production changes. Health distinguishes liveness/build identity from true
readiness, ingestion freshness or successful Telegram delivery.

Production: `www-data@104.248.84.190`, `/var/www/hyper-summary-bot`, Bun/PM2 under
`/var/www/.bun/bin`, PM2 home `/var/www/.pm2`. Caddy handles HTTPS. Current health
endpoint: `https://hyper-summary-bot.mextner.com/healthz`.

## Evidence and housekeeping

`qa telegram bot-probe` checks HTTP liveness, release SHA and unsigned-webhook
rejection only. `qa telegram status` checks the actual browser session. Never label
transport-only probes or fake-browser tests as authenticated Telegram end-to-end
QA. Never publish a live QR or private browser/session state.

Delete merged worktrees/branches after checking clean state, merge or patch
reachability and active usage. Preserve dirty files, conflict stages and unique
commits before cleanup. A tag or branch does not preserve an uncommitted index.
Do not delete another agent's active work. Leave incomplete issues open with
specific acceptance criteria rather than closing them to make a dashboard green.

## User experience

Use Russian informal singular (ты), short factual messages, explicit source and
coverage. Never claim unfinished `/ask`, imports or scheduled digests are ready.
User errors must not expose stack traces, SQL or provider responses. Keep output
short, with useful source references; detailed archives are a separate mode.
