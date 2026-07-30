import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('writes a content-bound hash chain and detects receipt tampering', async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-test-'));
  process.env.MCP_STATE_DIR = state;
  const module = await import(`../src/core/receipts.js?state=${Date.now()}`);

  const first = await module.writeReceipt({
    action: 'test-first', riskTier: 1, success: true, durationMs: 2, output: 'exact bytes', details: { proof: true }
  });
  const second = await module.writeReceipt({
    action: 'test-second', riskTier: 2, success: true, durationMs: 3, output: 'more bytes', details: { proof: 'second' }
  });

  assert.match(first.id, /^rcpt_[a-f0-9]{24}$/);
  assert.equal(first.sequence, 1);
  assert.equal(first.previousReceiptHash, null);
  assert.equal(first.outputSha256, module.sha256('exact bytes'));
  assert.equal(second.sequence, 2);
  assert.equal(second.previousReceiptHash, first.receiptHash);
  assert.deepEqual(await module.getReceipt(first.id), first);

  const valid = await module.verifyReceiptChain();
  assert.equal(valid.valid, true);
  assert.equal(valid.entries, 2);
  assert.equal(valid.headHash, second.receiptHash);
  assert.deepEqual(valid.errors, []);

  const secondPath = path.join(state, 'receipts', `${second.id}.json`);
  const tampered = { ...second, action: 'tampered-after-the-fact' };
  await fs.writeFile(secondPath, JSON.stringify(tampered, null, 2));

  const invalid = await module.verifyReceiptChain();
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error: string) => error.includes('differs from audit entry')));

  await assert.rejects(
    module.writeReceipt({ action: 'must-fail-closed', riskTier: 1, success: true, durationMs: 1 }),
    /Receipt chain verification failed/
  );

  await fs.rm(state, { recursive: true, force: true });
});
