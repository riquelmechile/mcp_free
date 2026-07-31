import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BoundedOutputCollector, runCommand } from '../src/core/command.js';

test('bounded output collector never retains more than its configured byte limit', () => {
  const collector = new BoundedOutputCollector(1024);
  collector.append(Buffer.alloc(5 * 1024 * 1024, 0x78));
  assert.equal(collector.totalBytes, 5 * 1024 * 1024);
  assert.equal(collector.retainedBytes, 1024);
  const rendered = collector.render();
  assert.ok(Buffer.byteLength(rendered) <= 1024);
  assert.match(rendered, /output truncated/);
  assert.match(rendered, /5242880 bytes total/);
});

test('logical commands ignore a user-controlled PATH and resolve to a root-owned system binary', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-path-hijack-'));
  try {
    const malicious = path.join(directory, 'ps');
    await fs.writeFile(malicious, '#!/bin/sh\necho MALICIOUS_PATH_EXECUTION\n', { mode: 0o755 });
    const result = await runCommand(['ps', '-o', 'comm=', '-p', String(process.pid)], {
      timeoutMs: 5_000,
      inheritEnv: false,
      env: { PATH: directory, LANG: 'C', LC_ALL: 'C' }
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.argv[0], await fs.realpath('/usr/bin/ps'));
    assert.doesNotMatch(result.stdout, /MALICIOUS_PATH_EXECUTION/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('logical commands sanitize PATH for any helper processes they launch', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-helper-hijack-'));
  try {
    const malicious = path.join(directory, 'mcp-free-evil-helper');
    await fs.writeFile(malicious, '#!/bin/sh\necho HELPER_HIJACKED\n', { mode: 0o755 });
    const result = await runCommand(['sh', '-c', 'command -v mcp-free-evil-helper || true'], {
      timeoutMs: 5_000,
      inheritEnv: false,
      env: { PATH: directory, LANG: 'C', LC_ALL: 'C' }
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), '');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('early child exit while writing stdin does not surface an unhandled EPIPE', async () => {
  const result = await runCommand([process.execPath, '-e', 'process.exit(0)'], {
    timeoutMs: 5_000,
    inheritEnv: false,
    env: {},
    stdin: 'x'.repeat(4 * 1024 * 1024)
  });
  assert.equal(result.exitCode, 0);
});
