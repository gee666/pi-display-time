import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

function assertPrivate(requests) {
  for (const request of requests) {
    const text = JSON.stringify(request.data);
    assert.doesNotMatch(text, /DISPLAY_ONLY_SENTINEL_7c31|harmless compaction padding|"customType":"display-time"|"kind":"(?:tools|run)"/);
  }
}

test('privacy observer detects a leaked display-only sentinel (negative control)', () => {
  assert.throws(() => assertPrivate([{ data: { input: 'DISPLAY_ONLY_SENTINEL_7c31' } }]));
});

test('global CLI preserves nested timings, boundary order, privacy, continuations and session replacement', { timeout: 240_000 }, async () => {
  const bin = process.env.PI_EVERGREEN_PI_BIN;
  assert.ok(bin, 'PI_EVERGREEN_PI_BIN must name the installed global Pi CLI; e2e never skips');
  await mkdir('tmp', { recursive: true });
  const dir = await mkdtemp(resolve('tmp/e2e-'));
  const logPath = resolve(dir, 'observer.jsonl');
  const child = spawn(bin, [
    '--mode', 'rpc', '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files',
    '--extension', resolve('extensions/display-time.ts'), '--extension', resolve('tests/fixtures/observe.ts'),
    '--session-dir', dir, '--tools', 'timing_probe,read',
    '--provider', process.env.PI_EVERGREEN_E2E_PROVIDER || 'openai',
    '--model', process.env.PI_EVERGREEN_E2E_MODEL || 'gpt-6-luna',
    '--thinking', process.env.PI_EVERGREEN_E2E_REASONING || 'medium',
    '--system-prompt', 'Follow instructions exactly. Be brief. Do not call tools unless explicitly asked.',
  ], { cwd: process.cwd(), env: { ...process.env, DISPLAY_TIME_E2E_LOG: logPath }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', nextId = 0;
  const records = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (line.trim()) records.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const wait = async predicate => {
    const deadline = Date.now() + 90_000;
    while (!predicate()) {
      assert.equal(child.exitCode, null, `Pi exited early: ${stderr}`);
      assert.ok(Date.now() < deadline, `Timed out waiting for Pi: ${stderr}`);
      await new Promise(r => setTimeout(r, 20));
    }
  };
  const command = async (type, fields = {}) => {
    const id = String(++nextId);
    child.stdin.write(JSON.stringify({ type, id, ...fields }) + '\n');
    await wait(() => records.some(r => r.type === 'response' && r.id === id));
    const response = records.find(r => r.type === 'response' && r.id === id);
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  };
  const prompt = async message => {
    const start = records.length;
    await command('prompt', { message });
    await wait(() => records.slice(start).some(r => r.type === 'agent_settled'));
    const errors = records.slice(start).filter(r => r.type === 'message_end' && r.message?.role === 'assistant' && ['error', 'aborted'].includes(r.message.stopReason));
    assert.deepEqual(errors, [], 'Model requests must actually succeed');
  };
  const timings = entries => entries.filter(e => e.type === 'custom' && e.customType === 'display-time' && e.data.version === 2);
  try {
    await command('set_auto_retry', { enabled: false });
    await command('prompt', { message: '/probe-poison' });
    await prompt('Call timing_probe exactly once with {}. Then reply OK without further tool calls.');
    const first = (await command('get_entries')).entries;
    const batches = timings(first).filter(e => e.data.kind === 'tools');
    const runs = timings(first).filter(e => e.data.kind === 'run');
    assert.equal(batches.length, 1);
    assert.equal(runs.length, 1, 'continuation must not split one run into multiple summaries');
    const batch = batches[0].data;
    assert.equal(batch.totalCalls, 3);
    assert.equal(batch.failedCalls, 1);
    assert.equal(batch.interruptedCalls, 0);
    const root = batch.calls.find(c => c.name === 'timing_probe');
    assert.ok(root);
    assert.equal(batch.calls.filter(c => c.parentId === root.id).length, 2);
    for (const call of batch.calls) {
      assert.ok(call.elapsedMs >= 0 && Number.isFinite(call.elapsedMs));
      assert.ok(call.finishedAt >= call.startedAt);
    }
    assert.equal(runs[0].data.totalCalls, 3);
    assert.equal(runs[0].data.failedCalls, 1);
    assert.equal(runs[0].data.outcome, 'completed');
    assert.ok(runs[0].data.elapsedMs >= batch.elapsedMs);
    const resultIndex = first.findIndex(e => e.message?.role === 'toolResult' && e.message.toolCallId === root.id);
    assert.ok(resultIndex >= 0 && resultIndex < first.indexOf(batches[0]), 'history follows its persisted owning tool result');
    assert.ok(first.indexOf(batches[0]) < first.indexOf(runs[0]));
    assert.equal(batches[0].parentId, first[first.indexOf(batches[0]) - 1].id);
    await command('prompt', { message: '/display-time off' });
    await prompt('Reply OK without tools.');
    const second = (await command('get_entries')).entries;
    assert.equal(timings(second).filter(e => e.data.kind === 'run').length, 2, 'off still records');
    assert.equal(timings(second).at(-1).data.totalCalls, 0, 'next prompt starts fresh totals');
    const sessionFile = (await command('get_state')).sessionFile;
    const disk = (await readFile(sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(timings(disk), timings(second), 'summaries survive real JSONL serialization');
    await command('new_session');
    assert.equal(timings((await command('get_entries')).entries).length, 0);
    await command('switch_session', { sessionPath: sessionFile });
    assert.equal(timings((await command('get_entries')).entries).length, 3);
    await command('prompt', { message: '/probe-prepare-compaction' });
    await command('compact'); // Supported custom summarizer avoids an extra model call.
    assert.ok((await command('get_entries')).entries.some(e => e.type === 'compaction'));
    await prompt('Reply OK without tools.');
    const resumed = timings((await command('get_entries')).entries);
    assert.equal(resumed.at(-1).data.totalCalls, 0, 'resume does not resurrect live timing');
    const abortStart = records.length;
    const startingPrompt = command('prompt', { message: 'PROBE_ABORT_AT_SETTLEMENT: Reply OK without tools.' });
    await wait(() => records.slice(abortStart).some(r => r.type === 'extension_ui_request' && r.message === 'PROBE_ABORT_READY'));
    await command('abort');
    await startingPrompt;
    await wait(() => records.slice(abortStart).some(r => r.type === 'agent_settled' && r.aborted));
    assert.ok(records.slice(abortStart).some(r => r.type === 'message_end' && r.message?.role === 'assistant' && r.message.stopReason === 'stop'), 'abort after the final assistant has a stale completed outcome');
    const aborted = timings((await command('get_entries')).entries).at(-1);
    assert.equal(aborted.data.outcome, 'aborted', 'settlement flag covers aborts after the final assistant boundary');
    const observed = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
    const requests = observed.filter(e => e.type === 'request');
    assert.ok(requests.length >= 5, 'observe tool follow-up, continuation, second prompt, resumed prompt');
    assert.ok(observed.filter(e => e.type === 'response' && e.data.status >= 200 && e.data.status < 300).length >= requests.length);
    assert.ok(requests.some(e => JSON.stringify(e.data).includes('PROBE_TOOL_RESULT_SENTINEL')), 'observer sees actual tool results in serialized provider requests');
    assert.ok(observed.filter(e => e.type === 'agent_end').length > observed.filter(e => e.type === 'settled').length, 'fixture really exercised continuation');
    assert.ok(requests.some(e => JSON.stringify(e.data).includes('PROBE_COMPACTION_SENTINEL')), 'observe a real post-compaction request');
    assertPrivate(requests);
    assert.doesNotMatch(stderr, /Extension error|Failed to load extension/i);
  } finally {
    child.stdin.end();
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000);
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    clearTimeout(watchdog);
    await rm(dir, { recursive: true, force: true });
  }
});
