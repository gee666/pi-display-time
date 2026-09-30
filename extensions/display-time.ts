import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { cleanText, formatDuration, summarizeNames, TimingTracker, type TimingEntry } from "./timing.ts";

const ENTRY_TYPE = "display-time";
const SETTINGS_TYPE = "display-time-settings";
type Mode = "compact" | "summary" | "off";
interface LegacyEntry { text: string; timestamp: number }

export default function displayTime(pi: ExtensionAPI) {
  pi.registerFlag("display-time-zone", { description: "Timestamp timezone, e.g. Europe/Berlin", type: "string" });
  pi.registerFlag("display-time-locale", { description: "Timestamp locale, e.g. en-GB", type: "string" });
  pi.registerFlag("display-time-12h", { description: "Use a 12-hour clock", type: "boolean", default: false });
  pi.registerFlag("display-time-no-live", { description: "Disable live running-tool lines, keeping completion history", type: "boolean", default: false });

  const tracker = new TimingTracker();
  let mode: Mode = "compact";
  let outcome: TimingEntry["outcome"] = "completed";
  let timer: ReturnType<typeof setInterval> | undefined;
  let uiContext: ExtensionContext | undefined;
  let timeFormat: Intl.DateTimeFormat;
  let dateFormat: Intl.DateTimeFormat;
  let fullFormat: Intl.DateTimeFormat;

  function configureFormats(ctx?: ExtensionContext) {
    const locale = pi.getFlag("display-time-locale") as string | undefined;
    const timeZone = pi.getFlag("display-time-zone") as string | undefined;
    const hour12 = pi.getFlag("display-time-12h") === true;
    function create(locale?: string, timeZone?: string) {
      timeFormat = new Intl.DateTimeFormat(locale, { timeZone, hour12, hour: "2-digit", minute: "2-digit", second: "2-digit" });
      dateFormat = new Intl.DateTimeFormat(locale, { timeZone, year: "numeric", month: "short", day: "numeric" });
      fullFormat = new Intl.DateTimeFormat(locale, { timeZone, hour12, dateStyle: "medium", timeStyle: "long" });
    }
    try { create(locale, timeZone); }
    catch {
      create();
      if (ctx?.hasUI) ctx.ui.notify("display-time: invalid locale or timezone; using system defaults.", "warning");
    }
  }

  function stopLive() {
    if (timer) clearInterval(timer);
    timer = undefined;
    uiContext?.ui.setStatus(ENTRY_TYPE, undefined);
    uiContext?.ui.setWidget(ENTRY_TYPE, undefined);
    uiContext = undefined;
  }

  function updateLive() {
    if (!uiContext) return;
    const calls = tracker.activeCalls();
    if (!calls.length) {
      uiContext.ui.setWidget(ENTRY_TYPE, undefined);
      return;
    }
    if (!timeFormat) configureFormats();
    uiContext.ui.setWidget(ENTRY_TYPE, (_tui, theme) => ({
      render: (width: number) => calls.map(call => {
        let start = call.startedAt === undefined ? "unknown" : timeFormat.format(call.startedAt);
        // Include the date only for tools that started on a different local day.
        if (call.startedAt !== undefined && dateFormat.format(call.startedAt) !== dateFormat.format(Date.now())) {
          start = `${dateFormat.format(call.startedAt)} ${start}`;
        }
        const elapsed = call.elapsedMs === undefined ? "?" : formatDuration(call.elapsedMs);
        const label = `${"  ".repeat(call.depth)}${cleanText(call.name)}`;
        return truncateToWidth(`${theme.fg("dim", start)} · ${theme.fg("accent", elapsed)}  ${theme.fg("muted", label)}`, width);
      }),
      invalidate() {},
    }), { placement: "aboveEditor" });
  }

  function startLive(ctx: ExtensionContext) {
    if (mode === "off" || ctx.mode !== "tui" || pi.getFlag("display-time-no-live") === true) return;
    uiContext = ctx;
    updateLive();
    if (!timer) {
      timer = setInterval(updateLive, 1000);
      timer.unref();
    }
  }

  function render(data: TimingEntry, expanded: boolean, theme: Theme): string {
    const stamp = theme.fg("dim", `${dateFormat.format(data.finishedAt)} · `)
      + theme.fg("muted", timeFormat.format(data.finishedAt));
    const duration = theme.fg("accent", formatDuration(data.elapsedMs));
    const problems = [
      data.failedCalls ? `${data.failedCalls} failed` : "",
      data.interruptedCalls ? `${data.interruptedCalls} interrupted` : "",
    ].filter(Boolean).join(", ");
    let label: string;
    if (data.kind === "run") {
      label = data.outcome === "aborted" ? "Run aborted" : data.outcome === "error" ? "Run failed" : "Run finished";
      if (data.totalCalls) label += ` · ${data.totalCalls} tool call${data.totalCalls === 1 ? "" : "s"}`;
    } else {
      const roots = data.calls.filter(call => !call.parentId);
      const children = data.calls.filter(call => call.parentId);
      label = summarizeNames(roots) || "Tools";
      if (children.length) label += ` · ${children.length} nested: ${summarizeNames(children)}`;
      if (roots.length > 1) label = `${roots.length} tools · ${label}`;
    }
    const color = data.outcome === "error" || data.failedCalls ? "error"
      : data.outcome === "aborted" || data.interruptedCalls ? "warning" : "muted";
    let text = `${stamp}  ${theme.fg(color, label)} · ${duration}`;
    if (problems) text += ` · ${theme.fg(color, problems)}`;
    if (expanded) {
      text += `\n  ${theme.fg("dim", `${fullFormat.format(data.startedAt)} → ${fullFormat.format(data.finishedAt)}`)}`;
      const byId = new Map(data.calls.map(call => [call.id, call]));
      for (const call of data.calls.slice(0, 40)) {
        let depth = 0;
        let parent = call.parentId;
        const visited = new Set([call.id]);
        while (parent && !visited.has(parent) && depth < 4) {
          visited.add(parent);
          depth++;
          parent = byId.get(parent)?.parentId;
        }
        const time = call.startedAt === undefined ? "unknown start" : timeFormat.format(call.startedAt);
        const elapsed = call.elapsedMs === undefined ? "duration unknown" : formatDuration(call.elapsedMs);
        const state = call.status === "completed" ? "" : ` · ${call.status}`;
        text += `\n  ${"  ".repeat(depth)}${theme.fg("dim", time)}  ${theme.fg(call.status === "error" ? "error" : "muted", cleanText(call.name))} · ${elapsed}${state}`;
      }
      if (data.calls.length > 40) text += `\n  ${theme.fg("dim", `… ${data.calls.length - 40} more calls`)}`;
    }
    return text;
  }

  pi.registerEntryRenderer<TimingEntry | LegacyEntry>(ENTRY_TYPE, (entry, { expanded }, theme) => {
    if (!entry.data || mode === "off") return undefined;
    if (!timeFormat) configureFormats();
    const data = entry.data;
    // Old session files remain readable; never rewrite historical entries.
    if (!("version" in data)) {
      return new Text(theme.fg("dim", `${dateFormat.format(data.timestamp)} · ${timeFormat.format(data.timestamp)}  ${cleanText(data.text)}`), 1, 0);
    }
    if (mode === "summary" && data.kind === "tools") return undefined;
    return new Text(render(data, expanded, theme), 1, 0);
  });

  function reset(ctx: ExtensionContext) {
    stopLive();
    tracker.reset();
    outcome = "completed";
    mode = "compact";
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === SETTINGS_TYPE) {
        const value = (entry.data as { mode?: unknown } | undefined)?.mode;
        if (value === "compact" || value === "summary" || value === "off") mode = value;
      }
    }
    configureFormats(ctx);
  }

  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", () => { stopLive(); tracker.reset(); });

  pi.registerCommand("display-time", {
    description: "Timing display: compact, summary, or off. Saved on the current session branch.",
    handler: async (args, ctx) => {
      const value = args.trim() || (ctx.hasUI ? await ctx.ui.select("Timing display", ["compact", "summary", "off"]) : undefined);
      if (value === undefined) return;
      if (value !== "compact" && value !== "summary" && value !== "off") {
        if (ctx.hasUI) ctx.ui.notify("Usage: /display-time compact|summary|off", "warning");
        return;
      }
      mode = value;
      pi.appendEntry(SETTINGS_TYPE, { mode });
      if (mode === "off") stopLive();
      else if (tracker.live()) startLive(ctx);
      if (ctx.hasUI) ctx.ui.notify(`Timing display: ${mode}. Existing rows update when the transcript is rebuilt.`, "info");
    },
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "user") return;
    tracker.beginRun();
    startLive(ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    tracker.beginRun();
    startLive(ctx);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    tracker.start(event.toolCallId, event.toolName, event.parentToolCallId);
    startLive(ctx);
  });
  pi.on("tool_execution_end", event => {
    tracker.end(event.toolCallId, event.toolName, event.isError, event.parentToolCallId);
    updateLive();
  });

  // The boundary's tool messages are already persisted. Returning custom drafts
  // attaches summaries after those results, never before their owning messages.
  pi.on("turn_end", event => {
    outcome = event.outcome;
    const data = tracker.flush();
    if (!data) return;
    return { entries: [...event.entries, { type: "custom" as const, customType: ENTRY_TYPE, data }] };
  });
  // Explicit aborts can skip agent_before_settle. The final assistant and
  // turn_end events still carry the outcome; successful retries replace it.
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    outcome = event.message.stopReason === "aborted" ? "aborted"
      : event.message.stopReason === "error" ? "error" : "completed";
  });
  pi.on("agent_before_settle", event => { outcome = event.outcome; });
  pi.on("agent_settled", () => {
    // Only final settlement ends the timer, not an intermediate agent_end that
    // may be followed by retries, compaction, or another extension's continuation.
    const pending = tracker.flush();
    if (pending) pi.appendEntry(ENTRY_TYPE, pending);
    const data = tracker.finish(outcome);
    if (data) pi.appendEntry(ENTRY_TYPE, data);
    outcome = "completed";
    stopLive();
  });
}
