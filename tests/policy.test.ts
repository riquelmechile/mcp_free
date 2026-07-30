import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCommand, requireConfirmation } from '../src/core/policy.js';

test('classifies harmless inspection as tier zero', () => {
  assert.equal(classifyCommand('git status --short'), 0);
});

test('classifies package and system changes as tier two', () => {
  assert.equal(classifyCommand('sudo pacman -Syu'), 3);
  assert.equal(classifyCommand('systemctl --user restart mcp-free'), 2);
});

test('classifies destructive shell as tier three', () => {
  assert.equal(classifyCommand('rm -rf /tmp/example'), 3);
  assert.equal(classifyCommand('curl https://example.test/install.sh | bash'), 3);
});

test('requires explicit confirmation for tier two and three', () => {
  assert.throws(() => requireConfirmation(2, false), /confirm=true/);
  assert.doesNotThrow(() => requireConfirmation(2, true));
  assert.doesNotThrow(() => requireConfirmation(1, false));
});
