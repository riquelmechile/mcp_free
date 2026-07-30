import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { computeWorktreeFingerprint } from '../src/core/worktree-fingerprint.js';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', args, { cwd });
}

test('worktree fingerprint changes for unstaged, untracked, and index-only bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-fingerprint-'));
  try {
    await git(root, 'init', '-q');
    await git(root, 'config', 'user.email', 'test@example.com');
    await git(root, 'config', 'user.name', 'MCP Test');
    await fs.writeFile(path.join(root, 'tracked.txt'), 'baseline\n');
    await git(root, 'add', 'tracked.txt');
    await git(root, 'commit', '-qm', 'baseline');

    const clean = await computeWorktreeFingerprint(root);

    await fs.writeFile(path.join(root, 'tracked.txt'), 'unstaged\n');
    const unstaged = await computeWorktreeFingerprint(root);
    assert.notEqual(unstaged, clean);

    await fs.writeFile(path.join(root, 'tracked.txt'), 'baseline\n');
    await fs.writeFile(path.join(root, 'untracked.txt'), 'new bytes\n');
    const untracked = await computeWorktreeFingerprint(root);
    assert.notEqual(untracked, clean);

    await fs.rm(path.join(root, 'untracked.txt'));
    await fs.writeFile(path.join(root, 'tracked.txt'), 'staged bytes\n');
    await git(root, 'add', 'tracked.txt');
    await fs.writeFile(path.join(root, 'tracked.txt'), 'baseline\n');
    const indexOnly = await computeWorktreeFingerprint(root);
    assert.notEqual(indexOnly, clean);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
