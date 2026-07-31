import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('worktree leases block unrelated writes and are owner-scoped', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-lease-'));
  const root = path.join(base, 'repo');
  const stateDir = path.join(base, 'state');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'baseline\n');
  process.env.MCP_STATE_DIR = stateDir;
  process.env.MCP_MODE = 'workspace';
  process.env.MCP_ALLOWED_ROOTS = root;

  try {
    const leases = await import(`../src/core/worktree-lease.js?lease=${Date.now()}`);
    const first = await leases.acquireWorktreeLease(root, 'orch_aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(first.acquired, true);
    const repeated = await leases.acquireWorktreeLease(root, 'orch_aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(repeated.acquired, false);
    await assert.rejects(
      leases.acquireWorktreeLease(root, 'orch_bbbbbbbbbbbbbbbbbbbbbbbb'),
      /leased by orch_aaaaaaaa/
    );
    await assert.rejects(leases.assertPathNotLeased(path.join(root, 'tracked.txt')), /protected by active/);
    const rootAlias = `${root}-alias`;
    await fs.symlink(root, rootAlias);
    await assert.rejects(leases.assertPathNotLeased(path.join(rootAlias, 'tracked.txt')), /protected by active/);
    await fs.rm(rootAlias, { force: true });
    await leases.releaseWorktreeLease(root, 'orch_aaaaaaaaaaaaaaaaaaaaaaaa');
    await assert.doesNotReject(leases.assertPathNotLeased(path.join(root, 'tracked.txt')));
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
