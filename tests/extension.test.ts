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
    mode, hasUI: mode === "tui" || mode === "rpc", sessionManager: { getBranch: () => entries },
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

test("settlement abort flag overrides a completed assistant and settlement boundary", () => {
  const h = harness("rpc");
  h.emit("agent_start");
  h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
  h.emit("turn_end", { entries: [], outcome: "completed" });
  h.emit("agent_before_settle", { outcome: "completed" });
  h.emit("agent_settled", { aborted: true });
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].data.outcome, "aborted");
});

test("continuations, retries and compaction do not finalize or reset a running total", () => {
  const h = harness("json");
  h.emit("message_start", { message: { role: "user" } });
  h.emit("agent_start");
  h.emit("tool_execution_start", { toolCallId: "one", toolName: "bash" });
  h.emit("tool_execution_end", { toolCallId: "one", toolName: "bash", isError: true });
  const first = h.emit("turn_end", { entries: [], outcome: "error" });
  assert.equal(first.entries[0].data.failedCalls, 1);
  h.emit("agent_end");
  h.emit("compaction_start", { reason: "overflow" });
  h.emit("compaction_end", { reason: "overflow", aborted: false, willRetry: true });
  h.emit("agent_before_settle", { outcome: "error" });
  h.emit("agent_start");
  h.emit("message_start", { message: { role: "user" } }); // queued input in the same unsettled run
  h.emit("tool_execution_start", { toolCallId: "two", toolName: "read" });
  h.emit("tool_execution_end", { toolCallId: "two", toolName: "read", isError: false });
  const second = h.emit("turn_end", { entries: [], outcome: "completed" });
  assert.equal(second.entries[0].data.totalCalls, 1);
  assert.equal(h.entries.length, 0, "Only final settlement writes a run summary");
  h.emit("agent_settled");
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].data.totalCalls, 2);
  assert.equal(h.entries[0].data.failedCalls, 1);
  assert.equal(h.entries[0].data.outcome, "completed");
  h.emit("agent_settled");
  assert.equal(h.entries.length, 1, "settlement is idempotent");
  h.emit("agent_start");
  h.emit("agent_settled");
  assert.equal(h.entries[1].data.totalCalls, 0);
});

test("branch settings use the last valid active-branch value, not abandoned settings", async () => {
  const h = harness();
  await h.command("off");
  h.entries.splice(0); // navigate to a branch before the off setting
  h.emit("session_tree");
  h.emit("tool_execution_start", { toolCallId: "visible", toolName: "read" });
  assert.equal(h.lines().length, 1, "default compact is restored on branches without settings");
  h.entries.push({ type: "custom", customType: "display-time-settings", data: { mode: "summary" } });
  h.entries.push({ type: "custom", customType: "display-time-settings", data: { mode: "invalid" } });
  h.emit("session_tree");
  h.emit("agent_start");
  h.emit("agent_settled");
  assert.match(h.render(h.entries.at(-1).data), /Run finished/);
  const length = h.entries.length;
  await h.command("invalid");
  assert.equal(h.entries.length, length);
  h.emit("session_shutdown");
  h.emit("session_shutdown");
  assert.deepEqual(h.lines(), []);
});

test("no-live and all non-TUI modes suppress widgets without suppressing history", () => {
  for (const mode of ["tui", "rpc", "json", "print"]) {
    const h = harness(mode);
    h.flags.set("display-time-no-live", true);
    h.emit("agent_start");
    h.emit("tool_execution_start", { toolCallId: "a", toolName: "read" });
    assert.deepEqual(h.lines(), []);
    h.emit("agent_settled");
    assert.equal(h.entries.length, 2);
    assert.equal(h.entries[0].data.interruptedCalls, 1);
    assert.equal(h.entries[1].data.totalCalls, 1);
    h.emit("session_shutdown");
  }
});

test("default live settings never create terminal widgets in RPC, JSON or print mode", () => {
  for (const mode of ["rpc", "json", "print"]) {
    const h = harness(mode);
    assert.equal(h.flags.get("display-time-no-live"), false);
    h.emit("agent_start");
    h.emit("tool_execution_start", { toolCallId: "a", toolName: "read" });
    assert.deepEqual(h.lines(), [], `${mode} must not receive a terminal component even with live display enabled`);
    h.emit("tool_execution_end", { toolCallId: "a", toolName: "read", isError: false });
    const boundary = h.emit("turn_end", { entries: [], outcome: "completed" });
    assert.equal(boundary.entries[0].data.totalCalls, 1);
    h.emit("agent_settled", { aborted: false });
    assert.equal(h.entries[0].data.totalCalls, 1);
    h.emit("session_shutdown");
  }
});

test("live calls crossing local midnight gain a start date", t => {
  let now = Date.UTC(2000, 0, 1, 23, 59, 59);
  t.mock.method(Date, "now", () => now);
  const h = harness();
  h.flags.set("display-time-zone", "UTC");
  h.flags.set("display-time-locale", "en-US");
  h.emit("session_start");
  try {
    h.emit("tool_execution_start", { toolCallId: "midnight", toolName: "read" });
    assert.doesNotMatch(h.lines()[0], /Jan 1, 2000/);
    now += 2000;
    assert.match(h.lines()[0], /Jan 1, 2000.*23:59:59/);
  } finally { h.emit("session_shutdown"); }
});

test("clock flags, wide text and expansion limits preserve display intent", () => {
  const h = harness();
  h.flags.set("display-time-zone", "UTC");
  h.flags.set("display-time-locale", "en-US");
  h.flags.set("display-time-12h", true);
  h.emit("session_start");
  const call = { id: "a", name: "工具😀", startedAt: Date.UTC(2000, 0, 1, 13), finishedAt: Date.UTC(2000, 0, 1, 14), elapsedMs: 3, status: "completed" };
  const data = { version: 2, kind: "tools", startedAt: call.startedAt, finishedAt: call.finishedAt, elapsedMs: 3, calls: Array.from({ length: 42 }, (_, i) => ({ ...call, id: String(i) })), totalCalls: 42, failedCalls: 0, interruptedCalls: 0 };
  const expanded = h.render(data, true);
  assert.match(expanded, /02:00:00 PM/);
  assert.match(expanded, /Jan 1, 2000/);
  assert.match(expanded, /2 more calls/);
  assert.equal((expanded.match(/01:00:00 PM/g) ?? []).length, 40);
  h.emit("tool_execution_start", { toolCallId: "wide", toolName: "工具😀" });
  for (const width of [1, 2, 5, 20]) for (const line of h.lines(width)) assert.ok(visibleWidth(line) <= width);
  h.emit("session_shutdown");
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
