#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def read(path: str) -> str:
    return (ROOT / path).read_text()

def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content)

def replace(path: str, old: str, new: str) -> None:
    content = read(path)
    if old not in content:
        raise SystemExit(f'expected text not found in {path}: {old[:120]!r}')
    write(path, content.replace(old, new, 1))

def regex_replace(path: str, pattern: str, replacement: str) -> None:
    content = read(path)
    updated, count = re.subn(pattern, replacement, content, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'expected one regex match in {path}, got {count}')
    write(path, updated)

replace('src/core/development.ts', "import { runCommand } from './command.js';\n", '')

regex_replace(
    'src/core/development.ts',
    r"export async function captureGitSnapshot\(cwd: string\): Promise<GitSnapshot> \{.*?\n\}\n\nexport function defaultLaneSpecs",
    r"""async function findStandardGitRoot(cwd: string): Promise<string> {
  let cursor = await fs.realpath(cwd);
  const metadata = await fs.stat(cursor);
  if (!metadata.isDirectory()) cursor = path.dirname(cursor);
  while (true) {
    const gitMetadata = path.join(cursor, '.git');
    try {
      const gitStat = await fs.lstat(gitMetadata);
      if (gitStat.isDirectory()) return cursor;
      if (gitStat.isFile()) {
        throw new Error('Linked Git worktrees and submodules are rejected because their metadata lives outside the sandbox root');
      }
      throw new Error(`Unsupported Git metadata entry: ${gitMetadata}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error('Development orchestration requires a standard Git worktree with a .git directory');
    cursor = parent;
  }
}

export async function captureGitSnapshot(cwd: string): Promise<GitSnapshot> {
  const root = await findStandardGitRoot(cwd);
  const logicalCommands = [
    ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
    ['git', 'rev-parse', '--verify', 'HEAD'],
    ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
    ['git', 'diff', '--stat']
  ];
  const canonical = await Promise.all(logicalCommands.map(command => canonicalizeInspectionCommand(command, root)));
  const results = await Promise.all(canonical.map(command => runInspectionCommand(root, command, { timeoutMs: 15_000 })));
  const branch = results[0];
  const head = results[1];
  const status = results[2];
  const diffStat = results[3];
  if (!branch || !head || !status || !diffStat) throw new Error('Incomplete Git snapshot results');
  for (const result of results) {
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`Sandboxed Git snapshot failed: ${cleanOutput(result)}`);
  }
  return {
    root,
    branch: branch.stdout.trim() || '(detached)',
    head: head.stdout.trim() || null,
    status: status.stdout.trim(),
    diffStat: diffStat.stdout.trim()
  };
}

export function defaultLaneSpecs"""
)

regex_replace(
    'src/core/development.ts',
    r"const INSPECTION_ENV: Record<string, string> = \{.*?\n\};\n",
    ''
)

replace(
    'src/core/development.ts',
    """      const git = await resolveTrustedExecutable('git');
      const check = await runCommand([git, 'apply', '--check', '--', '-'], { cwd: state.root, stdin: patchText, timeoutMs: 60_000, inheritEnv: false, env: INSPECTION_ENV });
      if (check.exitCode !== 0 || check.timedOut) throw new Error(`git apply --check failed: ${cleanOutput(check)}`);
      const apply = await runCommand([git, 'apply', '--whitespace=nowarn', '--', '-'], { cwd: state.root, stdin: patchText, timeoutMs: 120_000, inheritEnv: false, env: INSPECTION_ENV });""",
    """      const git = await resolveTrustedExecutable('git');
      const check = await runVerificationCommand(state.root, [git, 'apply', '--check', '--', '-'], {
        stdin: patchText,
        timeoutMs: 60_000
      });
      if (check.exitCode !== 0 || check.timedOut) throw new Error(`git apply --check failed: ${cleanOutput(check)}`);
      const apply = await runVerificationCommand(state.root, [git, 'apply', '--whitespace=nowarn', '--', '-'], {
        stdin: patchText,
        timeoutMs: 120_000
      });"""
)

replace(
    'src/core/command-policy.ts',
    """      noValue: new Set(['--short', '-s', '--branch', '-b', '--porcelain', '--ignored', '--no-ahead-behind']),
      value: new Set(['--untracked-files'])""",
    """      noValue: new Set(['--short', '-s', '--branch', '-b', '--porcelain', '--ignored', '--no-ahead-behind', '-z']),
      value: new Set(['--untracked-files']),
      compact: [/^--porcelain(?:=v1|=v2)?$/]"""
)

write('src/core/worktree-fingerprint.ts', r'''import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { CommandResult } from '../types.js';
import { canonicalizeInspectionCommand } from './command-policy.js';
import type { OrchestrationState } from './development.js';
import { runInspectionCommand } from './verification-sandbox.js';

export interface FingerprintRecord {
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

async function runGit(root: string, logical: string[], timeoutMs: number): Promise<CommandResult> {
  const canonical = await canonicalizeInspectionCommand(logical, root);
  return runInspectionCommand(root, canonical, { timeoutMs, maxOutputBytes: MAX_INTERNAL_OUTPUT });
}

function recordPath(id: string): string {
  if (!/^orch_[a-f0-9]{24}$/.test(id)) throw new Error('Invalid orchestration_id');
  return path.join(config.stateDir, 'orchestrations', id, 'verification-fingerprint.json');
}

function assertComplete(result: { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }, label: string): void {
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  if (result.stdout.includes(TRUNCATED_MARKER) || result.stderr.includes(TRUNCATED_MARKER)) throw new Error(`${label} exceeded the internal fingerprint limit`);
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

async function worktreeInventory(root: string): Promise<{ status: string; paths: string[]; indexEntries: string }> {
  const [status, tracked, untracked, index] = await Promise.all([
    runGit(root, ['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], 60_000),
    runGit(root, ['git', 'ls-files', '-z'], 60_000),
    runGit(root, ['git', 'ls-files', '--others', '--exclude-standard', '-z'], 60_000),
    runGit(root, ['git', 'ls-files', '-s', '-z'], 60_000)
  ]);
  assertComplete(status, 'git status for fingerprint');
  assertComplete(tracked, 'git tracked files for fingerprint');
  assertComplete(untracked, 'git untracked files for fingerprint');
  assertComplete(index, 'git index for fingerprint');

  const paths = new Set<string>();
  for (const output of [tracked.stdout, untracked.stdout]) {
    for (const value of output.split('\0').filter(Boolean)) paths.add(value);
  }
  return { status: status.stdout, paths: [...paths].sort(), indexEntries: index.stdout };
}

export async function computeWorktreeFingerprint(root: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const identity = await Promise.all([
    runGit(realRoot, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], 10_000),
    runGit(realRoot, ['git', 'rev-parse', '--verify', 'HEAD'], 10_000)
  ]);
  identity.forEach((result, index) => assertComplete(result, index === 0 ? 'git branch for fingerprint' : 'git head for fingerprint'));

  const inventory = await worktreeInventory(realRoot);
  const hash = crypto.createHash('sha256');
  hash.update(`root\0${realRoot}\0branch\0${identity[0]!.stdout.trim()}\0head\0${identity[1]!.stdout.trim()}\0`);
  hash.update(`status\0${inventory.status}\0index\0${inventory.indexEntries}\0`);
  for (const relative of inventory.paths) await updateFileHash(hash, realRoot, relative);
  return hash.digest('hex');
}

async function writeAtomic(target: string, value: FingerprintRecord): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, target);
  const directory = await fs.open(path.dirname(target), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function writeVerifiedWorktreeFingerprint(state: OrchestrationState, fingerprint: string): Promise<FingerprintRecord> {
  if (state.status !== 'verified' || state.verification?.success !== true) {
    throw new Error('A worktree fingerprint can only be recorded after successful verification');
  }
  const record: FingerprintRecord = {
    schemaVersion: 1,
    orchestrationId: state.id,
    root: state.root,
    branch: state.baseline.branch,
    head: state.baseline.head,
    fingerprint,
    recordedAt: new Date().toISOString()
  };
  await writeAtomic(recordPath(state.id), record);
  return record;
}

export async function recordVerifiedWorktree(state: OrchestrationState): Promise<FingerprintRecord> {
  return writeVerifiedWorktreeFingerprint(state, await computeWorktreeFingerprint(state.root));
}

export async function readVerifiedWorktreeFingerprint(id: string): Promise<FingerprintRecord> {
  const record = JSON.parse(await fs.readFile(recordPath(id), 'utf8')) as FingerprintRecord;
  if (record.schemaVersion !== 1 || record.orchestrationId !== id) throw new Error('Verification fingerprint record is invalid');
  return record;
}

export async function assertVerifiedWorktreeUnchanged(state: OrchestrationState): Promise<FingerprintRecord> {
  const record = await readVerifiedWorktreeFingerprint(state.id);
  if (record.root !== state.root) throw new Error('Verification fingerprint record is invalid');
  const current = await computeWorktreeFingerprint(state.root);
  if (current !== record.fingerprint) {
    throw new Error('Worktree bytes or index changed after verification; run development_verify again before finalization');
  }
  return record;
}
''')

print('all internal Git execution migrated into the sandbox')
