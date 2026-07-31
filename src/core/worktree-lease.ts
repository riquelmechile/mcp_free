import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export interface WorktreeLease {
  schemaVersion: 1;
  root: string;
  orchestrationId: string;
  acquiredAt: string;
  updatedAt: string;
}

const leaseRoot = path.join(config.stateDir, 'worktree-leases');

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function leasePath(root: string): string {
  const key = crypto.createHash('sha256').update(root).digest('hex');
  return path.join(leaseRoot, `${key}.json`);
}

async function writeAtomic(target: string, value: WorktreeLease): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
}

async function readLeaseFile(target: string): Promise<WorktreeLease> {
  const parsed = JSON.parse(await fs.readFile(target, 'utf8')) as WorktreeLease;
  if (parsed.schemaVersion !== 1 || !path.isAbsolute(parsed.root) || !/^orch_[a-f0-9]{24}$/.test(parsed.orchestrationId)) {
    throw new Error(`Invalid worktree lease: ${target}`);
  }
  return parsed;
}

export async function listWorktreeLeases(): Promise<WorktreeLease[]> {
  try {
    const entries = await fs.readdir(leaseRoot);
    return await Promise.all(entries.filter(name => name.endsWith('.json')).map(name => readLeaseFile(path.join(leaseRoot, name))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function acquireWorktreeLease(root: string, orchestrationId: string): Promise<{ lease: WorktreeLease; acquired: boolean }> {
  const realRoot = await fs.realpath(root);
  const target = leasePath(realRoot);
  await fs.mkdir(leaseRoot, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const lease: WorktreeLease = {
    schemaVersion: 1,
    root: realRoot,
    orchestrationId,
    acquiredAt: now,
    updatedAt: now
  };
  try {
    await fs.writeFile(target, `${JSON.stringify(lease, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { lease, acquired: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readLeaseFile(target);
    if (existing.root !== realRoot) throw new Error('Worktree lease hash collision');
    if (existing.orchestrationId !== orchestrationId) {
      throw new Error(`Worktree is leased by ${existing.orchestrationId}; finish or cancel it before modifying ${realRoot}`);
    }
    existing.updatedAt = now;
    await writeAtomic(target, existing);
    return { lease: existing, acquired: false };
  }
}

export async function assertWorktreeLease(root: string, orchestrationId: string): Promise<WorktreeLease> {
  const realRoot = await fs.realpath(root);
  const lease = await readLeaseFile(leasePath(realRoot));
  if (lease.root !== realRoot || lease.orchestrationId !== orchestrationId) {
    throw new Error(`Worktree lease is not owned by ${orchestrationId}`);
  }
  return lease;
}

export async function releaseWorktreeLease(root: string, orchestrationId: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  const target = leasePath(realRoot);
  try {
    const lease = await readLeaseFile(target);
    if (lease.root !== realRoot || lease.orchestrationId !== orchestrationId) {
      throw new Error(`Refusing to release worktree lease owned by ${lease.orchestrationId}`);
    }
    await fs.rm(target, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function assertPathNotLeased(candidate: string): Promise<void> {
  const absolute = path.resolve(candidate);
  for (const lease of await listWorktreeLeases()) {
    if (within(absolute, lease.root)) {
      throw new Error(`Path is protected by active development orchestration ${lease.orchestrationId}: ${lease.root}`);
    }
  }
}
