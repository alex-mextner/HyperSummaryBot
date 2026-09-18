# AI execution contract — 2026-09-18

Base: bc1e063. Review found two compat gaps: final frames without delta and
providers finishing valid requested tool calls with stop. Both were reproduced
as failures before the fix and covered by regression tests after it.

The new adapter rejects cancelled/late output even when a transport ignores abort,
reserves deadline budget for one fallback, never forwards failed-attempt deltas,
validates terminal finish state, bounds tool/output sizes, and distinguishes
401/403 configuration errors from transient 429/network/5xx errors. Logs expose
error categories rather than provider payloads. Missing terminal frames and
truncated responses are errors, not successful summaries.

Only provider-boundary fixtures have been executed so far. These tests are not
live model latency measurements, end-to-end Telegram QA or a semantic grounding
benchmark. Source-ID membership by itself does not prove factual entailment.

Read-only review was run through review-cli; available Opus and Sonnet reviews
were read and addressed. Timed-out board seats are not counted as review passes.
