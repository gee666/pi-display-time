import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "display-time";

interface TimelineEntry {
  text: string;
  timestamp: number;
}

interface ToolBatch {
  ids: Set<string>;
  toolNames: string[];
  started: boolean;
}

function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");

  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(" ");
}

// Renders an elapsed duration with the coarsest sensible set of units:
//   < 1m   -> 42s
//   < 1h   -> 5m 36s
//   < 1d   -> 1h 35m
//   < 1w   -> 1d 20h 35m
//   >= 1w  -> 2w 3d 5h
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));

  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const totalDays = Math.floor(totalHours / 24);
  const days = totalDays % 7;
  const weeks = Math.floor(totalDays / 7);

  if (weeks > 0) return `${weeks}w ${days}d ${hours}h`;
  if (totalDays > 0) return `${totalDays}d ${hours}h ${minutes}m`;
  if (totalHours > 0) return `${totalHours}h ${minutes}m`;
  if (totalMinutes > 0) return `${totalMinutes}m ${seconds}s`;
  return `${totalSeconds}s`;
}

export default function displayTime(pi: ExtensionAPI) {
  const batchesByToolCall = new Map<string, ToolBatch>();
  let turnStartedAt: number | undefined;

  // Custom entries are stored as nodes in the session tree, parented to the
  // current leaf. Pi persists a message entry only *after* extensions handle
  // its event, so appending from an event that precedes persistence (user
  // `message_start`, `tool_execution_end`) would make our entry the parent of
  // that message. Such an entry then survives `/tree` navigation and `/fork`
  // even when the message it belongs to is left behind, showing timestamps that
  // do not belong to the current branch.
  //
  // So entries whose message is not persisted yet are queued and flushed at the
  // next point where the tree is settled. Timestamps are captured when the
  // event fires, not when the entry is flushed.
  const pendingEntries: TimelineEntry[] = [];

  const flushPendingEntries = () => {
    if (pendingEntries.length === 0) return;

    const entries = pendingEntries.splice(0, pendingEntries.length);
    for (const entry of entries) pi.appendEntry<TimelineEntry>(ENTRY_TYPE, entry);
  };

  // Safe to write straight away: everything before this event is persisted.
  const appendTimelineEntry = (text: string, timestamp = Date.now()) => {
    flushPendingEntries();
    pi.appendEntry<TimelineEntry>(ENTRY_TYPE, { text, timestamp });
  };

  // Deferred: the message this entry describes is not persisted yet.
  const queueTimelineEntry = (text: string, timestamp = Date.now()) => {
    pendingEntries.push({ text, timestamp });
  };

  pi.registerEntryRenderer<TimelineEntry>(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return undefined;

    return new Text(
      theme.fg("dim", `${formatDateTime(data.timestamp)} - ${data.text}`),
      1,
      0,
    );
  });

  // A user prompt opens a turn: mark it and remember when the clock started.
  // The prompt entry is queued and written once the user message itself is in
  // the session (by then the assistant response is starting), so the marker
  // ends up as a child of the prompt instead of its parent.
  pi.on("message_start", (event) => {
    if (event.message.role === "user") {
      const timestamp = Date.now();
      turnStartedAt ??= timestamp;
      queueTimelineEntry("prompt sent", timestamp);
      return;
    }

    if (event.message.role === "assistant") flushPendingEntries();
  });

  // Tool results of this turn are persisted by now, so queued tool-finish
  // markers can be written at their correct place in the tree.
  pi.on("turn_end", () => {
    flushPendingEntries();
  });

  // agent_settled fires once the agent is done and waits for the next user
  // message (no retry, compaction, or queued continuation pending).
  pi.on("agent_settled", () => {
    flushPendingEntries();
    const startedAt = turnStartedAt;
    turnStartedAt = undefined;
    if (startedAt === undefined) return;

    const finishedAt = Date.now();
    appendTimelineEntry(
      `turn finished, took ${formatDuration(finishedAt - startedAt)}, started at ${formatDateTime(startedAt)}`,
      finishedAt,
    );
  });

  // One assistant response may request several tools. Pi executes such a batch
  // in parallel by default, so all calls share one start marker.
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;

    const calls = event.message.content.filter(
      (part): part is Extract<(typeof event.message.content)[number], { type: "toolCall" }> =>
        part.type === "toolCall",
    );
    if (calls.length === 0) return;

    const batch: ToolBatch = {
      ids: new Set(calls.map((call) => call.id)),
      toolNames: calls.map((call) => call.name),
      started: false,
    };

    for (const call of calls) batchesByToolCall.set(call.id, batch);
  });

  pi.on("tool_execution_start", (event) => {
    let batch = batchesByToolCall.get(event.toolCallId);

    // Defensive fallback for tools started without a preceding assistant
    // message event (for example, a future execution path added by pi).
    if (!batch) {
      batch = {
        ids: new Set([event.toolCallId]),
        toolNames: [event.toolName],
        started: false,
      };
      batchesByToolCall.set(event.toolCallId, batch);
    }

    if (batch.started) return;
    batch.started = true;

    if (batch.ids.size > 1) {
      appendTimelineEntry(`${batch.ids.size} parallel tools started`);
    } else {
      appendTimelineEntry(`${event.toolName} tool started`);
    }
  });

  pi.on("tool_execution_end", (event) => {
    const batch = batchesByToolCall.get(event.toolCallId);
    if (!batch) {
      queueTimelineEntry(`${event.toolName} tool finished`);
      return;
    }

    batch.ids.delete(event.toolCallId);
    batchesByToolCall.delete(event.toolCallId);

    // A parallel batch gets one finish marker, emitted when its final tool ends.
    if (batch.ids.size === 0) {
      queueTimelineEntry(batch.toolNames.length > 1 ? "tools finished" : `${event.toolName} tool finished`);

      for (const [toolCallId, candidate] of batchesByToolCall) {
        if (candidate === batch) batchesByToolCall.delete(toolCallId);
      }
    }
  });

  pi.on("session_shutdown", () => {
    batchesByToolCall.clear();
    pendingEntries.length = 0;
    turnStartedAt = undefined;
  });
}
