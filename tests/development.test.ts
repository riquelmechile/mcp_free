import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildAgentInvocation,
  buildDevelopmentPrompt,
  chooseDevelopmentAgent,
  detectVerificationCommands,
  type DevelopmentAgentState
} from '../src/core/development.js';

const states: DevelopmentAgentState[] = [
  { id: 'opencode', executable: 'opencode', available: true, gentleConfigured: true, configurationEvidence: ['/tmp/opencode.json'] },
  { id: 'codex', executable: 'codex', available: true, gentleConfigured: true, configurationEvidence: ['/tmp/AGENTS.md'] },
  { id: 'claude', executable: 'claude', available: false, gentleConfigured: false, configurationEvidence: [] },
  { id: 'gemini', executable: 'gemini', available: false, gentleConfigured: false, configurationEvidence: [] }
];

test('auto prefers a Gentle-configured OpenCode agent', () => {
  assert.equal(chooseDevelopmentAgent(states, 'auto').id, 'opencode');
});

test('OpenCode invocation selects gentle-orchestrator and gates auto approval', () => {
  const normal = buildAgentInvocation({ agent: states[0]!, prompt: 'task', cwd: '/tmp/project', autoApprove: false });
  assert.deepEqual(normal.slice(0, 7), ['opencode', 'run', '--dir', '/tmp/project', '--agent', 'gentle-orchestrator', '--title']);
  assert.equal(normal.includes('--auto'), false);
  const automatic = buildAgentInvocation({ agent: states[0]!, prompt: 'task', cwd: '/tmp/project', autoApprove: true });
  assert.equal(automatic.includes('--auto'), true);
});

test('development prompt preserves unrelated work and requests Gentle routing', () => {
  const prompt = buildDevelopmentPrompt({
    task: 'Implement the requested feature',
    cwd: '/tmp/project',
    useSdd: false,
    baselineStatus: ' M existing.ts',
    verificationCommands: [['npm', 'run', 'check']]
  });
  assert.match(prompt, /Gentle AI organic routing/);
  assert.match(prompt, /preserve unrelated pre-existing changes/);
  assert.match(prompt, /Do not commit, push/);
  assert.match(prompt, /npm run check/);
  assert.match(prompt, /Implement the requested feature/);
});

test('auto-detects bounded package verification scripts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-dev-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { check: 'tsc --noEmit && npm test', build: 'tsc' } }));
  await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  assert.deepEqual(await detectVerificationCommands(root), [['pnpm', 'run', 'check'], ['pnpm', 'run', 'build']]);
  await fs.rm(root, { recursive: true, force: true });
});
