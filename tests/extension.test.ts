import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import displayTime from "../extensions/display-time.ts";

function harness(mode = "tui") {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const renderers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const flags = new Map<string, unknown>();
  const entries: any[] = [];
  const theme = { fg: (_color: string, text: string) => text };
  let widget: any;
  const ctx = {
    mode, hasUI: mode === "tui", sessionManager: { getBranch: () => entries },
    ui: { theme, setWidget: (_key: string, value: any) => { widget = value; }, setStatus() {}, notify() {} },
  };
  const api = {
    on: (event: string, handler: any) => handlers.set(event, handler),
    registerFlag: (name: string, options: any) => flags.set(name, options.default),
    getFlag: (name: string) => flags.get(name),
    registerEntryRenderer: (name: string, renderer: any) => renderers.set(name, renderer),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    registerTool: () => assert.fail("Must never replace tools"),
  };
  displayTime(api as unknown as ExtensionAPI);
  const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  emit("session_start");
  return {
    emit, entries, flags, ctx,
    command: (args: string) => commands.get("display-time").handler(args, ctx),
    lines: (width = 100) => widget ? widget({}, theme).render(width) as string[] : [],
    render: (data: any, expanded = false) => renderers.get("display-time")!({ data }, { expanded }, theme)?.render(180).join("\n"),
  };
}

test("live widget shows starts immediately, fits narrow terminals, and removes completed calls", () => {
  const h = harness();
  try {
    h.emit("tool_execution_start", { toolCallId: "root", toolName: "codemode" });
    h.emit("tool_execution_start", { toolCallId: "nested", parentToolCallId: "root", toolName: "read", args: { path: "src/config.ts" } });
    assert.equal(h.lines().length, 2);
    assert.match(h.lines()[0], /\d{2}:\d{2}:\d{2}.*codemode/);
    assert.match(h.lines()[1], /read/);
    assert.doesNotMatch(h.lines()[1], /config|src/);
    assert.equal(h.entries.length, 0, "No transcript writes before tool messages persist");
    for (const line of h.lines(25)) assert.ok(visibleWidth(line) <= 25);
    h.emit("tool_execution_end", { toolCallId: "nested", parentToolCallId: "root", toolName: "read", isError: false });
    assert.equal(h.lines().length, 1);
    h.emit("tool_execution_end", { toolCallId: "root", toolName: "codemode", isError: false });
    assert.deepEqual(h.lines(), []);
    const preceding = { type: "custom", customType: "other", data: {} };
    const result = h.emit("turn_end", { entries: [preceding] });
    assert.equal(result.entries[0], preceding);
    assert.equal(result.entries.length, 2);
    const data = result.entries[1].data;
    assert.match(h.render(data), /codemode · 1 nested: read/);
    assert.match(h.render(data, true), /read/);
    h.emit("agent_before_settle", { outcome: "completed" });
    h.emit("agent_settled");
    assert.equal(h.entries.length, 1);
    assert.equal(h.entries[0].data.totalCalls, 2);
  } finally { h.emit("session_shutdown"); }
});

test("live duration keeps ticking without tool updates", async () => {
  const h = harness();
  try {
    h.emit("tool_execution_start", { toolCallId: "stuck", toolName: "bash", args: { command: "sleep 999" } });
    const before = h.lines()[0];
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.notEqual(h.lines()[0], before);
    assert.match(h.lines()[0], /(?:9\d\d ms|1(?:\.\d+)? s).*bash/);
  } finally { h.emit("session_shutdown"); }
});

test("session tree navigation removes stale live state", () => {
  const h = harness();
  h.emit("tool_execution_start", { toolCallId: "old", toolName: "bash" });
  h.emit("session_tree");
  assert.deepEqual(h.lines(), []);
  h.emit("agent_settled");
  assert.equal(h.entries.length, 0);
});

test("non-TUI operation persists timing without creating widgets", () => {
  const h = harness("json");
  h.emit("tool_execution_start", { toolCallId: "a", toolName: "read" });
  assert.deepEqual(h.lines(), []);
  h.emit("agent_before_settle", { outcome: "aborted" });
  h.emit("agent_settled");
  assert.equal(h.entries[0].data.interruptedCalls, 1);
  assert.equal(h.entries[1].data.outcome, "aborted");
});

test("display settings retain timing data, restore from branch, and render legacy entries", async () => {
  const h = harness();
  try {
    assert.match(h.render({ timestamp: 1_000_000, text: "prompt sent" }), /prompt sent/);
    await h.command("off");
    h.emit("tool_execution_start", { toolCallId: "a", toolName: "read" });
    assert.deepEqual(h.lines(), []);
    h.emit("agent_settled");
    assert.equal(h.entries.length, 3);
    assert.equal(h.render(h.entries[1].data), undefined);
    await h.command("summary");
    assert.equal(h.render(h.entries[1].data), undefined);
    assert.match(h.render(h.entries[2].data), /Run finished/);
    h.emit("session_tree");
    assert.equal(h.render(h.entries[1].data), undefined);
  } finally { h.emit("session_shutdown"); }
});

test("invalid locale and timezone fall back safely; live text strips terminal controls", () => {
  const h = harness();
  h.flags.set("display-time-zone", "not/a/timezone");
  h.emit("session_start");
  try {
    h.emit("tool_execution_start", { toolCallId: "a", toolName: "bash\n\x1b]0;bad title\x07\x1b[31m", args: { command: "echo secret" } });
    assert.equal(h.lines().length, 1);
    assert.doesNotMatch(h.lines()[0], /[\n\x1b]/);
  } finally { h.emit("session_shutdown"); }
});


test("explicit abort is retained when Pi skips agent_before_settle", () => {
  const h = harness();
  try {
    h.emit("agent_start");
    h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } });
    h.emit("turn_end", { entries: [], outcome: "aborted" });
    h.emit("agent_settled");
    assert.equal(h.entries[0].data.outcome, "aborted");
    assert.match(h.render(h.entries[0].data), /Run aborted/);
  } finally { h.emit("session_shutdown"); }
});

test("successful retry replaces an earlier error outcome", () => {
  const h = harness();
  try {
    h.emit("agent_start");
    h.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
    h.emit("agent_start");
    h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
    h.emit("agent_settled");
    assert.equal(h.entries[0].data.outcome, "completed");
  } finally { h.emit("session_shutdown"); }
});
