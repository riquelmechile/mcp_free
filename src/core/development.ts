import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { CommandResult } from '../types.js';
import {
  canonicalizeInspectionCommand,
  canonicalizeVerificationCommand,
  resolveTrustedExecutable,
  validateInspectionCommand as validateInspectionCommandPolicy,
  validateVerificationCommand as validateVerificationCommandPolicy
} from './command-policy.js';
import { withOrchestrationLock } from './orchestration-lock.js';
import { runInspectionCommand, runVerificationCommand } from './verification-sandbox.js';
import {
  assertVerifiedWorktreeUnchanged,
  computeWorktreeFingerprint,
  writeVerifiedWorktreeFingerprint
} from './worktree-fingerprint.js';
import {
  acquireWorktreeLease,
  assertWorktreeLease,
  releaseWorktreeLease
} from './worktree-lease.js';

export const LANE_ROLES = ['explore', 'design', 'review'] as const;
export type LaneRole = typeof LANE_ROLES[number];
export type OrchestrationStatus = 'active' | 'applied' | 'verified' | 'verification_failed' | 'completed' | 'aborted';

export interface GitSnapshot {
  root: string;
  branch: string;
  head: string | null;
  status: string;
  diffStat: string;
}

export interface LaneInspectionRequest {
  laneId: string;
  commands: string[][];
}

export interface LaneInspection {
  startedAt: string;
  completedAt: string;
  results: CommandResult[];
}

export interface LaneReport {
  recordedAt: string;
  summary: string;
  findings: string[];
  recommendations: string[];
  evidence: string[];
}

export interface OrchestrationLane {
  id: string;
  role: LaneRole;
  brief: string;
  inspection?: LaneInspection;
  inspectionSha256?: string;
  report?: LaneReport;
}

export interface VerificationRecord {
  completedAt: string;
  success: boolean;
  diffCheck: CommandResult;
  commands: string[][];
  results: CommandResult[];
  preFingerprint: string;
  postFingerprint: string;
  worktreeStable: boolean;
}

export interface OrchestrationState {
  schemaVersion: 1;
  id: string;
  root: string;
  objective: string;
  useSdd: boolean;
  status: OrchestrationStatus;
  createdAt: string;
  updatedAt: string;
  baseline: GitSnapshot;
  lanes: OrchestrationLane[];
  patchSha256?: string;
  patchPaths?: string[];
  appliedAt?: string;
  verification?: VerificationRecord;
  completedAt?: string;
  abortedAt?: string;
  abortReason?: string;
}

export interface ProjectDevelopmentStatus {
  root: string;
  git: GitSnapshot;
  contextFiles: string[];
  skillRegistryPath: string | null;
  verificationCommands: string[][];
  orchestration: {
    reasoningModel: 'ChatGPT';
    externalModelLaunchers: false;
    maximumParallelLanes: 3;
    laneRoles: typeof LANE_ROLES;
    arbitraryWorkspaceExecution: false;
    persistentWorktreeLease: true;
  };
}

const orchestrationRoot = path.join(config.stateDir, 'orchestrations');

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function exists(target: string): Promise<boolean> {
  try { await fs.access(target); return true; } catch { return false; }
}

async function readText(target: string): Promise<string | null> {
  try { return await fs.readFile(target, 'utf8'); } catch { return null; }
}

function cleanOutput(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function orchestrationPath(id: string): string {
  if (!/^orch_[a-f0-9]{24}$/.test(id)) throw new Error('Invalid orchestration_id');
  return path.join(orchestrationRoot, id, 'state.json');
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
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

async function saveOrchestration(state: OrchestrationState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(orchestrationPath(state.id), state);
}

async function findStandardGitRoot(cwd: string): Promise<string> {
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

export function defaultLaneSpecs(count: number): Array<Pick<OrchestrationLane, 'id' | 'role' | 'brief'>> {
  if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('lane_count must be between 1 and 3');
  const roles: LaneRole[] = count === 1 ? ['explore'] : count === 2 ? ['explore', 'review'] : ['explore', 'design', 'review'];
  const briefs: Record<LaneRole, string> = {
    explore: 'Map the relevant architecture, execution flow, dependencies, conventions, and exact files. Return evidence, not implementation guesses.',
    design: 'Develop the smallest complete implementation and test strategy. Identify interfaces, invariants, migration concerns, and an ordered patch plan.',
    review: 'Act as an adversarial reviewer. Search for regressions, security issues, race conditions, hidden coupling, missing tests, and conflicts with existing work.'
  };
  return roles.map((role, index) => ({ id: `lane-${index + 1}`, role, brief: briefs[role] }));
}

export async function detectVerificationCommands(cwd: string): Promise<string[][]> {
  const commands: string[][] = [];
  const packageText = await readText(path.join(cwd, 'package.json'));
  if (packageText) {
    try {
      const parsed = JSON.parse(packageText) as { scripts?: Record<string, string> };
      const scripts = parsed.scripts ?? {};
      const packageManager = await exists(path.join(cwd, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : await exists(path.join(cwd, 'yarn.lock')) ? 'yarn' : 'npm';
      const run = (script: string): string[] => [packageManager, 'run', script];
      if (scripts.check) commands.push(run('check'));
      else {
        if (scripts.typecheck) commands.push(run('typecheck'));
        if (scripts.test && !/^echo\s+["']Error: no test specified/.test(scripts.test)) commands.push(run('test'));
      }
      if (scripts.build) commands.push(run('build'));
    } catch {
      // Invalid package.json is surfaced by project inspection.
    }
  }
  if (await exists(path.join(cwd, 'go.mod'))) commands.push(['go', 'test', './...']);
  if (await exists(path.join(cwd, 'Cargo.toml'))) commands.push(['cargo', 'test']);
  if (await exists(path.join(cwd, 'pyproject.toml')) || await exists(path.join(cwd, 'pytest.ini'))) commands.push(['python', '-m', 'pytest']);
  const seen = new Set<string>();
  return commands.filter(command => {
    const key = JSON.stringify(command);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}

export async function inspectProjectDevelopment(cwd: string): Promise<ProjectDevelopmentStatus> {
  const git = await captureGitSnapshot(cwd);
  const candidates = [
    'AGENTS.md', 'CLAUDE.md', 'README.md', 'CONTRIBUTING.md',
    '.atl/skill-registry.md', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'
  ];
  const contextFiles: string[] = [];
  for (const relative of candidates) if (await exists(path.join(git.root, relative))) contextFiles.push(relative);
  return {
    root: git.root,
    git,
    contextFiles,
    skillRegistryPath: contextFiles.includes('.atl/skill-registry.md') ? path.join(git.root, '.atl', 'skill-registry.md') : null,
    verificationCommands: await detectVerificationCommands(git.root),
    orchestration: {
      reasoningModel: 'ChatGPT',
      externalModelLaunchers: false,
      maximumParallelLanes: 3,
      laneRoles: LANE_ROLES,
      arbitraryWorkspaceExecution: false,
      persistentWorktreeLease: true
    }
  };
}

export async function createOrchestration(input: { cwd: string; objective: string; laneCount: number; useSdd: boolean }): Promise<OrchestrationState> {
  const baseline = await captureGitSnapshot(input.cwd);
  const now = new Date().toISOString();
  const state: OrchestrationState = {
    schemaVersion: 1,
    id: `orch_${crypto.randomBytes(12).toString('hex')}`,
    root: baseline.root,
    objective: input.objective,
    useSdd: input.useSdd,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    baseline,
    lanes: defaultLaneSpecs(input.laneCount)
  };
  await writeJsonAtomic(orchestrationPath(state.id), state);
  return state;
}

export async function loadOrchestration(id: string): Promise<OrchestrationState> {
  const parsed = JSON.parse(await fs.readFile(orchestrationPath(id), 'utf8')) as OrchestrationState;
  if (parsed.schemaVersion !== 1 || parsed.id !== id || !Array.isArray(parsed.lanes)) throw new Error('Invalid orchestration state');
  return parsed;
}

export async function listOrchestrations(limit = 50): Promise<OrchestrationState[]> {
  try {
    const entries = await fs.readdir(orchestrationRoot, { withFileTypes: true });
    const states: OrchestrationState[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^orch_[a-f0-9]{24}$/.test(entry.name)) continue;
      try { states.push(await loadOrchestration(entry.name)); } catch { /* Invalid state is omitted from navigation and remains on disk. */ }
    }
    return states.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, Math.min(limit, 200));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function abortOrchestration(id: string, reason: string): Promise<OrchestrationState> {
  return withOrchestrationLock(id, async () => {
    const state = await loadOrchestration(id);
    if (state.status === 'completed') throw new Error('Completed orchestrations cannot be aborted');
    state.status = 'aborted';
    state.abortedAt = new Date().toISOString();
    state.abortReason = reason;
    await saveOrchestration(state);
    await releaseWorktreeLease(state.root, state.id);
    return state;
  });
}

export async function cleanupOrchestrations(olderThanMs: number): Promise<string[]> {
  const threshold = Date.now() - Math.max(0, olderThanMs);
  const removed: string[] = [];
  for (const state of await listOrchestrations(200)) {
    if (state.status !== 'completed' && state.status !== 'aborted') continue;
    if (Date.parse(state.updatedAt) > threshold) continue;
    await withOrchestrationLock(state.id, async () => {
      await releaseWorktreeLease(state.root, state.id);
      await fs.rm(path.join(orchestrationRoot, state.id), { recursive: true, force: true });
      await fs.rm(path.join(config.stateDir, 'orchestration-workers', state.id), { recursive: true, force: true });
      removed.push(state.id);
    });
  }
  return removed;
}

export const validateInspectionCommand = validateInspectionCommandPolicy;
export const validateVerificationCommand = validateVerificationCommandPolicy;

const SENSITIVE_ARG = /(^|\/)(\.env(?:\.|$)|\.ssh|\.gnupg|secrets?|credentials?)(\/|$)|\.(?:pem|key)$/i;

export async function recordLaneReport(id: string, input: {
  laneId: string;
  summary: string;
  findings: string[];
  recommendations: string[];
  evidence: string[];
}): Promise<OrchestrationState> {
  return withOrchestrationLock(id, async () => {
    const state = await loadOrchestration(id);
    if (state.status !== 'active') throw new Error(`Lane reports require active status; current status is ${state.status}`);
    const lane = state.lanes.find(candidate => candidate.id === input.laneId);
    if (!lane) throw new Error(`Unknown lane_id: ${input.laneId}`);
    if (!lane.inspection || !lane.inspectionSha256) throw new Error(`Lane ${input.laneId} has no evidence-bound inspection to synthesize`);
    lane.report = {
      recordedAt: new Date().toISOString(),
      summary: input.summary,
      findings: input.findings,
      recommendations: input.recommendations,
      evidence: input.evidence
    };
    await saveOrchestration(state);
    return state;
  });
}

export function dirtyPathsFromStatus(status: string): string[] {
  const paths = new Set<string>();
  for (const line of status.split('\n').filter(Boolean)) {
    const value = line.length >= 4 ? line.slice(3).trim() : line.trim();
    const parts = value.includes(' -> ') ? value.split(' -> ') : [value];
    for (const item of parts) paths.add(item.replace(/^"|"$/g, ''));
  }
  return [...paths].sort();
}

export function extractPatchPaths(patchText: string): string[] {
  if (/^GIT binary patch$/m.test(patchText)) throw new Error('Binary patches are not supported');
  if (/^(?:new|old) file mode (?:120000|160000)$/m.test(patchText) || /^Subproject commit /m.test(patchText)) {
    throw new Error('Symlink and submodule patches are not supported');
  }
  const paths = new Set<string>();
  for (const line of patchText.split('\n')) {
    if (!line.startsWith('+++ ') && !line.startsWith('--- ')) continue;
    let value = line.slice(4).split('\t')[0]!.trim();
    if (value === '/dev/null') continue;
    if (value.startsWith('a/') || value.startsWith('b/')) value = value.slice(2);
    value = value.replace(/^"|"$/g, '');
    if (path.isAbsolute(value) || value === '..' || value.startsWith('../') || value.includes('/../')) throw new Error(`Patch path escapes the project: ${value}`);
    if (value === '.git' || value.startsWith('.git/')) throw new Error('Patches may not modify Git metadata');
    if (SENSITIVE_ARG.test(value)) throw new Error(`Patch targets a credential-like path: ${value}`);
    paths.add(value);
  }
  if (paths.size === 0) throw new Error('Patch does not contain any supported file paths');
  return [...paths].sort();
}

async function assertPatchTargetsSafe(root: string, patchPaths: string[]): Promise<void> {
  const realRoot = await fs.realpath(root);
  for (const relative of patchPaths) {
    let cursor = realRoot;
    for (const component of relative.split('/').filter(Boolean)) {
      cursor = path.join(cursor, component);
      let metadata;
      try { metadata = await fs.lstat(cursor); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
      if (metadata.isSymbolicLink()) throw new Error(`Patch path crosses an existing symlink: ${relative}`);
      const resolved = await fs.realpath(cursor);
      if (!within(resolved, realRoot)) throw new Error(`Patch path resolves outside project: ${relative}`);
    }
  }
}

export async function applyOrchestrationPatch(id: string, patchText: string, allowTouchDirty: boolean): Promise<{
  state: OrchestrationState;
  check: CommandResult;
  apply: CommandResult;
  before: GitSnapshot;
  after: GitSnapshot;
}> {
  return withOrchestrationLock(id, async () => {
    const state = await loadOrchestration(id);
    if (state.status !== 'active') throw new Error(`Patch application requires active status; current status is ${state.status}`);
    const incompleteLanes = state.lanes.filter(lane => !lane.inspection || !lane.inspectionSha256 || !lane.report).map(lane => lane.id);
    if (incompleteLanes.length > 0) throw new Error(`ChatGPT must inspect and synthesize every configured lane before applying code: ${incompleteLanes.join(', ')}`);
    await acquireWorktreeLease(state.root, state.id);
    try {
      const before = await captureGitSnapshot(state.root);
      if (before.head !== state.baseline.head || before.branch !== state.baseline.branch) throw new Error('Git branch or HEAD changed after orchestration start');
      if (before.status !== state.baseline.status) throw new Error('Worktree changed after orchestration start; inspect and start a new orchestration to avoid overwriting concurrent work');
      const patchPaths = extractPatchPaths(patchText);
      await assertPatchTargetsSafe(state.root, patchPaths);
      const dirtyPaths = new Set(dirtyPathsFromStatus(state.baseline.status));
      const overlap = patchPaths.filter(candidate => dirtyPaths.has(candidate));
      if (overlap.length > 0 && !allowTouchDirty) {
        throw new Error(`Patch touches pre-existing dirty paths: ${overlap.join(', ')}. Set allow_touch_dirty=true only after reviewing those exact files.`);
      }
      const git = await resolveTrustedExecutable('git');
      const check = await runVerificationCommand(state.root, [git, 'apply', '--check', '--', '-'], {
        stdin: patchText,
        timeoutMs: 60_000
      });
      if (check.exitCode !== 0 || check.timedOut) throw new Error(`git apply --check failed: ${cleanOutput(check)}`);
      const apply = await runVerificationCommand(state.root, [git, 'apply', '--whitespace=nowarn', '--', '-'], {
        stdin: patchText,
        timeoutMs: 120_000
      });
      if (apply.exitCode !== 0 || apply.timedOut) throw new Error(`git apply failed after a successful check: ${cleanOutput(apply)}`);
      const after = await captureGitSnapshot(state.root);
      state.status = 'applied';
      state.patchSha256 = sha256(patchText);
      state.patchPaths = patchPaths;
      state.appliedAt = new Date().toISOString();
      delete state.verification;
      await saveOrchestration(state);
      return { state, check, apply, before, after };
    } catch (error) {
      await releaseWorktreeLease(state.root, state.id);
      throw error;
    }
  });
}

export async function verifyOrchestration(id: string, commands: string[][], timeoutMs: number): Promise<OrchestrationState> {
  return withOrchestrationLock(id, async () => {
    const state = await loadOrchestration(id);
    if (state.status !== 'applied' && state.status !== 'verification_failed') throw new Error(`Verification requires an applied patch; current status is ${state.status}`);
    await acquireWorktreeLease(state.root, state.id);
    try {
      commands.forEach(validateVerificationCommand);
      const canonicalCommands = await Promise.all(commands.map(command => canonicalizeVerificationCommand(command)));
      const current = await captureGitSnapshot(state.root);
      if (current.head !== state.baseline.head || current.branch !== state.baseline.branch) throw new Error('Git branch or HEAD changed during orchestration');

      const preFingerprint = await computeWorktreeFingerprint(state.root);
      const diffCommand = await canonicalizeInspectionCommand(['git', 'diff', '--check'], state.root);
      const diffCheck = await runInspectionCommand(state.root, diffCommand, { timeoutMs: 60_000 });
      const results: CommandResult[] = [];
      for (const command of canonicalCommands) {
        results.push(await runVerificationCommand(state.root, command, { timeoutMs, maxTimeoutMs: config.developmentTimeoutMs }));
      }
      const postFingerprint = await computeWorktreeFingerprint(state.root);
      const worktreeStable = preFingerprint === postFingerprint;
      const success = worktreeStable
        && diffCheck.exitCode === 0
        && !diffCheck.timedOut
        && results.every(result => result.exitCode === 0 && !result.timedOut && !result.cancelled);
      state.verification = {
        completedAt: new Date().toISOString(), success, diffCheck, commands, results,
        preFingerprint, postFingerprint, worktreeStable
      };
      state.status = success ? 'verified' : 'verification_failed';
      await saveOrchestration(state);
      if (success) await writeVerifiedWorktreeFingerprint(state, postFingerprint);
      else await releaseWorktreeLease(state.root, state.id);
      return state;
    } catch (error) {
      await releaseWorktreeLease(state.root, state.id);
      throw error;
    }
  });
}

export async function finalizeOrchestration(id: string): Promise<OrchestrationState> {
  return withOrchestrationLock(id, async () => {
    const state = await loadOrchestration(id);
    if (state.status !== 'verified' || state.verification?.success !== true) throw new Error('Orchestration can only be finalized after successful independent verification');
    const incompleteLanes = state.lanes.filter(lane => !lane.inspection || !lane.inspectionSha256 || !lane.report).map(lane => lane.id);
    if (incompleteLanes.length > 0) throw new Error(`All logical lanes must be inspected and reported before finalization: ${incompleteLanes.join(', ')}`);
    await assertWorktreeLease(state.root, state.id);
    await assertVerifiedWorktreeUnchanged(state);
    const current = await captureGitSnapshot(state.root);
    if (current.head !== state.baseline.head || current.branch !== state.baseline.branch) throw new Error('Git branch or HEAD changed before finalization');
    state.status = 'completed';
    state.completedAt = new Date().toISOString();
    await saveOrchestration(state);
    await releaseWorktreeLease(state.root, state.id);
    return state;
  });
}
