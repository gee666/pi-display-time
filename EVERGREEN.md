## Summary
- Shows running tool start/elapsed times without replacing tools or their renderers.
- Persists one compact row per tool batch and one summary per fully settled run.
- Timing entries are display-only, never model context; off mode still records.
- Uses public lifecycle, session, command, flag, widget, and entry-renderer APIs.
- No internal or undocumented Pi APIs are used.
- Main risks are event ordering, nested/parallel execution, cleanup, and terminal rendering.

## Intent
Make long-running and nested work visible immediately without duplicating arguments
or output. Remove each live line when its call completes, tick without tool updates,
and retain compact history across restarts and branches. Expanded history provides
individual durations and failure/interruption details. Measure elapsed time with a
monotonic clock; use wall time only for displayed dates.

## Pi integration (public APIs)
`ExtensionAPI.on` observes message/run/tool events, `turn_end`, settlement, and
session start/tree/shutdown. Nested tool events use `parentToolCallId`.
Actionable `turn_end` drafts place batch history after persisted tool results;
`appendEntry` stores final summaries and branch-local display settings.
`registerEntryRenderer` renders current and legacy entries using Pi TUI `Text`.
`registerCommand`, `registerFlag`, `getFlag`, and `sessionManager.getBranch`
provide display controls and branch restoration. `ctx.mode`, `ctx.hasUI`,
`ctx.ui.setWidget`, `setStatus`, `select`, and `notify` gate UI behavior.
TUI `truncateToWidth` keeps live lines within terminal columns.

## Internal Pi APIs
None. No private imports, monkey-patching, tool replacement, or renderer overrides.
Test fixtures also use public extension APIs, including nested `executeTool`,
provider payload hooks, compaction, and actionable settlement continuation.

## Weak points
Final settlement differs from `agent_end`: retries, compaction, and continuations
must not split totals. Final abort flags must override earlier completed outcomes.
Session replacement/tree navigation must clear live state and restore branch mode.
Live state cannot survive restart. Large batches create one line per active call.
Interactive terminal repainting, real transport retries/overflow, RPC transport,
and in-process session replacement are not covered by the CLI e2e test.

## Tests
`npm run test:evergreen` refreshes Pi dev packages to npm latest, typechecks,
then runs unit, integration, and e2e suites. No separate linter is configured.
`tests/timing.test.ts` protects monotonic durations, nested/concurrent accounting,
interruption, unknown starts, duplicate events, and compact duration formatting.
`tests/extension.integration.test.ts` integrates the tracker, extension handlers,
and real TUI utilities with a mocked host: immediate/ticking/removable live lines,
compact/expanded history, branch modes, non-TUI safety, cleanup, and settlement.
The concurrent interruption scenario protects low-noise history and abort totals.
`tests/cli.e2e.mjs` loads the actual extension in global Pi JSON CLI processes,
protecting nested success/failure grouping, persisted result ordering, one summary
across continuations, off-mode recording, restart/resume, and compaction.
Real serialized provider payloads must exclude display-only entries; a sentinel
negative control verifies the privacy assertion. Model errors fail the test.
E2e uses `EVERGREEN_PI_BIN` (fallback `pi`) with ignored stdin and requires
`EVERGREEN_E2E_MODEL` for model selection. Sessions are persisted in temporary files.

## Relevant changelog topics
Watch actionable turn boundaries and settlement/abort semantics; nested tool
events and IDs; custom-entry persistence/context exclusion and branch traversal;
UI mode guards, widget lifecycle, entry renderer contracts, and TUI width helpers.
