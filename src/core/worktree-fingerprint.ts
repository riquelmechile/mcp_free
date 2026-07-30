import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { runCommand } from './command.js';
import type { OrchestrationState } from './development.js';

interface FingerprintRecord {
  schemaVersion: 1;
  orchestrationId: string;
  root: string;
  branch: string;
  head: string | null;
  fingerprint: string;
  recordedAt: string;
}

const MAX_INTERNAL_OUTPUT = 16 * 1024 * 1024;
const TRUNCATED_MARKER = '\n...[output truncated; ';

function recordPath(id: string): string {
  if (!/^orch_[a-f0-9]{24}$/.test(id)) throw new Error('Invalid orchestration_id');
  return path.join(config.stateDir, 'orchestrations', id, 'verification-fingerprint.json');
}

function assertComplete(result: { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }, label: string): void {
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  if (result.stdout.includes(TRUNCATED_MARKER) || result.stderr.includes(TRUNCATED_MARKER)) {
    throw new Error(`${label} exceeded the internal fingerprint limit`);
  }
}

async function updateFileHash(hash: crypto.Hash, root: string, relative: string): Promise<void> {
  const absolute = path.join(root, relative);
  hash.update(`path\0${relative}\0`);
  let metadata;
  try {
    metadata = await fs.lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      hash.update('missing\0');
      return;
    }
    throw error;
  }

  hash.update(`mode\0${metadata.mode.toString(8)}\0size\0${metadata.size}\0`);
  if (metadata.isSymbolicLink()) {
    hash.update(`symlink\0${await fs.readlink(absolute)}\0`);
    return;
  }
  if (!metadata.isFile()) {
    hash.update('non-file\0');
    return;
  }

  const handle = await fs.open(absolute, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  hash.update('\0');
}

async function changedPaths(root: string): Promise<{ status: string; paths: string[]; indexEntries: string[] }> {
  const options = { cwd: root, timeoutMs: 60_000, maxOutputBytes: MAX_INTERNAL_OUTPUT };
  const [status, unstaged, staged, untracked] = await Promise.all([
    runCommand(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], options),
    runCommand(['git', 'diff', '--name-only', '-z', '--no-ext-diff'], options),
    runCommand(['git', 'diff', '--cached', '--name-only', '-z', '--no-ext-diff'], options),
    runCommand(['git', 'ls-files', '--others', '--exclude-standard', '-z'], options)
  ]);
  assertComplete(status, 'git status for fingerprint');
  assertComplete(unstaged, 'git diff names for fingerprint');
  assertComplete(staged, 'git staged names for fingerprint');
  assertComplete(untracked, 'git untracked names for fingerprint');

  const paths = new Set<string>();
  for (const output of [unstaged.stdout, staged.stdout, untracked.stdout]) {
    for (const value of output.split('\0').filter(Boolean)) paths.add(value);
  }

  const indexEntries: string[] = [];
  for (const relative of [...paths].sort()) {
    const entry = await runCommand(['git', 'ls-files', '-s', '--', relative], {
      cwd: root,
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024
    });
    assertComplete(entry, `git index entry for ${relative}`);
    indexEntries.push(`${relative}\0${entry.stdout}`);
  }

  return { status: status.stdout, paths: [...paths].sort(), indexEntries };
}

export async function computeWorktreeFingerprint(root: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const identity = await Promise.all([
    runCommand(['git', 'branch', '--show-current'], { cwd: realRoot, timeoutMs: 10_000 }),
    runCommand(['git', 'rev-parse', '--verify', 'HEAD'], { cwd: realRoot, timeoutMs: 10_000 })
  ]);
  identity.forEach((result, index) => assertComplete(result, index === 0 ? 'git branch for fingerprint' : 'git head for fingerprint'));

  const changed = await changedPaths(realRoot);
  const hash = crypto.createHash('sha256');
  hash.update(`root\0${realRoot}\0branch\0${identity[0]!.stdout.trim()}\0head\0${identity[1]!.stdout.trim()}\0`);
  hash.update(`status\0${changed.status}\0`);
  for (const entry of changed.indexEntries) hash.update(`index\0${entry}\0`);
  for (const relative of changed.paths) await updateFileHash(hash, realRoot, relative);
  return hash.digest('hex');
}

async function writeAtomic(target: string, value: FingerprintRecord): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
}

export async function recordVerifiedWorktree(state: OrchestrationState): Promise<FingerprintRecord> {
  if (state.status !== 'verified' || state.verification?.success !== true) {
    throw new Error('A worktree fingerprint can only be recorded after successful verification');
  }
  const record: FingerprintRecord = {
    schemaVersion: 1,
    orchestrationId: state.id,
    root: state.root,
    branch: state.baseline.branch,
    head: state.baseline.head,
    fingerprint: await computeWorktreeFingerprint(state.root),
    recordedAt: new Date().toISOString()
  };
  await writeAtomic(recordPath(state.id), record);
  return record;
}

export async function assertVerifiedWorktreeUnchanged(state: OrchestrationState): Promise<FingerprintRecord> {
  const record = JSON.parse(await fs.readFile(recordPath(state.id), 'utf8')) as FingerprintRecord;
  if (record.schemaVersion !== 1 || record.orchestrationId !== state.id || record.root !== state.root) {
    throw new Error('Verification fingerprint record is invalid');
  }
  const current = await computeWorktreeFingerprint(state.root);
  if (current !== record.fingerprint) {
    throw new Error('Worktree bytes or index changed after verification; run development_verify again before finalization');
  }
  return record;
}
