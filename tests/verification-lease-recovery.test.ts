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

test('failed verification releases lease and a later verification reacquires it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-verification-failure-'));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-verification-failure-state-'));
  process.env.MCP_MODE = 'workspace';
  process.env.MCP_ALLOWED_ROOTS = root;
  process.env.MCP_STATE_DIR = stateDir;

  try {
    await git(root, 'init', '-q');
    await git(root, 'config', 'user.email', 'test@example.com');
    await git(root, 'config', 'user.name', 'MCP Test');
    await fs.writeFile(path.join(root, 'tracked.txt'), 'before\n');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'baseline');

    const development = await import(`../src/core/development.js?verify-fail=${Date.now()}`);
    const leases = await import(`../src/core/worktree-lease.js?verify-fail=${Date.now()}`);
    let state = await development.createOrchestration({
      cwd: root,
      objective: 'Prove failed verification releases its worktree lease',
      laneCount: 1,
      useSdd: false
    });
    state.lanes[0]!.inspection = { startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), results: [] };
    state.lanes[0]!.inspectionSha256 = '0'.repeat(64);
    state.lanes[0]!.report = {
      recordedAt: new Date().toISOString(),
      summary: 'Synthetic bounded test evidence.',
      findings: [], recommendations: [], evidence: []
    };
    const statePath = path.join(stateDir, 'orchestrations', state.id, 'state.json');
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

    const patch = [
      'diff --git a/tracked.txt b/tracked.txt',
      '--- a/tracked.txt',
      '+++ b/tracked.txt',
      '@@ -1 +1 @@',
      '-before',
      '+after',
      ''
    ].join('\n');
    await development.applyOrchestrationPatch(state.id, patch, false);
    await assert.rejects(leases.assertPathNotLeased(root), /protected by active/);

    state = await development.verifyOrchestration(state.id, [['npm', 'run', 'missing']], 30_000);
    assert.equal(state.status, 'verification_failed');
    await leases.assertPathNotLeased(root);

    state = await development.verifyOrchestration(state.id, [], 30_000);
    assert.equal(state.status, 'verified');
    await assert.rejects(leases.assertPathNotLeased(root), /protected by active/);
    state = await development.finalizeOrchestration(state.id);
    assert.equal(state.status, 'completed');
    await leases.assertPathNotLeased(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
