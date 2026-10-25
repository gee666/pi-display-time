import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Observe actual serialized requests, not reconstructed context. Never log headers.
export default function observe(pi: ExtensionAPI) {
  const path = process.env.DISPLAY_TIME_E2E_LOG;
  if (!path) throw new Error("DISPLAY_TIME_E2E_LOG is required");
  const log = (type: string, data: unknown) => appendFileSync(path, JSON.stringify({ type, data }) + "\n");
  pi.on("before_provider_request", event => {
    const payload = event.payload;
    const limited: unknown = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.fromEntries(Object.entries(payload).map(([key, value]: [string, unknown]) => [key,
        ["max_output_tokens", "max_tokens", "max_completion_tokens"].includes(key) && typeof value === "number" ? Math.min(value, 2048) : value]))
      : payload;
    log("request", limited);
    return limited;
  });
  pi.on("after_provider_response", event => { log("response", { status: event.status }); });
  pi.on("agent_end", () => { log("agent_end", {}); });
  pi.on("agent_settled", () => { log("settled", {}); });
  pi.on("session_before_compact", event => ({ compaction: {
    summary: "PROBE_COMPACTION_SENTINEL: Timing probe finished. Reply briefly.",
    firstKeptEntryId: event.branchEntries.at(-1)?.id ?? event.preparation.firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore,
  } }));
  pi.registerCommand("probe-prepare-compaction", {
    description: "Make a short test session compactable without sending padding to a model.",
    handler: async () => {
      pi.sendMessage({ customType: "probe-padding", content: "harmless compaction padding ".repeat(12_000), display: false });
      pi.appendEntry("probe-compaction-cut", {});
    },
  });
  let blockSettlement = false;
  pi.on("before_agent_start", event => {
    if (event.messageType === "user" && event.prompt.includes("PROBE_ABORT_AT_SETTLEMENT")) blockSettlement = true;
  });
  let continued = false;
  pi.on("agent_before_settle", async (_event, ctx) => {
    if (blockSettlement) {
      blockSettlement = false;
      ctx.ui.notify("PROBE_ABORT_READY", "info");
      await new Promise(resolve => setTimeout(resolve, 1500));
      return;
    }
    if (continued) return;
    continued = true;
    return { continue: true, entries: [{ type: "custom_message", customType: "probe-continuation", content: "Reply OK without tools.", display: false }] };
  });
  pi.registerTool({
    name: "timing_probe", label: "Timing probe", description: "Call once when requested to exercise nested timing.",
    parameters: Type.Object({}),
    prepareLoadout: () => ({ hiddenDeclarations: ["read"] }),
    async execute(_id, _params, _signal, _update, ctx) {
      await ctx.executeTool("read", { path: "package.json", limit: 1 });
      try { await ctx.executeTool("read", { path: "DISPLAY_TIME_MISSING_FILE_SENTINEL" }); } catch { /* Expected tool error. */ }
      return { content: [{ type: "text", text: "PROBE_TOOL_RESULT_SENTINEL" }], details: undefined };
    },
  });
  pi.registerCommand("probe-poison", {
    description: "Negative control: a display-only sentinel entry must not reach requests.",
    handler: async () => { pi.appendEntry("display-time", { text: "DISPLAY_ONLY_SENTINEL_7c31", timestamp: 1000 }); },
  });
}
