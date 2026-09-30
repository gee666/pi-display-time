import { stripVTControlCharacters } from "node:util";

export function cleanText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
}

export interface CallTiming {
  id: string;
  name: string;
  parentId?: string;
  startedAt?: number;
  finishedAt?: number;
  elapsedMs?: number;
  status: "running" | "completed" | "error" | "interrupted";
}

export interface TimingEntry {
  version: 2;
  kind: "tools" | "run";
  startedAt: number;
  finishedAt: number;
  elapsedMs: number;
  calls: CallTiming[];
  totalCalls: number;
  failedCalls: number;
  interruptedCalls: number;
  outcome?: "completed" | "aborted" | "error";
}

export function formatDuration(ms: number): string {
  ms = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (ms < 1000) return `${Math.floor(ms)} ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 7) return `${Math.floor(days / 7)}w ${days % 7}d ${hours % 24}h`;
  if (days) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m ${seconds % 60}s`;
}

export function summarizeNames(calls: CallTiming[], limit = 3): string {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const name = cleanText(call.name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name);
  return names.slice(0, limit).join(", ") + (names.length > limit ? `, +${names.length - limit} types` : "");
}

// Wall-clock timestamps are for display. Monotonic time measures durations even
// when the system clock changes. This class has no Pi or terminal dependencies.
export class TimingTracker {
  private calls = new Map<string, CallTiming & { tick?: number }>();
  private batchStart?: { wall: number; tick: number };
  private runStart?: { wall: number; tick: number };
  private totals = { totalCalls: 0, failedCalls: 0, interruptedCalls: 0 };

  private wall: () => number;
  private tick: () => number;

  constructor(wall = Date.now, tick = () => performance.now()) {
    this.wall = wall;
    this.tick = tick;
  }

  beginRun() {
    this.runStart ??= { wall: this.wall(), tick: this.tick() };
  }

  start(id: string, name: string, parentId?: string) {
    if (this.calls.has(id)) return;
    this.beginRun();
    const wall = this.wall();
    const tick = this.tick();
    this.batchStart ??= { wall, tick };
    this.calls.set(id, { id, name: cleanText(name), parentId, startedAt: wall, tick, status: "running" });
  }

  end(id: string, name: string, isError: boolean, parentId?: string) {
    const call = this.calls.get(id);
    if (call && call.status !== "running") return;
    this.beginRun();
    const wall = this.wall();
    const tick = this.tick();
    this.batchStart ??= { wall, tick };
    this.calls.set(id, {
      ...call, id, name: cleanText(name), parentId: parentId ?? call?.parentId,
      finishedAt: wall, elapsedMs: call?.tick === undefined ? undefined : Math.max(0, tick - call.tick),
      status: isError ? "error" : "completed",
    });
  }

  flush(): TimingEntry | undefined {
    if (!this.batchStart) return;
    const now = this.wall();
    const tick = this.tick();
    const calls = [...this.calls.values()].map(({ tick: start, ...call }): CallTiming =>
      call.status === "running" ? {
        ...call, status: "interrupted", finishedAt: now,
        elapsedMs: start === undefined ? undefined : Math.max(0, tick - start),
      } : call);
    const counts = {
      totalCalls: calls.length,
      failedCalls: calls.filter(call => call.status === "error").length,
      interruptedCalls: calls.filter(call => call.status === "interrupted").length,
    };
    for (const key of Object.keys(counts) as (keyof typeof counts)[]) this.totals[key] += counts[key];
    // Batch elapsed excludes model/extension work after the last tool finished.
    const elapsedMs = Math.max(0, ...[...this.calls.values()].map(call =>
      call.status === "running" ? tick - this.batchStart!.tick :
        call.tick === undefined ? 0 : call.tick - this.batchStart!.tick + (call.elapsedMs ?? 0)));
    const result: TimingEntry = {
      version: 2, kind: "tools", startedAt: this.batchStart.wall,
      finishedAt: calls[calls.length - 1]?.finishedAt ?? now,
      elapsedMs, calls, ...counts,
    };
    // Finish order can differ from start order for concurrent tools.
    result.finishedAt = Math.max(...calls.map(call => call.finishedAt ?? now));
    this.calls.clear();
    this.batchStart = undefined;
    return result;
  }

  finish(outcome: TimingEntry["outcome"]): TimingEntry | undefined {
    if (!this.runStart) return;
    const result: TimingEntry = {
      version: 2, kind: "run", startedAt: this.runStart.wall, finishedAt: this.wall(),
      elapsedMs: Math.max(0, this.tick() - this.runStart.tick), calls: [], ...this.totals, outcome,
    };
    this.reset();
    return result;
  }

  activeCalls(): (CallTiming & { depth: number })[] {
    const now = this.tick();
    const rows: (CallTiming & { depth: number })[] = [];
    const visit = (parentId: string | undefined, depth: number, visited: Set<string>) => {
      for (const call of this.calls.values()) {
        if (call.parentId !== parentId || visited.has(call.id)) continue;
        visited.add(call.id);
        if (call.status === "running") {
          const { tick, ...data } = call;
          rows.push({ ...data, depth, elapsedMs: tick === undefined ? undefined : Math.max(0, now - tick) });
        }
        visit(call.id, Math.min(depth + 1, 4), visited);
      }
    };
    const visited = new Set<string>();
    visit(undefined, 0, visited);
    // A parent may belong to a tool path this extension did not observe.
    for (const call of this.calls.values()) {
      if (!visited.has(call.id)) visit(call.parentId, 0, visited);
    }
    return rows;
  }

  live(): string | undefined {
    if (!this.runStart) return;
    const active = [...this.calls.values()].filter(call => call.status === "running");
    const roots = active.filter(call => !call.parentId);
    const label = roots.length ? summarizeNames(roots, 2) : active.length ? `${active.length} tools` : "working";
    return `${formatDuration(this.tick() - this.runStart.tick)} · ${label}`;
  }

  reset() {
    this.calls.clear();
    this.batchStart = this.runStart = undefined;
    this.totals = { totalCalls: 0, failedCalls: 0, interruptedCalls: 0 };
  }
}
