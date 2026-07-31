import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCommand } from '../src/core/command.js';
import { buildSandboxArgv } from '../src/core/verification-sandbox.js';

test('sandbox command clears environment, removes network, and exposes only the worktree writable', () => {
  const argv = buildSandboxArgv('/usr/bin/bwrap', '/home/user/code/project', ['/usr/bin/npm', 'test'], {
    writable: true,
    network: false
  });
  assert.equal(argv.includes('--clearenv'), true);
  assert.equal(argv.includes('--unshare-user'), true);
  assert.equal(argv.includes('--unshare-pid'), true);
  assert.equal(argv.includes('--share-net'), false);
  assert.deepEqual(argv.slice(argv.indexOf('--bind'), argv.indexOf('--bind') + 3), ['--bind', '/home/user/code/project', '/workspace']);
  assert.equal(argv.includes('/home/user/.local/state/mcp-free'), false);
  assert.equal(argv.includes('MCP_AUTH_TOKEN'), false);
});

test('inspection sandbox mounts the project read-only', () => {
  const argv = buildSandboxArgv('/usr/bin/bwrap', '/tmp/project', ['/usr/bin/git', 'status'], {
    writable: false,
    network: false
  });
  const index = argv.indexOf('--ro-bind', argv.indexOf('--tmpfs'));
  assert.deepEqual(argv.slice(index, index + 3), ['--ro-bind', '/tmp/project', '/workspace']);
});

test('runCommand can use a clean environment without inheriting MCP secrets', async () => {
  process.env.MCP_AUTH_TOKEN = 'must-not-leak';
  const result = await runCommand(['/usr/bin/env'], {
    inheritEnv: false,
    env: { SAFE_ONLY: '1' },
    timeoutMs: 5_000
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^SAFE_ONLY=1\n?$/);
  assert.doesNotMatch(result.stdout, /MCP_AUTH_TOKEN/);
});

test('bubblewrap smoke test isolates an actual temporary worktree when available', async t => {
  if (process.env.CI === 'true' && process.env.MCP_SANDBOX_CI_BYPASS === '1') {
    t.skip('GitHub hosted runners block the user namespaces Bubblewrap requires; production argv is verified separately');
    return;
  }
  try {
    await fs.access('/usr/bin/bwrap');
  } catch {
    t.skip('bubblewrap is not installed in this test environment');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-bwrap-'));
  try {
    await fs.writeFile(path.join(root, 'visible.txt'), 'inside\n');
    const argv = buildSandboxArgv('/usr/bin/bwrap', root, ['/usr/bin/cat', 'visible.txt'], {
      writable: false,
      network: false
    });
    const result = await runCommand(argv, { inheritEnv: false, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 10_000 });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, 'inside\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
