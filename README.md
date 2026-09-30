# pi-display-time

Live start times for running tools, plus a compact, persistent timing history for [Pi](https://github.com/earendil-works/pi).

Requires Pi 0.99.1 or newer and Node.js 22.19 or newer. Uses only public APIs. Never replaces tools or their renderers.

## While tools run

A borderless widget above the editor shows one line per currently running tool:

```text
18:54:54 · 13.7 s  codemode
18:54:55 · 12.7 s    bash
18:55:02 · 5.7 s     read
```

Each line shows the **start time, elapsed time, and tool name**. No repeated commands, arguments, output, heading, or box. Nested calls are indented, including calls inside codemode.

- Lines appear immediately when execution starts.
- Elapsed times update every second even if a tool stops producing output.
- Each completed call disappears immediately; any still-running call stays visible.
- The widget disappears when no tools are running.
- Lines truncate to the terminal width rather than wrapping.
- A tool that started on an earlier date also shows its start date.

This live-updating text is the panel; there is no separate window. It reports execution duration, not inactivity or a diagnosis that a tool is stuck. Large concurrent batches produce one line per active call.

## Completion history

Completed work gets one compact transcript row per assistant tool batch, not a start and finish row for every nested call:

```text
Sep 29, 2026 · 18:55:08  codemode · 4 nested: bash, read ×3 · 14 s
Sep 29, 2026 · 18:55:12  Run finished · 5 tool calls · 18 s
```

The batch row is written at the end-of-turn boundary, after Pi persists the tool results. Calls within a still-running codemode invocation remain in the live display until they finish; their history is grouped with that invocation.

Expand the transcript entry with Pi's tool-output expansion control to see start/end timestamps with timezone and individual call durations. Expanded entries show up to 40 calls, followed by an omitted-call count. The stored entry retains all call timings.

Failures and interrupted calls are marked separately. The run summary appears only when Pi fully settles, including retries, compaction, and queued continuations. Counts include both parent and nested calls. Batch time is wall elapsed execution time, not the sum of overlapping calls.

## Display options

```text
/display-time compact
/display-time summary
/display-time off
```

- `compact`: live running lines, batch summaries, and run summaries. Default.
- `summary`: live running lines and run summaries, without batch history rows.
- `off`: hide timing UI. Timing data is still recorded.

Run `/display-time` without arguments to select a mode. The choice is saved on the current session branch. Already-rendered history rows update when Pi rebuilds the transcript, for example after reload or resume.

Optional startup flags:

```bash
pi --display-time-zone Europe/Berlin --display-time-locale en-GB
pi --display-time-12h
pi --display-time-no-live
```

The default is the system locale and timezone with a 24-hour clock. Invalid locale/timezone settings fall back to system defaults with a warning. Date formatting uses native `Intl`, with no additional runtime dependency.

## Install

```bash
pi install https://github.com/gee666/pi-display-time.git
```

For one local run:

```bash
pi -ne -e .
```

Or load only the extension file:

```bash
pi -e ./extensions/display-time.ts
```

Run `/reload` after updating the extension, or restart Pi.

## Persistence and compatibility

History uses public `appendEntry()`, actionable `turn_end` drafts, and `registerEntryRenderer()`. Entries are display-only and never enter model context. Timing summaries follow their tool-result messages in the session tree, preserving branch/fork behavior. Timers and live state are cleared on session replacement, shutdown, and tree navigation.

Elapsed durations use a monotonic clock, so system clock adjustments do not distort them. Dates use wall-clock timestamps. The live widget is TUI-only; JSON, print, and RPC sessions can still record history without starting a UI timer. Live execution state does not survive a process restart.

Existing sessions containing the older start/finish entries remain readable. They are not rewritten or automatically merged.

Pi supplies `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` at runtime. Their peer ranges follow Pi's package convention; the minimum supported host version is 0.99.1.

## Development

```bash
npm install --ignore-scripts
npm run check
npm test
```

Tests cover nested/concurrent execution, immediate live starts, ticking without tool updates, completion removal, narrow widths, branch cleanup, aborts, retries, clock adjustments, and legacy rendering.

## License

MIT
