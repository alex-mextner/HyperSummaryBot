# AGENTS.md — HyperSummaryBot

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

## Handler Ordering Rules (Критично!)

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
- Strict TypeScript: `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`
- `verbatimModuleSyntax` — use `import type` for type-only imports
- No `any`. Use `unknown` + type guards (zod if needed)
- Error handling: never silently swallow. Log and re-throw or return structured error
- AI calls: always wrap in try/catch with fallback to next provider
- Database: parameterized queries only (Drizzle handles this)
- Never commit `.env`. `.env.example` is the source of truth
- No `as any` / `as never` casts in production code
- No silent `catch` blocks — every catch must log or explain why swallowing is safe
- No silent optional-dependency guards — fail explicitly or warn + agentHint

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

**Mandatory before every commit (4-stage review, NEVER skip even if user says "commit"):**

1. **Self-review** — read your diff (`git diff --staged`), question every line
2. **Type-check + lint** — `bun x tsc --noEmit` + `bun run lint` must pass clean (zero errors, zero warnings)
3. **Codex AI review** — `codex exec review --uncommitted` → address every real issue
4. **Tests** — `bun test` (or scoped subset) must pass green

**If codex CLI is unavailable:** skip step 3 but do NOT skip the self-review in step 1. Codex is a sanity check, not a rubber stamp.

**Atomic commits:** one logical change = one commit. Never batch unrelated changes. Each commit must leave the tree green (type-check + lint + tests pass).

**Never `git add -A`** without checking `git status` first.

### Atomic Commits & Codex Review Policy

- **One logical change = one commit.** Batching unrelated fixes into a single commit is forbidden.
- **Codex review is mandatory** for every commit. Run `codex exec review --uncommitted` and address every P1/P2 issue before staging.
- If codex is unavailable, document this in the commit message (`[skip-codex] reason`) and double the self-review rigor.
- **Green tree rule:** `tsc --noEmit`, `oxlint`, and `bun test` must all pass with zero failures before the commit hash is created.
- **Never commit on behalf of the user** without explicit permission after the review cycle.

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

All user-facing bot messages must follow these rules:

- Address the user as **"ты"** (informal singular), never "вы"
- Speak directly to the person: "Ты получишь саммари", not "Пользователь получит"
- Frame features as user benefit, not technical capability
- **Front-load the essence** — first two words must be the most informative
- Don't instruct the user to do what the system does automatically
- Drop filler words — shorter is better

## Telegram Bot API Limits
- **Message**: 4096 chars. Split when may exceed.
- **Caption**: 1024 chars (silently fails for non-Premium)
- **callback_data**: 64 bytes
- **Rate**: ~30 msg/sec global, ~1/sec per chat
- **Entities**: max 100 per message

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
