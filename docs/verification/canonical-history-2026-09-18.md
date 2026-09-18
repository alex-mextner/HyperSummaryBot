# Canonical message history — 2026-09-18

The v2 migration adds nullable source_created_at/source_edited_at, thread_id,
source_kind, content_kind and content_version without guessing old dates.
Legacy created_at stays first-ingestion time. Rows with no authoritative source
date remain unknown and are excluded from source-time filters; latest-message
selection uses stable per-chat Telegram message IDs, not import insertion order.

Both Bot API new/edit events and MTProto history/new/edit paths supply source
metadata. Cross-chat reply IDs are not mislabeled as same-chat references.
Historical reimport repairs dates even when no sender display name is available.
Repeated placeholders cannot overwrite successful transcriptions. Older edits
cannot replace newer content. Changed source/content metadata increments a
version for subsequent cache invalidation work; identical replay does not.

Tests share the actual production migration rather than a second hand-written
schema. The initial seven regression scenarios all failed before these changes.
Additional tests exercise source-second normalization, contextual prompt metadata,
source-ID privacy, real importer date backfill and late transcription failure.

This release does not claim complete archive coverage, persistent import cursors,
soft-delete reconciliation or semantic entailment verification. Those remain
separate tracked acceptance criteria. Source-ID existence alone is not proof of
factual support. No real user message text belongs in this verification document.

Sources: Telegram Bot API Message.date/edit_date (Unix seconds), official mtcute
Message.date/editDate/RepliedMessageInfo.threadId, and the installed GramIO
MessageContext.payload type. Runtime versions were inspected before integration.

Production-shaped rehearsal on a consistent server-side SQLite backup completed:
743 rows before and after; SHA-256 fingerprint of all original message fields
unchanged; second migration run is a no-op; integrity_check=ok. Source dates known
remain 0, correctly: the migration does not invent historical source timestamps.
The backup remains private on the authorized server, not in this repository.
`bun scripts/rehearse-migration.ts <consistent-backup.db>` reproduces the check.

Review correction: persistence now returns inserted/updated/unchanged outcomes,
so import counters are mutually exclusive. Date support is intentional because
mtcute 0.29.7 high-level events expose Date, unlike raw TL/Bot API epoch seconds.
