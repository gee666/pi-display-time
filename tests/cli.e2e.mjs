import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

function assertPrivate(requests) {
  for (const request of requests) {
    assert.doesNotMatch(JSON.stringify(request.data), /DISPLAY_ONLY_SENTINEL_7c31|harmless compaction padding|"customType":"display-time"|"kind":"(?:tools|run)"/);
  }
}

const timings = entries => entries.filter(e => e.type === 'custom' && e.customType === 'display-time' && e.data.version === 2);
const jsonl = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('privacy observer detects a leaked display-only sentinel (negative control)', () => {
  assert.throws(() => assertPrivate([{ data: { input: 'DISPLAY_ONLY_SENTINEL_7c31' } }]));
});

test('global Pi preserves nested history, privacy, continuation, off-mode and restart', { timeout: 240_000 }, async () => {
  const model = process.env.EVERGREEN_E2E_MODEL;
  assert.ok(model, 'EVERGREEN_E2E_MODEL must select the live test model');
  await mkdir('tmp', { recursive: true });
  const dir = await mkdtemp(resolve('tmp/e2e-'));
  const logPath = resolve(dir, 'observer.jsonl');
  const run = async (messages, sessionFile) => {
    const child = spawn(process.env.EVERGREEN_PI_BIN || 'pi', [
      '--mode', 'json', '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files',
      '--extension', resolve('extensions/display-time.ts'), '--extension', resolve('tests/fixtures/observe.ts'),
      '--session-dir', dir, ...(sessionFile ? ['--session', sessionFile] : []),
      '--tools', 'timing_probe,read', '--model', model,
      '--system-prompt', 'Follow instructions exactly. Be brief. Do not call tools unless explicitly asked.',
      ...messages,
    ], { env: { ...process.env, DISPLAY_TIME_E2E_LOG: logPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 90_000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.equal(code, 0, stderr);
      assert.doesNotMatch(stderr, /Extension error|Failed to load extension/i);
      const events = jsonl(stdout);
      assert.ok(events.some(e => e.type === 'agent_settled'), 'a real model run must settle');
      assert.deepEqual(events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant' && ['error', 'aborted', 'length'].includes(e.message.stopReason)), []);
      return events;
    } finally { clearTimeout(watchdog); }
  };
  try {
    await run([
      '/probe-poison',
      'Call timing_probe exactly once with {}. Then reply OK without further tool calls.',
      '/display-time off',
      'Reply OK without tools.',
    ]);
    const files = (await readdir(dir)).filter(name => name.endsWith('.jsonl') && name !== 'observer.jsonl');
    assert.equal(files.length, 1);
    const sessionFile = resolve(dir, files[0]);
    const first = jsonl(await readFile(sessionFile, 'utf8'));
    const batches = timings(first).filter(e => e.data.kind === 'tools');
    const runs = timings(first).filter(e => e.data.kind === 'run');
    assert.equal(batches.length, 1, 'nested calls become one compact batch');
    assert.equal(runs.length, 2, 'continuation does not split a run; off still records the next run');
    const batch = batches[0].data;
    assert.equal(batch.totalCalls, 3);
    assert.equal(batch.failedCalls, 1);
    assert.equal(batch.interruptedCalls, 0);
    const root = batch.calls.find(c => c.name === 'timing_probe');
    assert.ok(root);
    assert.equal(batch.calls.filter(c => c.parentId === root.id).length, 2);
    for (const call of batch.calls) {
      assert.ok(Number.isFinite(call.elapsedMs) && call.elapsedMs >= 0);
      assert.ok(call.finishedAt >= call.startedAt);
    }
    assert.equal(runs[0].data.totalCalls, 3);
    assert.equal(runs[0].data.failedCalls, 1);
    assert.equal(runs[0].data.outcome, 'completed');
    assert.ok(runs[0].data.elapsedMs >= batch.elapsedMs);
    assert.equal(runs[1].data.totalCalls, 0);
    const resultIndex = first.findIndex(e => e.message?.role === 'toolResult' && e.message.toolCallId === root.id);
    assert.ok(resultIndex >= 0 && resultIndex < first.indexOf(batches[0]), 'history follows its persisted owning tool result');
    assert.equal(batches[0].parentId, first[first.indexOf(batches[0]) - 1].id);
    assert.ok(first.indexOf(batches[0]) < first.indexOf(runs[0]));
    await run(['/probe-prepare-compaction', '/probe-compact', 'Reply OK without tools.'], sessionFile);
    const resumed = jsonl(await readFile(sessionFile, 'utf8'));
    assert.deepEqual(timings(resumed).slice(0, 3), timings(first), 'restart preserves exact stored timing data');
    assert.ok(resumed.some(e => e.type === 'compaction'));
    assert.equal(timings(resumed).at(-1).data.totalCalls, 0, 'restart does not resurrect live calls');
    assert.equal(timings(resumed).at(-1).data.outcome, 'completed');
    const observed = jsonl(await readFile(logPath, 'utf8'));
    const requests = observed.filter(e => e.type === 'request');
    assert.ok(requests.length >= 5);
    // Some transports (including Codex WebSocket) do not emit HTTP response hooks.
    assert.deepEqual(observed.filter(e => e.type === 'response' && e.data.status >= 400), []);
    assert.ok(requests.some(e => JSON.stringify(e.data).includes('PROBE_TOOL_RESULT_SENTINEL')));
    assert.ok(observed.filter(e => e.type === 'agent_end').length > observed.filter(e => e.type === 'settled').length, 'fixture exercised continuation');
    assert.ok(requests.some(e => JSON.stringify(e.data).includes('PROBE_COMPACTION_SENTINEL')));
    assertPrivate(requests);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
