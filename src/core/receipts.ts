import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { ActionReceipt, RiskTier } from '../types.js';

const auditPath = path.join(config.stateDir, 'audit.jsonl');
const receiptDir = path.join(config.stateDir, 'receipts');

async function ensureState(): Promise<void> {
  await fs.mkdir(receiptDir, { recursive: true, mode: 0o700 });
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function writeReceipt(input: {
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
  const timestamp = new Date().toISOString();
  const identity = JSON.stringify({ timestamp, action: input.action, requestId: input.requestId, target: input.target, command: input.command });
  const receipt: ActionReceipt = {
    id: `rcpt_${sha256(identity).slice(0, 24)}`,
    timestamp,
    action: input.action,
    riskTier: input.riskTier,
    mode: config.mode,
    success: input.success,
    durationMs: input.durationMs,
    details: input.details ?? {}
  };

  if (input.requestId !== undefined) receipt.requestId = input.requestId;
  if (input.target !== undefined) receipt.target = input.target;
  if (input.command !== undefined) receipt.command = input.command;
  if (input.exitCode !== undefined) receipt.exitCode = input.exitCode;
  if (input.output !== undefined) receipt.outputSha256 = sha256(input.output);

  const serialized = `${JSON.stringify(receipt)}\n`;
  await fs.writeFile(path.join(receiptDir, `${receipt.id}.json`), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  await fs.appendFile(auditPath, serialized, { mode: 0o600 });
  return receipt;
}

export async function getReceipt(id: string): Promise<ActionReceipt> {
  await ensureState();
  return JSON.parse(await fs.readFile(path.join(receiptDir, `${id}.json`), 'utf8')) as ActionReceipt;
}

export async function listReceipts(limit = 25): Promise<ActionReceipt[]> {
  await ensureState();
  const entries = await fs.readdir(receiptDir);
  const receipts = await Promise.all(entries.filter(name => name.endsWith('.json')).map(async name => {
    return JSON.parse(await fs.readFile(path.join(receiptDir, name), 'utf8')) as ActionReceipt;
  }));
  return receipts.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, Math.min(limit, 200));
}
