import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('writes a content-bound receipt and retrieves it', async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-test-'));
  process.env.MCP_STATE_DIR = state;
  const module = await import(`../src/core/receipts.js?state=${Date.now()}`);
  const receipt = await module.writeReceipt({
    action: 'test', riskTier: 1, success: true, durationMs: 2, output: 'exact bytes', details: { proof: true }
  });
  assert.match(receipt.id, /^rcpt_[a-f0-9]{24}$/);
  assert.equal(receipt.outputSha256, module.sha256('exact bytes'));
  assert.deepEqual(await module.getReceipt(receipt.id), receipt);
  await fs.rm(state, { recursive: true, force: true });
});
