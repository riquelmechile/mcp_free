import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('workspace mode exposes no generic command runner or coding-agent launcher', async () => {
  const source = await fs.readFile(new URL('../src/tools/workspace.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /workspace_execute/);
  assert.doesNotMatch(source, /runCommand\(/);
  assert.doesNotMatch(source, /opencode|codex|claude|gemini|npx/);
});
