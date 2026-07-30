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

test('runs one ChatGPT-native lane through patch, verification, and byte-bound finalization', async () => {
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

    const development = await import(`../src/core/development.js?orchestration=${Date.now()}`);
    const fingerprints = await import(`../src/core/worktree-fingerprint.js?orchestration=${Date.now()}`);

    let state = await development.createOrchestration({ cwd: root, objective: 'Update the tracked test file safely', laneCount: 1, useSdd: false });
    state = await development.runParallelInspection(state.id, [{
      laneId: 'lane-1',
      commands: [['git', 'status', '--short'], ['git', 'grep', 'baseline', '--', 'tracked.txt']]
    }], 30_000);
    assert.equal(state.lanes[0]?.inspection?.results.length, 2);

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

    state = await development.verifyOrchestration(state.id, [], 30_000);
    assert.equal(state.status, 'verified');
    assert.equal(state.verification?.success, true);

    const fingerprint = await fingerprints.recordVerifiedWorktree(state);
    assert.match(fingerprint.fingerprint, /^[a-f0-9]{64}$/);
    await fingerprints.assertVerifiedWorktreeUnchanged(state);

    state = await development.finalizeOrchestration(state.id);
    assert.equal(state.status, 'completed');

    await fs.writeFile(path.join(root, 'tracked.txt'), 'changed after verification\n');
    await assert.rejects(fingerprints.assertVerifiedWorktreeUnchanged(state), /changed after verification/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
