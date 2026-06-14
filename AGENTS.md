# AGENTS.md — HyperSummaryBot

> **Portable dev rules live in the global agent-tools skills:**
> github.com/alex-mextner/agent-tools (`skills/universal/` + `skills/by-type/bot`).
> They cover the generic discipline this file used to spell out — gramio handler ordering,
> loadConfig-not-singleton, multi-provider AI fallback, no type escape hatches, no silent
> fallbacks, atomic commits, pre-commit gate, AI review before commit, telegram API limits,
> telegram tone-of-voice. This file keeps only what is **specific to HyperSummaryBot**
> (its architecture, file paths, commands, deploy, infra). Read both.

## Project Overview
Telegram group chat summary bot with AI-powered analysis.
Multi-agent system for different summary types and note extraction.

## Tech Stack
- **Runtime:** Bun (latest) — `bun --hot` for dev, `bun build --compile` for executable
- **Bot Framework:** GramIO (`gramio`) — TypeScript-first, `derive()` for context
- **Database:** SQLite (`bun:sqlite`) + Drizzle ORM
- **AI:** OpenAI SDK with multi-provider fallback chains (z.ai primary, HF, Gemini, Groq)
- **Lint/Format:** Oxlint + Oxfmt (or Biome fallback)
- **Testing:** `bun:test` (Jest-compatible)
- **Deploy:** DigitalOcean + PM2 + GitHub Actions

## Handler Ordering Rules

> Generic principle in global skill `bot/gramio-handler-ordering`. Concrete order for THIS
> bot below.

In GramIO, **handler order matters**. First matching handler processes the message.

```
1. bot.onError() — global error handler
2. bot.command("*") — all command handlers FIRST
3. bot.on("my_chat_member") — membership changes
4. bot.on("message", withGuard) — specific message handlers
5. bot.on("message") — catch-all message handlers LAST
```

**NEVER** put `bot.on("message")` before `bot.command()`. Commands are messages too and will be swallowed by a catch-all message handler.

**Pattern:** All command handlers must be declared before any `bot.on("message")` handler. Use specific guards (e.g., check `ctx.chat?.type === "private"`) in message handlers to avoid conflicts.

## Architecture Patterns

### 1. Config
- `loadConfig()` function (NOT singleton), returns typed `EnvConfig`
- Use `requireEnv()` for mandatory vars
- Validate formats (hex keys, numbers) inline
- Never read `process.env.*` directly in feature code — always use `config` object

### 2. AI Streaming
- `aiStreamRound(options, callbacks)` — multi-provider fallback chain
- `textEmitted` guard: never splice providers mid-stream
- Chain order: smart (z.ai → HF → Gemini), fast (z.ai fast → HF fast → Gemini fast)

### 3. Agent Loop
- Max 10 rounds, 60s timeout per round
- Tool deduplication via `toolCallKey(name, input)` — canonical JSON sorted keys
- Fast-chain validation if no tools called
- Handle z.ai quirk: `content=''` with only `reasoning_content` = retry next provider

### 4. Chat History
- SQLite: `messages` table (chat_id, user_id, role, content, created_at)
- `INSERT OR REPLACE` for message edits (composite PK: chat_id + message_id)
- Forward/reply enrichment: embed context in message text before storage
- Retention: 99999 messages per chat (prune old via cron or batch cleanup)
- Store chat titles (not just IDs) for user-facing messages

### 5. TelegramStreamWriter
- Send placeholder `⏳`, edit live as tokens arrive
- Tool indicators: `setToolLabel()` / `markToolResult()`
- HTML truncation safety: truncate at newline boundaries, close unclosed tags
- Chunking for >4000 chars: `sendRemainingChunks()`

### 6. System Prompts
- Dynamic assembly with sections: user info, chat context, rules, tools
- Include current date/time in user timezone
- [SKIP] signal support (machine-parsed, exact 6-char string)

## File Naming
- `kebab-case.ts` for files (`chat-history.ts`, `telegram-stream.ts`)
- `PascalCase` for classes (`SummaryBotAgent`, `TelegramStreamWriter`)
- `camelCase` for functions and variables

## Code Conventions

> Generic typing/error rules in global skills `no-type-escape-hatches` (no `any`/`as any`/
> `as never`; `unknown` + guards) and `backend/no-silent-fallbacks` (no silent `catch`, no
> silent optional-dependency guards — log or explain). Project-specific deltas:

- Strict TypeScript: `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`
- `verbatimModuleSyntax` — use `import type` for type-only imports
- AI calls: always wrap in try/catch with fallback to next provider
- Database: parameterized queries only (Drizzle handles this)
- Never commit `.env`. `.env.example` is the source of truth

## Error Handling

**Levels:**
1. **Command handlers** — try/catch, user-friendly message
2. **Bot-level** — `bot.onError()`, generic fallback
3. **Process-level** — log and continue (no crash on transient errors)

**User-facing errors:**
- Format: `"Something went wrong. Try again or use /help."`
- Never expose internals (stack traces, SQL queries)
- Never silently skip — return `{ success: false, error: '...' }` or log warning

## Logging
- Use `console.error` / `console.warn` with context objects
- Always pass errors as `{ err: error }`, never `{ error: String(error) }`
- Every `catch` must log or have a comment explaining WHY swallowing is safe
- Handle `.catch()` on fire-and-forget promises — at minimum log the error

## Git Workflow

> Generic discipline in global skills `atomic-commits`, `pre-commit-gate`,
> `ai-review-before-commit` (one logical change per commit; never `git add -A` blind; green
> tree before the commit hash; codex review every commit, document `[skip-codex] reason` when
> unavailable; never commit on the user's behalf without permission). HyperSummaryBot's
> concrete 4-stage gate (NEVER skip even if the user says "commit"):

1. **Self-review** — read your diff (`git diff --staged`), question every line
2. **Type-check + lint** — `bun x tsc --noEmit` + `bun run lint` must pass clean (zero errors, zero warnings)
3. **Codex AI review** — `codex exec review --uncommitted` → address every real issue
4. **Tests** — `bun test` (or scoped subset) must pass green

**Pre-commit hooks:** lint-staged runs oxfmt + oxlint automatically.

**CI/CD:** GitHub Actions → SSH → PM2 reload on every push to main.

## Multi-Provider AI Setup
- All providers use OpenAI SDK with different `baseURL`/`apiKey`
- z.ai: `https://api.z.ai/api/coding/paas/v4` (coding endpoint)
- HF: `https://router.huggingface.co/v1` (auto-routing)
- Gemini: `https://generativelanguage.googleapis.com/v1beta/openai/`
- Groq: `https://api.groq.com/openai/v1` (fastest, for voice)

## Bot Behavior
- ONLY responds to explicit commands in groups (no auto-spam)
- Available commands: `/start`, `/help`, `/summary`, `/ask`, `/search`, `/note`, `/digest`, `/connect_account`
- `/ask`, `/digest`, `/connect_account` respond in DM, not group
- Voice messages: download → Whisper (Groq) → text → stored in history
- MTProto: auto-import history from all user groups after `/connect_account`
- Silent background import — no spam to chat

## Tone of Voice (bot messages)

> Portable: global skill `bot/telegram-tone-of-voice` — address the user as informal "ты",
> speak directly to the person, frame features as user benefit, front-load the essence,
> drop filler, don't instruct the user to do what the system already does automatically.

## Telegram Bot API Limits

> Portable: global skill `bot/telegram-api-limits` — message 4096 chars (split when over),
> caption 1024 (silently fails for non-Premium), callback_data 64 bytes, rate ~30 msg/sec
> global / ~1/sec per chat, max 100 entities per message.

## Deployment
- **Host**: 104.248.84.190 (DigitalOcean)
- **User**: www-data
- **Path**: `/var/www/hyper-summary-bot`
- **PM2**: `pm2 reload hyper-summary-bot --update-env`
- **Bun**: `/var/www/.bun/bin/bun`
- **Logs**: `/var/www/hyper-summary-bot/logs/`

## Server Infrastructure
- **Reverse proxy: Caddy** (not nginx). Caddy runs as systemd service, config: `/etc/caddy/Caddyfile`.
- Caddy imports project configs via `import /var/www/*/Caddyfile`. Each project needs its own `Caddyfile` in `/var/www/<project>/` for reverse-proxy rules.
- **Webhook mode** requires a domain with valid SSL (Let's Encrypt). Bare IP won't work. Current deployment uses `https://log-viewer.invntrm.ru/webhook` (proxies to `localhost:3002`).
- **Caddy reload** works as `www-data` user: `caddy reload --config /etc/caddy/Caddyfile`.
- **PM2 resilience**: `autorestart: true`, `max_restarts: 10`, `min_uptime: 10s`, `max_memory_restart: 512M`. Process-level `uncaughtException` / `unhandledRejection` handlers prevent crashes.

## Error Handling (Updated)
- **Command handlers**: wrapped with `safeCommand()` — any unhandled exception is caught, logged with `[command:X]` prefix, and a user-friendly reply is sent (`"❌ Что-то пошло не так. Попробуй ещё раз или используй /help."`).
- **Bot-level**: `bot.onError()` logs all GramIO errors.
- **Process-level**: `process.on("uncaughtException")` and `process.on("unhandledRejection")` log and swallow — never crash the bot on transient errors.
