# Verified completion ledger — 2026-09-18

## Integrated changes

PRs 36–39: authenticated webhook/build health; hard AI deadlines and isolated
provider attempts; recovered trusted MTProto admin lifecycle; canonical source
history with thread/edit/content version metadata. Their changes were reviewed,
tested, merged and deployed. Runtime SHA before this documentation-only change:
8e84fd0ab6314bea2276ef8578346967f5a2ae9a.

Production checks: HTTP health 200; unsigned webhook 401; exact SHA matches.
`qa-cli 0.3.3` emitted a passing `http_transport_only` report at
2026-09-18T14:05:07Z. Authenticated Telegram command QA was not run: browser session
was logged-out. The report does not claim chat delivery or summary correctness.

DB: 743 messages, 0 duplicate key groups, integrity ok, both schema migrations
recorded. After startup reconciliation, 445 source dates were recovered and
298 remain explicitly unknown. On the consistent pre-migration copy, all 743
original rows/fields were unchanged and a second migration run was a no-op.
Local test gate: 189 tests passed, plus typecheck/lint/format. qa-cli tests:
69 passed, 1 opt-in live test skipped on both Python 3.9 and 3.12.

## Existing work disposition

The old admin-auth branch's useful scripts/session tests were recovered and
improved in PR 38. Old docs-branch source changes already existed in main; its
agent guidance is superseded by the current AGENTS.md. Already merged feature
branches/worktrees can be removed after checking no active process owns them.

The unresolved lint-infra draft is NOT part of the running application. Its
working files, staged blobs, conflict/index metadata and all refs were preserved
and verified in a private recovery archive before cleanup. Enabling thousands of
untested generated lint-policy lines during a production repair is not a safe
merge. This draft is retained for explicit later reconciliation, not silently
reported as implemented. No unrelated repository worktrees are in scope.

## Remaining work — not closed by this ledger

Canonical migrated-group ID aliases; durable jobs/idempotent delivery; resumable
import cursors and deletion reconciliation; capability-aware provider selection;
semantic quality benchmark and per-item factual support; summary cache/cursors;
complete search/Q&A, file import, Notion export and scheduled digests. Live
Telegram scan-to-login and full command QA still require an authenticated session.
These are tracked issues, not completed features.

## Reference worth adapting

`escape0707/telegram-summary-bot` separates enqueue-only webhook handling,
lease-ownership checks, delivery retry categories and synthetic-vs-real telemetry.
Those design ideas fit the pending durable-job work. It is AGPL-3.0; no code was
copied into this repository and adopting its code would need a license decision.
Reference: https://github.com/escape0707/telegram-summary-bot
