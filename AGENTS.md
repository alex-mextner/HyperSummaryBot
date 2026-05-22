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

## Architecture Patterns (from reference bots)

### 1. Config
- `loadConfig()` function (NOT singleton), returns typed `EnvConfig`
- Use `requireEnv()` for mandatory vars
- Validate formats (hex keys, numbers) inline

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

## Git Workflow
- Atomic commits with clear messages
- Use `codex exec review --uncommitted` before each commit for sanity check
- Pre-commit hooks: lint + format (lint-staged)
- CI runs on every push: type-check, lint, format-check
- Deploy via GitHub Actions → SSH → PM2 reload

## Multi-Provider AI Setup
- All providers use OpenAI SDK with different `baseURL`/`apiKey`
- z.ai: `https://api.z.ai/api/coding/paas/v4` (coding endpoint)
- HF: `https://router.huggingface.co/v1` (auto-routing)
- Gemini: `https://generativelanguage.googleapis.com/v1beta/openai/`
- Groq: `https://api.groq.com/openai/v1` (fastest, for voice)

## Bot Behavior
- ONLY responds to explicit commands in groups (no auto-spam)
- Available commands: `/start`, `/help`, `/summary`, `/ask`, `/search`, `/note`, `/config`, `/digest`
- `/ask` and `/digest` respond in DM, not group
- Voice messages: download → ffmpeg → Whisper (Groq) → text → summary
