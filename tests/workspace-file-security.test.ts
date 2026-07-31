import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('descriptor-anchored workspace primitives reject aliases and replace files atomically', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-workspace-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-workspace-outside-'));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-workspace-state-'));
  process.env.MCP_MODE = 'workspace';
  process.env.MCP_ALLOWED_ROOTS = root;
  process.env.MCP_STATE_DIR = stateDir;
  const previousUmask = process.umask(0o077);

  try {
    const victim = path.join(outside, 'victim.txt');
    await fs.writeFile(victim, 'outside-original\n');
    await fs.symlink(outside, path.join(root, 'escape'));
    const workspace = await import(`../src/tools/workspace.js?file-security=${Date.now()}`);

    await assert.rejects(
      workspace.writeFileNoFollow(path.join(root, 'escape', 'victim.txt'), 'forged\n', true),
      /outside MCP_ALLOWED_ROOTS|Symbolic-link|validated path/i
    );
    assert.equal(await fs.readFile(victim, 'utf8'), 'outside-original\n');

    await assert.rejects(
      workspace.patchFileNoFollow(path.join(root, 'escape', 'victim.txt'), 'outside', 'forged'),
      /outside MCP_ALLOWED_ROOTS|Symbolic-link|validated path/i
    );
    assert.equal(await fs.readFile(victim, 'utf8'), 'outside-original\n');

    const hardlink = path.join(root, 'hardlink.txt');
    await fs.link(victim, hardlink);
    await assert.rejects(
      workspace.writeFileNoFollow(hardlink, 'forged\n', true),
      /multiple hard links/i
    );
    assert.equal(await fs.readFile(victim, 'utf8'), 'outside-original\n');

    const atomic = path.join(root, 'atomic.txt');
    await fs.writeFile(atomic, 'before\n', { mode: 0o644 });
    await fs.chmod(atomic, 0o644);
    const beforeWrite = await fs.stat(atomic);
    await workspace.writeFileNoFollow(atomic, 'after-write\n', true);
    const afterWrite = await fs.stat(atomic);
    assert.notEqual(afterWrite.ino, beforeWrite.ino);
    assert.equal(afterWrite.mode & 0o777, 0o644);
    assert.equal(await fs.readFile(atomic, 'utf8'), 'after-write\n');

    const beforePatch = await fs.stat(atomic);
    await workspace.patchFileNoFollow(atomic, 'after-write', 'after-patch');
    const afterPatch = await fs.stat(atomic);
    assert.notEqual(afterPatch.ino, beforePatch.ino);
    assert.equal(afterPatch.mode & 0o777, 0o644);
    assert.equal(await fs.readFile(atomic, 'utf8'), 'after-patch\n');

    const source = path.join(root, 'source.txt');
    await fs.writeFile(source, 'source\n');
    await assert.rejects(
      workspace.renameAnchored(source, path.join(root, 'escape', 'moved.txt')),
      /outside MCP_ALLOWED_ROOTS|Symbolic-link/i
    );
    assert.equal(await fs.readFile(source, 'utf8'), 'source\n');
    await assert.rejects(fs.access(path.join(outside, 'moved.txt')));
  } finally {
    process.umask(previousUmask);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
