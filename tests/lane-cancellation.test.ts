import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', args, { cwd });
}

async function waitForStatus(
  coordinator: typeof import('../src/core/lane-coordinator.js'),
  orchestrationId: string,
  expected: string
): Promise<import('../src/core/lane-coordinator.js').LaneWorkerRecord> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await coordinator.getCoordinatorState(orchestrationId);
    const lane = state.lanes[0];
    if (lane?.status === expected) return lane;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Lane did not reach ${expected}`);
}

test('running lane process groups can be cancelled and explicitly resumed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-cancel-'));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-cancel-state-'));
  process.env.MCP_MODE = 'workspace';
  process.env.MCP_ALLOWED_ROOTS = root;
  process.env.MCP_STATE_DIR = stateDir;

  try {
    await git(root, 'init', '-q');
    await git(root, 'config', 'user.email', 'test@example.com');
    await git(root, 'config', 'user.name', 'MCP Test');
    await fs.writeFile(path.join(root, 'tracked.txt'), 'baseline\n');
    await git(root, 'add', 'tracked.txt');
    await git(root, 'commit', '-qm', 'baseline');
    const fifo = path.join(root, 'slow.pipe');
    await exec('mkfifo', [fifo]);

    const development = await import(`../src/core/development.js?cancel=${Date.now()}`);
    const coordinator = await import(`../src/core/lane-coordinator.js?cancel=${Date.now()}`);
    const orchestration = await development.createOrchestration({
      cwd: root,
      objective: 'Exercise cancellation and explicit lane recovery',
      laneCount: 1,
      useSdd: false
    });

    await coordinator.enqueueParallelInspection(orchestration.id, [{ laneId: 'lane-1', commands: [['cat', 'slow.pipe']] }], 30_000);
    await waitForStatus(coordinator, orchestration.id, 'running');
    await coordinator.cancelLaneWorkers(orchestration.id, ['lane-1']);
    const cancelled = await waitForStatus(coordinator, orchestration.id, 'cancelled');
    assert.equal(cancelled.attempt, 1);
    assert.match(cancelled.evidenceSha256 ?? '', /^[a-f0-9]{64}$/);
    assert.match(cancelled.terminalReceiptId ?? '', /^rcpt_[a-f0-9]{24}$/);

    await coordinator.resumeLaneWorkers(orchestration.id, ['lane-1']);
    const writer = exec('/usr/bin/env', ['bash', '-c', 'sleep 0.1; printf done > slow.pipe'], { cwd: root });
    const completed = await waitForStatus(coordinator, orchestration.id, 'completed');
    await writer;
    assert.equal(completed.attempt, 2);
    assert.equal(completed.results[0]?.stdout, 'done');
    assert.match(completed.evidenceSha256 ?? '', /^[a-f0-9]{64}$/);
    assert.notEqual(completed.terminalReceiptId, cancelled.terminalReceiptId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
