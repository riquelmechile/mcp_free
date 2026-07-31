import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('receipt verification and append initialize a completely missing state directory', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-fresh-receipts-'));
  const stateDir = path.join(base, 'missing', 'state');
  process.env.MCP_MODE = 'observe';
  process.env.MCP_STATE_DIR = stateDir;

  try {
    const receipts = await import(`../src/core/receipts.js?fresh=${Date.now()}`);
    const initial = await receipts.verifyReceiptChain();
    assert.equal(initial.valid, true);
    assert.equal(initial.entries, 0);
    assert.equal((await fs.stat(stateDir)).isDirectory(), true);

    const receipt = await receipts.writeReceipt({
      action: 'fresh_state_test',
      riskTier: 0,
      success: true,
      durationMs: 1,
      details: { initializedFreshState: true }
    });
    assert.equal(receipt.sequence, 1);

    const verified = await receipts.verifyReceiptChain();
    assert.equal(verified.valid, true);
    assert.equal(verified.entries, 1);
    assert.equal(verified.lastReceiptId, receipt.id);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
