# pi-display-time

A small [pi](https://github.com/earendil-works/pi-mono) extension that adds a persistent tool-execution timeline to the interactive transcript.

```text
2026-08-05 23:15:01 - 3 parallel tools started
2026-08-05 23:18:02 - tools finished
```

A parallel batch gets one start entry and one finish entry. The finish entry appears when the final tool in that batch completes.

For a batch containing one tool, the entries name it:

```text
2026-08-05 23:15:01 - bash tool started
2026-08-05 23:18:02 - bash tool finished
```

Turn boundaries are marked too — one entry when a user prompt is sent, and one when the agent settles and waits for the next message:

```text
2026-08-05 23:14:58 - prompt sent
2026-08-05 23:18:04 - turn finished, took 3m 6s, started at 2026-08-05 23:14:58
```

Durations are rendered with the coarsest sensible units:

| Elapsed | Rendered |
| --- | --- |
| less than a minute | `42s` |
| less than an hour | `5m 36s` |
| less than a day | `1h 35m` |
| less than a week | `1d 20h 35m` |
| a week or more | `2w 3d 5h` |

Timeline entries use normal, dimmed, left-aligned text with no background.

## Install

Install directly from the GitHub repository:

```bash
pi install https://github.com/gee666/pi-display-time.git
```

Pi records the package in your user settings and loads the extension in future sessions. Restart pi after installation if it is already running.

To try the GitHub package for one run without installing it permanently:

```bash
pi -e https://github.com/gee666/pi-display-time.git
```

The equivalent git shorthand is:

```bash
pi install git:github.com/gee666/pi-display-time
```

For local development:

```bash
pi -e ./extensions/display-time.ts
```

## Persistence

The extension uses pi's public `appendEntry()` and `registerEntryRenderer()` APIs. Every timeline row is stored as a custom session entry, so it remains visible after reload, resume, fork, and restart. Entries are TUI-only and are not included in model context.

Custom entries are nodes in the session tree, parented to the current leaf, and pi persists a message entry only after extensions have handled its event. Writing a marker from an event that runs before that persistence (a user `message_start`, a `tool_execution_end`) would make the marker the *parent* of the message it describes, so it would still show up after `/tree` navigation or `/fork` even when its message was left behind. The extension therefore queues those markers (keeping the original timestamp) and writes them at the next settled point in the tree — the start of the assistant response, `turn_end`, or `agent_settled`. A fork or branch switch then shows only the timestamps that belong to that branch.

The extension does not override or modify tool renderers, so built-in and custom tool displays remain unchanged.

## License

MIT
