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

The extension does not override or modify tool renderers, so built-in and custom tool displays remain unchanged.

## License

MIT
