import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('no-follow workspace primitives refuse parent symlink escapes before changing outside bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-workspace-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-workspace-outside-'));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-workspace-state-'));
  process.env.MCP_MODE = 'workspace';
  process.env.MCP_ALLOWED_ROOTS = root;
  process.env.MCP_STATE_DIR = stateDir;

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

    const source = path.join(root, 'source.txt');
    await fs.writeFile(source, 'source\n');
    await assert.rejects(
      workspace.renameAnchored(source, path.join(root, 'escape', 'moved.txt')),
      /outside MCP_ALLOWED_ROOTS|Symbolic-link/i
    );
    assert.equal(await fs.readFile(source, 'utf8'), 'source\n');
    await assert.rejects(fs.access(path.join(outside, 'moved.txt')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
