import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCommand } from '../src/core/command.js';
import { buildSandboxArgv, hardenInspectionCommand } from '../src/core/verification-sandbox.js';

test('sandbox command clears environment, removes network, masks Git config, and exposes only the worktree writable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-sandbox-argv-'));
  try {
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, '.git', 'config'), '[core]\nrepositoryformatversion = 0\n');
    const argv = buildSandboxArgv('/usr/bin/bwrap', root, ['/usr/bin/npm', 'test'], {
      writable: true,
      network: false
    });
    assert.equal(argv.includes('--clearenv'), true);
    assert.equal(argv.includes('--unshare-user'), true);
    assert.equal(argv.includes('--unshare-pid'), true);
    assert.equal(argv.includes('--unshare-net'), true);
    assert.equal(argv.includes('--share-net'), false);
    assert.deepEqual(argv.slice(argv.indexOf('--bind'), argv.indexOf('--bind') + 3), ['--bind', root, '/workspace']);

    const gitBind = argv.findIndex((value, index) => value === '--ro-bind' && argv[index + 1] === path.join(root, '.git'));
    assert.notEqual(gitBind, -1);
    assert.deepEqual(argv.slice(gitBind, gitBind + 3), ['--ro-bind', path.join(root, '.git'), '/workspace/.git']);

    const configMask = argv.findIndex((value, index) => value === '--ro-bind' && argv[index + 1] === '/dev/null' && argv[index + 2] === '/workspace/.git/config');
    assert.notEqual(configMask, -1);
    assert.equal(argv.includes(path.join(os.homedir(), '.local', 'state', 'mcp-free')), false);
    assert.equal(argv.includes('MCP_AUTH_TOKEN'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('inspection sandbox mounts the project read-only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-sandbox-readonly-'));
  try {
    await fs.mkdir(path.join(root, '.git'));
    const argv = buildSandboxArgv('/usr/bin/bwrap', root, ['/usr/bin/git', 'status'], {
      writable: false,
      network: false
    });
    const index = argv.findIndex((value, candidate) => value === '--ro-bind' && argv[candidate + 1] === root);
    assert.deepEqual(argv.slice(index, index + 3), ['--ro-bind', root, '/workspace']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('non-Git inspection cannot enter Git metadata', () => {
  assert.throws(
    () => hardenInspectionCommand(['/usr/bin/cat', '.git/config']),
    /may not access \.git metadata/
  );
  assert.throws(
    () => hardenInspectionCommand(['/usr/bin/ls', '-R', '.']),
    /Recursive ls is blocked/
  );

  const rg = hardenInspectionCommand(['/usr/bin/rg', '--line-number', '--', 'needle', '.']);
  const rgGlob = rg.findIndex((value, index) => value === '--glob' && rg[index + 1] === '!.git/**');
  assert.notEqual(rgGlob, -1);

  const fd = hardenInspectionCommand(['/usr/bin/fd', '--hidden', '--', 'needle', '.']);
  const fdExclude = fd.findIndex((value, index) => value === '--exclude' && fd[index + 1] === '.git');
  assert.notEqual(fdExclude, -1);
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
  if (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && process.env.MCP_SANDBOX_CI_BYPASS === '1') {
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
    await fs.mkdir(path.join(root, '.git'));
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
