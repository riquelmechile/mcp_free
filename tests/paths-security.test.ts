import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('physical allowed roots reject symlink escapes, Git metadata writes, and credential-like paths', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-paths-'));
  const physicalRoot = path.join(base, 'physical-root');
  const configuredRoot = path.join(base, 'configured-root');
  const outside = path.join(base, 'outside');
  await fs.mkdir(physicalRoot);
  await fs.mkdir(outside);
  await fs.symlink(physicalRoot, configuredRoot, 'dir');
  await fs.writeFile(path.join(physicalRoot, 'regular.txt'), 'ok\n');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret\n');
  await fs.symlink(outside, path.join(physicalRoot, 'escape'), 'dir');
  await fs.mkdir(path.join(physicalRoot, '.ssh'));
  await fs.writeFile(path.join(physicalRoot, '.ssh', 'id_test'), 'secret\n');
  await fs.mkdir(path.join(physicalRoot, '.git'));
  await fs.writeFile(path.join(physicalRoot, '.git', 'config'), '[remote "origin"]\nurl = token@example.invalid\n');

  process.env.MCP_MODE = 'workspace';
  process.env.MCP_ALLOWED_ROOTS = configuredRoot;
  process.env.MCP_STATE_DIR = path.join(base, 'state');
  process.env.MCP_ALLOW_SECRETS = '0';

  try {
    const paths = await import(`../src/core/paths.js?paths=${Date.now()}`);
    assert.equal(
      await paths.resolveAllowedPath(path.join(configuredRoot, 'regular.txt'), { mustExist: true }),
      path.join(configuredRoot, 'regular.txt')
    );
    assert.equal(
      await paths.resolveAllowedPath(path.join(configuredRoot, 'new', 'file.txt'), { write: true }),
      path.join(configuredRoot, 'new', 'file.txt')
    );
    await assert.rejects(
      paths.resolveAllowedPath(path.join(configuredRoot, 'escape', 'secret.txt'), { mustExist: true }),
      /Symbolic-link|outside MCP_ALLOWED_ROOTS|resolves outside/
    );
    await assert.rejects(
      paths.resolveAllowedPath(path.join(configuredRoot, '.ssh', 'id_test'), { mustExist: true }),
      /Sensitive credential path/
    );
    await assert.rejects(
      paths.resolveAllowedPath(path.join(configuredRoot, '.git', 'config'), { mustExist: true }),
      /Sensitive credential path/
    );
    await assert.rejects(
      paths.resolveAllowedPath(path.join(configuredRoot, '.git', 'hooks', 'post-checkout'), { write: true }),
      /may not modify \.git metadata/
    );
    await assert.rejects(
      paths.resolveAllowedPath(path.join(outside, 'secret.txt'), { mustExist: true }),
      /outside MCP_ALLOWED_ROOTS/
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
