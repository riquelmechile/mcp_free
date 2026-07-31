import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { ActionReceipt, ReceiptChainVerification, RiskTier } from '../types.js';

const auditPath = path.join(config.stateDir, 'audit.jsonl');
const receiptDir = path.join(config.stateDir, 'receipts');
const chainHeadPath = path.join(config.stateDir, 'chain-head.json');
let receiptWriteQueue: Promise<void> = Promise.resolve();
const receiptLockPath = path.join(config.stateDir, 'receipt-chain.lock');
const receiptLockToken = `${process.pid}-${crypto.randomBytes(12).toString('hex')}`;

async function processIsAlive(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function withReceiptFilesystemLock<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      await fs.mkdir(receiptLockPath, { mode: 0o700 });
      await fs.writeFile(path.join(receiptLockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token: receiptLockToken }), { mode: 0o600, flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const owner = JSON.parse(await fs.readFile(path.join(receiptLockPath, 'owner.json'), 'utf8')) as { pid?: number };
        stale = !(await processIsAlive(owner.pid ?? -1));
      } catch {
        const metadata = await fs.stat(receiptLockPath);
        stale = Date.now() - metadata.mtimeMs > 60_000;
      }
      if (stale) { await fs.rm(receiptLockPath, { recursive: true, force: true }); continue; }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for receipt-chain lock');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await operation(); } finally {
    try {
      const owner = JSON.parse(await fs.readFile(path.join(receiptLockPath, 'owner.json'), 'utf8')) as { token?: string };
      if (owner.token !== receiptLockToken) throw new Error('Refusing to release another process receipt lock');
      await fs.rm(receiptLockPath, { recursive: true, force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

async function ensureState(): Promise<void> {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(receiptDir, { recursive: true, mode: 0o700 });
  await fs.chmod(config.stateDir, 0o700);
  await fs.chmod(receiptDir, 0o700);
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : canonicalValue(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function payloadId(receipt: Omit<ActionReceipt, 'id' | 'receiptHash'>): string {
  return `rcpt_${sha256(canonicalJson(receipt)).slice(0, 24)}`;
}

function receiptHash(receipt: Omit<ActionReceipt, 'receiptHash'>): string {
  return sha256(canonicalJson(receipt));
}

function isActionReceipt(value: unknown): value is ActionReceipt {
  if (value === null || typeof value !== 'object') return false;
  const receipt = value as Partial<ActionReceipt>;
  return receipt.chainVersion === 1
    && Number.isInteger(receipt.sequence)
    && typeof receipt.sequence === 'number'
    && receipt.sequence > 0
    && (receipt.previousReceiptHash === null || typeof receipt.previousReceiptHash === 'string')
    && typeof receipt.receiptHash === 'string'
    && typeof receipt.id === 'string'
    && typeof receipt.timestamp === 'string'
    && typeof receipt.action === 'string'
    && typeof receipt.success === 'boolean';
}

function verifyReceiptIdentity(receipt: ActionReceipt): string[] {
  const errors: string[] = [];
  const { id, receiptHash: actualHash, ...payload } = receipt;
  const expectedId = payloadId(payload);
  if (id !== expectedId) errors.push(`${id}: expected content-derived id ${expectedId}`);
  const expectedHash = receiptHash({ ...payload, id });
  if (actualHash !== expectedHash) errors.push(`${id}: receiptHash mismatch`);
  return errors;
}

async function readAudit(errors: string[]): Promise<ActionReceipt[]> {
  let raw: string;
  try {
    raw = await fs.readFile(auditPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const receipts: ActionReceipt[] = [];
  const lines = raw.split('\n').filter(line => line.length > 0);
  for (const [index, line] of lines.entries()) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isActionReceipt(parsed)) {
        errors.push(`audit line ${index + 1}: legacy or invalid receipt shape`);
        continue;
      }
      receipts.push(parsed);
    } catch {
      errors.push(`audit line ${index + 1}: invalid JSON`);
    }
  }
  return receipts;
}

async function verifyReceiptChainUnlocked(): Promise<ReceiptChainVerification> {
  await ensureState();
  const errors: string[] = [];
  const receipts = await readAudit(errors);
  const missingReceiptFiles: string[] = [];
  let previousHash: string | null = null;

  for (const [index, receipt] of receipts.entries()) {
    const expectedSequence = index + 1;
    if (receipt.sequence !== expectedSequence) {
      errors.push(`${receipt.id}: sequence ${receipt.sequence}, expected ${expectedSequence}`);
    }
    if (receipt.previousReceiptHash !== previousHash) {
      errors.push(`${receipt.id}: previousReceiptHash does not match chain head`);
    }
    errors.push(...verifyReceiptIdentity(receipt));

    const receiptPath = path.join(receiptDir, `${receipt.id}.json`);
    try {
      const fileReceipt: unknown = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
      if (!isActionReceipt(fileReceipt) || canonicalJson(fileReceipt) !== canonicalJson(receipt)) {
        errors.push(`${receipt.id}: receipt file differs from audit entry`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        missingReceiptFiles.push(`${receipt.id}.json`);
        errors.push(`${receipt.id}: receipt file is missing`);
      } else {
        errors.push(`${receipt.id}: receipt file is invalid or unreadable`);
      }
    }
    previousHash = receipt.receiptHash;
  }

  const knownFiles = new Set(receipts.map(receipt => `${receipt.id}.json`));
  const orphanReceiptFiles = (await fs.readdir(receiptDir))
    .filter(name => name.endsWith('.json') && !knownFiles.has(name))
    .sort();
  for (const orphan of orphanReceiptFiles) errors.push(`${orphan}: orphan receipt file not present in audit chain`);

  let headHash: string | null = null;
  let lastReceiptId: string | null = null;
  if (receipts.length > 0) {
    const last = receipts.at(-1);
    if (!last) throw new Error('Internal receipt-chain error');
    headHash = last.receiptHash;
    lastReceiptId = last.id;
    try {
      const head = JSON.parse(await fs.readFile(chainHeadPath, 'utf8')) as Record<string, unknown>;
      if (head.sequence !== last.sequence || head.receiptId !== last.id || head.receiptHash !== last.receiptHash) {
        errors.push('chain-head.json does not match the final audit receipt');
      }
    } catch {
      errors.push('chain-head.json is missing or invalid');
    }
  } else {
    try {
      await fs.access(chainHeadPath);
      errors.push('chain-head.json exists but the audit chain is empty');
    } catch {
      // Expected for a fresh state directory.
    }
  }

  return {
    valid: errors.length === 0,
    entries: receipts.length,
    headHash,
    lastReceiptId,
    orphanReceiptFiles,
    missingReceiptFiles,
    errors
  };
}

export async function verifyReceiptChain(): Promise<ReceiptChainVerification> {
  await receiptWriteQueue;
  return withReceiptFilesystemLock(() => verifyReceiptChainUnlocked());
}

async function writeChainHead(receipt: ActionReceipt): Promise<void> {
  const temporary = `${chainHeadPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const content = `${JSON.stringify({
    chainVersion: 1,
    sequence: receipt.sequence,
    receiptId: receipt.id,
    receiptHash: receipt.receiptHash,
    updatedAt: receipt.timestamp
  }, null, 2)}\n`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, chainHeadPath);
  await fs.chmod(chainHeadPath, 0o600);
  const directory = await fs.open(path.dirname(chainHeadPath), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function writeReceiptUnlocked(input: {
  action: string;
  riskTier: RiskTier;
  success: boolean;
  durationMs: number;
  requestId?: string | undefined;
  target?: string | undefined;
  command?: string[] | undefined;
  exitCode?: number | null | undefined;
  output?: string | undefined;
  details?: Record<string, unknown> | undefined;
}): Promise<ActionReceipt> {
  await ensureState();
  const verification = await verifyReceiptChainUnlocked();
  if (!verification.valid) {
    throw new Error(`Receipt chain verification failed; refusing to append: ${verification.errors.join('; ')}`);
  }

  const timestamp = new Date().toISOString();
  const payload: Omit<ActionReceipt, 'id' | 'receiptHash'> = {
    chainVersion: 1,
    sequence: verification.entries + 1,
    previousReceiptHash: verification.headHash,
    timestamp,
    action: input.action,
    riskTier: input.riskTier,
    mode: config.mode,
    success: input.success,
    durationMs: input.durationMs,
    details: input.details ?? {}
  };
  if (input.requestId !== undefined) payload.requestId = input.requestId;
  if (input.target !== undefined) payload.target = input.target;
  if (input.command !== undefined) payload.command = input.command;
  if (input.exitCode !== undefined) payload.exitCode = input.exitCode;
  if (input.output !== undefined) payload.outputSha256 = sha256(input.output);

  const id = payloadId(payload);
  const withoutHash: Omit<ActionReceipt, 'receiptHash'> = { ...payload, id };
  const receipt: ActionReceipt = { ...withoutHash, receiptHash: receiptHash(withoutHash) };
  const serialized = `${canonicalJson(receipt)}\n`;
  const receiptPath = path.join(receiptDir, `${receipt.id}.json`);

  // O_EXCL prevents accidental overwrite. The audit log is append-only at the application layer.
  const receiptFile = await fs.open(receiptPath, 'wx', 0o600);
  try { await receiptFile.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8'); await receiptFile.sync(); } finally { await receiptFile.close(); }
  const audit = await fs.open(auditPath, 'a', 0o600);
  try {
    await audit.write(serialized);
    await audit.sync();
  } finally {
    await audit.close();
  }
  await writeChainHead(receipt);
  return receipt;
}

export function writeReceipt(input: {
  action: string;
  riskTier: RiskTier;
  success: boolean;
  durationMs: number;
  requestId?: string | undefined;
  target?: string | undefined;
  command?: string[] | undefined;
  exitCode?: number | null | undefined;
  output?: string | undefined;
  details?: Record<string, unknown> | undefined;
}): Promise<ActionReceipt> {
  const operation = receiptWriteQueue.then(() => withReceiptFilesystemLock(() => writeReceiptUnlocked(input)));
  receiptWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function getReceipt(id: string): Promise<ActionReceipt> {
  await receiptWriteQueue;
  await ensureState();
  const parsed: unknown = JSON.parse(await fs.readFile(path.join(receiptDir, `${id}.json`), 'utf8'));
  if (!isActionReceipt(parsed)) throw new Error(`Receipt ${id} has an invalid shape`);
  const errors = verifyReceiptIdentity(parsed);
  if (errors.length > 0) throw new Error(errors.join('; '));
  return parsed;
}

export async function listReceipts(limit = 25): Promise<ActionReceipt[]> {
  await receiptWriteQueue;
  await ensureState();
  const entries = await fs.readdir(receiptDir);
  const receipts = await Promise.all(entries.filter(name => name.endsWith('.json')).map(async name => {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(receiptDir, name), 'utf8'));
    if (!isActionReceipt(parsed)) throw new Error(`Receipt file ${name} has an invalid shape`);
    return parsed;
  }));
  return receipts.sort((left, right) => right.sequence - left.sequence).slice(0, Math.min(limit, 200));
}
