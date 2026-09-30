import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, summarizeNames, TimingTracker } from "../extensions/timing.ts";

function clock() {
  let wall = 1_000_000;
  let tick = 0;
  const tracker = new TimingTracker(() => wall, () => tick);
  return { tracker, advance(ms: number) { wall += ms; tick += ms; }, shiftWall(ms: number) { wall += ms; } };
}

test("duration formatting handles fast calls and unit boundaries", () => {
  for (const [ms, expected] of [[0, "0 ms"], [-1, "0 ms"], [84.9, "84 ms"], [999.9, "999 ms"], [1000, "1 s"], [2450, "2.5 s"], [59_950, "1m 0s"], [3_661_000, "1h 1m"], [90_000_000, "1d 1h 0m"], [604_800_000, "1w 0d 0h"]] as const) {
    assert.equal(formatDuration(ms), expected);
  }
});

test("nested calls appear immediately and only running calls remain", () => {
  const c = clock();
  c.tracker.start("root", "codemode");
  c.advance(100);
  c.tracker.start("root/1", "read", "root");
  c.tracker.start("root/2", "bash", "root");
  c.advance(200);
  assert.deepEqual(c.tracker.activeCalls().map(x => [x.name, x.depth, x.elapsedMs]), [["codemode", 0, 300], ["read", 1, 200], ["bash", 1, 200]]);
  assert.equal(c.tracker.activeCalls()[1].startedAt, 1_000_100);
  c.tracker.end("root/1", "read", false, "root");
  assert.deepEqual(c.tracker.activeCalls().map(x => x.name), ["codemode", "bash"]);
  c.advance(500);
  c.tracker.end("root/2", "bash", true, "root");
  c.tracker.end("root", "codemode", false);
  assert.deepEqual(c.tracker.activeCalls(), []);
  const batch = c.tracker.flush()!;
  assert.equal(batch.totalCalls, 3);
  assert.equal(batch.failedCalls, 1);
  assert.equal(batch.elapsedMs, 800);
  assert.equal(batch.calls[1].elapsedMs, 200);
  assert.equal(c.tracker.flush(), undefined);
  assert.equal(c.tracker.finish("completed")!.totalCalls, 3);
});

test("parallel batch duration uses the last finishing call, not summed durations", () => {
  const c = clock();
  c.tracker.start("a", "read");
  c.advance(10);
  c.tracker.start("b", "read");
  c.advance(100);
  c.tracker.end("b", "read", false);
  c.advance(200);
  c.tracker.end("a", "read", false);
  c.advance(500); // Boundary/extension overhead is not tool execution.
  const batch = c.tracker.flush()!;
  assert.equal(batch.elapsedMs, 310);
  assert.equal(batch.finishedAt, 1_000_310);
  assert.equal(summarizeNames(batch.calls), "read ×2");
  assert.equal(c.tracker.finish("completed")!.elapsedMs, 810);
});

test("wall clock adjustments do not change elapsed timing", () => {
  const c = clock();
  c.tracker.start("a", "bash");
  c.advance(250);
  c.shiftWall(-60_000);
  assert.equal(c.tracker.activeCalls()[0].elapsedMs, 250);
  c.tracker.end("a", "bash", false);
  assert.equal(c.tracker.flush()!.elapsedMs, 250);
});

test("interrupted calls are recorded and state resets between runs", () => {
  const c = clock();
  c.tracker.start("a", "bash");
  c.advance(3000);
  assert.equal(c.tracker.flush()!.interruptedCalls, 1);
  const run = c.tracker.finish("aborted")!;
  assert.equal(run.outcome, "aborted");
  assert.equal(run.interruptedCalls, 1);
  assert.deepEqual(c.tracker.activeCalls(), []);
  assert.equal(c.tracker.finish("completed"), undefined);
  c.tracker.beginRun();
  assert.equal(c.tracker.finish("completed")!.totalCalls, 0);
});

test("unknown starts do not invent per-call durations; duplicate events are ignored", () => {
  const c = clock();
  c.tracker.end("a", "read", false);
  c.tracker.end("a", "read", true);
  const batch = c.tracker.flush()!;
  assert.equal(batch.totalCalls, 1);
  assert.equal(batch.failedCalls, 0);
  assert.equal(batch.calls[0].elapsedMs, undefined);
});

test("orphaned and deeply nested calls stay visible", () => {
  const c = clock();
  c.tracker.start("orphan", "read", "missing");
  c.tracker.start("child", "bash", "orphan");
  assert.deepEqual(c.tracker.activeCalls().map(x => [x.name, x.depth]), [["read", 0], ["bash", 1]]);
  c.tracker.reset();
  assert.equal(c.tracker.live(), undefined);
  assert.equal(c.tracker.flush(), undefined);
});
