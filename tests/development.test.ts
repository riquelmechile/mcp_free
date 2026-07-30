import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  defaultLaneSpecs,
  detectVerificationCommands,
  dirtyPathsFromStatus,
  extractPatchPaths,
  validateInspectionCommand,
  validateVerificationCommand
} from '../src/core/development.js';

test('creates three distinct ChatGPT-controlled logical lanes', () => {
  assert.deepEqual(defaultLaneSpecs(3).map(lane => lane.role), ['explore', 'design', 'review']);
  assert.deepEqual(defaultLaneSpecs(2).map(lane => lane.role), ['explore', 'review']);
  assert.equal(defaultLaneSpecs(1)[0]?.id, 'lane-1');
  assert.throws(() => defaultLaneSpecs(4), /between 1 and 3/);
});

test('inspection commands remain read-only and project-local', () => {
  assert.doesNotThrow(() => validateInspectionCommand(['rg', 'development_execute', 'src']));
  assert.doesNotThrow(() => validateInspectionCommand(['git', 'diff', '--', 'src']));
  assert.throws(() => validateInspectionCommand(['git', 'reset', '--hard']), /not read-only/);
  assert.throws(() => validateInspectionCommand(['find', '.', '-delete']), /Mutating find/);
  assert.throws(() => validateInspectionCommand(['sed', '-i', 's/a/b/', 'file.ts']), /sed -i/);
  assert.throws(() => validateInspectionCommand(['cat', '../secret']), /stay inside/);
  assert.throws(() => validateInspectionCommand(['cat', '.env']), /credential-like/);
});

test('extracts bounded patch paths and rejects escapes', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/tests/a.test.ts b/tests/a.test.ts',
    '--- /dev/null',
    '+++ b/tests/a.test.ts'
  ].join('\n');
  assert.deepEqual(extractPatchPaths(patch), ['src/a.ts', 'tests/a.test.ts']);
  assert.throws(() => extractPatchPaths('--- a/file\n+++ b/../escape'), /escapes the project/);
  assert.throws(() => extractPatchPaths('--- a/file\n+++ b/.env'), /credential-like/);
});

test('parses pre-existing dirty paths for overlap protection', () => {
  assert.deepEqual(
    dirtyPathsFromStatus(' M src/a.ts\n?? new.txt\nR  old.ts -> moved.ts'),
    ['moved.ts', 'new.txt', 'old.ts', 'src/a.ts']
  );
});

test('verification commands are bounded', () => {
  assert.doesNotThrow(() => validateVerificationCommand(['npm', 'run', 'check']));
  assert.doesNotThrow(() => validateVerificationCommand(['git', 'diff', '--check']));
  assert.throws(() => validateVerificationCommand(['git', 'push']), /Only git diff --check/);
  assert.throws(() => validateVerificationCommand(['bash', '-c', 'anything']), /not allowed/);
});

test('auto-detects bounded package verification scripts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-dev-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { check: 'tsc --noEmit && npm test', build: 'tsc' } }));
  await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  assert.deepEqual(await detectVerificationCommands(root), [['pnpm', 'run', 'check'], ['pnpm', 'run', 'build']]);
  await fs.rm(root, { recursive: true, force: true });
});
