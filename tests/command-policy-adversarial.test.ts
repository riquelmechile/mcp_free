import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  canonicalizeInspectionCommand,
  canonicalizeVerificationCommand,
  validateInspectionCommand,
  validateVerificationCommand
} from '../src/core/command-policy.js';

test('inspection executables must be logical names, never attacker-controlled paths', () => {
  for (const argv of [
    ['/tmp/git', 'status'],
    ['./git', 'status'],
    ['/usr/bin/git', 'status'],
    ['tools/cat', 'README.md']
  ]) {
    assert.throws(() => validateInspectionCommand(argv), /logical name|never a path/);
  }
});

test('inspection grammar rejects execution, output, config, and external-path options', () => {
  assert.throws(() => validateInspectionCommand(['git', 'diff', '--output=out.patch']), /not allowed|write files/);
  assert.throws(() => validateInspectionCommand(['git', 'status', '--config=/etc/passwd']), /not allowed|outside/);
  assert.throws(() => validateInspectionCommand(['rg', '--pre=./processor', 'needle', '.']), /not allowed/);
  assert.throws(() => validateInspectionCommand(['fd', '--exec', 'rm', '{}']), /not allowed/);
  assert.throws(() => validateInspectionCommand(['jq', '-L', '/tmp/modules', '.', 'package.json']), /not allowed/);
  assert.throws(() => validateInspectionCommand(['cat', '../secret']), /inside the project/);
  assert.throws(() => validateInspectionCommand(['cat', '.ssh/id_rsa']), /Credential-like/);
});

test('known read-only command shapes remain accepted', () => {
  assert.doesNotThrow(() => validateInspectionCommand(['git', 'status', '--short']));
  assert.doesNotThrow(() => validateInspectionCommand(['git', 'diff', '--stat', '--', 'src']));
  assert.doesNotThrow(() => validateInspectionCommand(['git', 'grep', 'needle', '--', 'src']));
  assert.doesNotThrow(() => validateInspectionCommand(['rg', '--line-number', '--hidden', 'needle', 'src']));
  assert.doesNotThrow(() => validateInspectionCommand(['jq', '-r', '.name', 'package.json']));
});

test('canonical inspection resolves a root-owned system binary and preserves only safe arguments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-command-policy-'));
  try {
    await fs.writeFile(path.join(root, 'tracked.txt'), 'needle\n');
    const command = await canonicalizeInspectionCommand(['git', 'grep', 'needle', '--', 'tracked.txt'], root);
    assert.match(command[0] ?? '', /^\/usr\//);
    assert.notEqual(command[0], '/tmp/git');
    assert.equal(command.includes('core.fsmonitor=false'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('verification executable and grammar cannot be replaced or widened', async () => {
  assert.throws(() => validateVerificationCommand(['/tmp/npm', 'test']), /logical name|never a path/);
  assert.throws(() => validateVerificationCommand(['npm', 'install']), /restricted|must use/);
  assert.throws(() => validateVerificationCommand(['npm', 'run', 'test', '--', '--config=/etc/passwd']), /restricted|escape/);
  assert.throws(() => validateVerificationCommand(['make', '-f', '/tmp/Makefile']), /escape|target names/);
  assert.throws(() => validateVerificationCommand(['go', 'test', '-exec=/tmp/tool']), /escape|external tools/);
  const command = await canonicalizeVerificationCommand(['npm', 'run', 'check']);
  assert.match(command[0] ?? '', /^\/usr\//);
});
