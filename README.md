# pi-display-time

A small [pi](https://github.com/earendil-works/pi-mono) extension that adds a persistent tool-execution timeline to the interactive transcript.

```text
3 parallel tools started — 2026-03-17 14:08:36
bash tool finished — 2026-03-17 14:10:49
read tool finished — 2026-03-17 14:11:02
subagents tool finished — 2026-03-17 21:39:42
```

For a batch containing one tool, the start entry names it:

```text
bash tool started — 2026-03-17 14:08:36
bash tool finished — 2026-03-17 14:10:49
```

Timeline entries use normal, dimmed, left-aligned text with no background. Parallel calls from the same assistant response share one start entry, while every tool gets its own finish entry.

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

The extension does not override or modify tool renderers, so built-in and custom tool displays remain unchanged.

## License

MIT
