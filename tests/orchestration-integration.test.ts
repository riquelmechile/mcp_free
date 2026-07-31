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

async function waitForTerminal(
  coordinator: typeof import('../src/core/lane-coordinator.js'),
  id: string
): Promise<import('../src/core/lane-coordinator.js').LaneCoordinatorState> {
  let revision = 0;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await coordinator.waitForCoordinatorChange(id, revision, 1_000);
    revision = state.revision;
    if (!state.lanes.some(lane => lane.status === 'queued' || lane.status === 'running')) return state;
  }
  throw new Error('lane did not terminate');
}

test('persistent coordinator completes patch, leased verification, and finalization', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-orchestration-'));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-orchestration-state-'));
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

    const development = await import(`../src/core/development.js?integration=${Date.now()}`);
    const coordinator = await import(`../src/core/lane-coordinator.js?integration=${Date.now()}`);
    const fingerprints = await import(`../src/core/worktree-fingerprint.js?integration=${Date.now()}`);
    const leases = await import(`../src/core/worktree-lease.js?integration=${Date.now()}`);

    let state = await development.createOrchestration({
      cwd: root,
      objective: 'Update the tracked test file through the persistent coordinator',
      laneCount: 1,
      useSdd: false
    });
    await coordinator.enqueueParallelInspection(state.id, [{
      laneId: 'lane-1',
      commands: [['git', 'status', '--short'], ['git', 'grep', 'baseline', '--', 'tracked.txt']]
    }], 30_000);
    const terminal = await waitForTerminal(coordinator, state.id);
    assert.equal(terminal.lanes[0]?.status, 'completed');
    assert.match(terminal.lanes[0]?.terminalReceiptId ?? '', /^rcpt_/);

    state = await coordinator.materializeLaneInspection(state.id, 'lane-1');
    assert.equal(state.lanes[0]?.inspection?.results.length, 2);
    assert.match(state.lanes[0]?.inspectionSha256 ?? '', /^[a-f0-9]{64}$/);
    state = await development.recordLaneReport(state.id, {
      laneId: 'lane-1',
      summary: 'The bounded change affects tracked.txt only.',
      findings: ['tracked.txt contains the baseline value'],
      recommendations: ['replace the single line and verify the diff'],
      evidence: ['git grep baseline -- tracked.txt']
    });

    const patch = [
      'diff --git a/tracked.txt b/tracked.txt',
      '--- a/tracked.txt',
      '+++ b/tracked.txt',
      '@@ -1 +1 @@',
      '-baseline',
      '+updated',
      ''
    ].join('\n');
    const applied = await development.applyOrchestrationPatch(state.id, patch, false);
    assert.equal(applied.state.status, 'applied');
    assert.equal(await fs.readFile(path.join(root, 'tracked.txt'), 'utf8'), 'updated\n');
    await assert.rejects(leases.assertPathNotLeased(path.join(root, 'tracked.txt')), /protected by active/);

    state = await development.verifyOrchestration(state.id, [], 30_000);
    assert.equal(state.status, 'verified');
    assert.equal(state.verification?.success, true);
    assert.equal(state.verification?.worktreeStable, true);
    const fingerprint = await fingerprints.readVerifiedWorktreeFingerprint(state.id);
    assert.match(fingerprint.fingerprint, /^[a-f0-9]{64}$/);
    await fingerprints.assertVerifiedWorktreeUnchanged(state);

    state = await development.finalizeOrchestration(state.id);
    assert.equal(state.status, 'completed');
    await leases.assertPathNotLeased(path.join(root, 'tracked.txt'));

    await fs.writeFile(path.join(root, 'tracked.txt'), 'changed after verification\n');
    await assert.rejects(fingerprints.assertVerifiedWorktreeUnchanged(state), /changed after verification/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

