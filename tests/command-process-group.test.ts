import assert from 'node:assert/strict';
import test from 'node:test';
import { runCommand } from '../src/core/command.js';

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
  }
  throw new Error(`Process ${pid} survived process-group termination`);
}

test('command timeout terminates descendant processes, not only the direct child', async () => {
  const result = await runCommand(['/usr/bin/env', 'bash', '-c', 'sleep 30 & echo $!; wait'], {
    timeoutMs: 150,
    maxTimeoutMs: 1_000
  });
  assert.equal(result.timedOut, true);
  const descendantPid = Number.parseInt(result.stdout.trim().split('\n')[0] ?? '', 10);
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  await waitForExit(descendantPid);
});

test('abort signal cancels the complete command process group', async () => {
  const controller = new AbortController();
  const pending = runCommand(['/usr/bin/env', 'bash', '-c', 'sleep 30 & echo $!; wait'], {
    timeoutMs: 10_000,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 150).unref();
  const result = await pending;
  assert.equal(result.cancelled, true);
  const descendantPid = Number.parseInt(result.stdout.trim().split('\n')[0] ?? '', 10);
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  await waitForExit(descendantPid);
});
