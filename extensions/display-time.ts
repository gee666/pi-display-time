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

export default function displayTime(pi: ExtensionAPI) {
  const batchesByToolCall = new Map<string, ToolBatch>();

  const appendTimelineEntry = (text: string, timestamp = Date.now()) => {
    pi.appendEntry<TimelineEntry>(ENTRY_TYPE, { text, timestamp });
  };

  pi.registerEntryRenderer<TimelineEntry>(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return undefined;

    return new Text(
      theme.fg("dim", `${data.text} — ${formatDateTime(data.timestamp)}`),
      1,
      0,
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
    appendTimelineEntry(`${event.toolName} tool finished`);

    const batch = batchesByToolCall.get(event.toolCallId);
    if (!batch) return;

    batch.ids.delete(event.toolCallId);
    batchesByToolCall.delete(event.toolCallId);

    if (batch.ids.size === 0) {
      for (const [toolCallId, candidate] of batchesByToolCall) {
        if (candidate === batch) batchesByToolCall.delete(toolCallId);
      }
    }
  });

  pi.on("session_shutdown", () => {
    batchesByToolCall.clear();
  });
}
