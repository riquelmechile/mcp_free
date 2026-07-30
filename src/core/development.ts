import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { CommandResult } from '../types.js';
import { runCommand } from './command.js';

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
  report?: LaneReport;
}

export interface VerificationRecord {
  completedAt: string;
  success: boolean;
  diffCheck: CommandResult;
  commands: string[][];
  results: CommandResult[];
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
  };
}

const orchestrationRoot = path.join(config.stateDir, 'orchestrations');
const orchestrationQueues = new Map<string, Promise<void>>();

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readText(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return null;
  }
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
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
}

async function withOrchestrationLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = orchestrationQueues.get(id) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  orchestrationQueues.set(id, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
    if (orchestrationQueues.get(id) === queued) orchestrationQueues.delete(id);
  }
}

export async function captureGitSnapshot(cwd: string): Promise<GitSnapshot> {
  const rootResult = await runCommand(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 10_000 });
  if (rootResult.exitCode !== 0) throw new Error(`Development orchestration requires a Git worktree: ${cleanOutput(rootResult)}`);
  const root = rootResult.stdout.trim();
  const [branch, head, status, diffStat] = await Promise.all([
    runCommand(['git', 'branch', '--show-current'], { cwd: root, timeoutMs: 10_000 }),
    runCommand(['git', 'rev-parse', '--verify', 'HEAD'], { cwd: root, timeoutMs: 10_000 }),
    runCommand(['git', 'status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, timeoutMs: 15_000 }),
    runCommand(['git', 'diff', '--stat'], { cwd: root, timeoutMs: 15_000 })
  ]);
  return {
    root,
    branch: branch.stdout.trim() || '(detached)',
    head: head.exitCode === 0 ? head.stdout.trim() : null,
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
      // Invalid package.json is reported by ChatGPT from project inspection.
    }
  }
  if (await exists(path.join(cwd, 'go.mod'))) commands.push(['go', 'test', './...']);
  if (await exists(path.join(cwd, 'Cargo.toml'))) commands.push(['cargo', 'test']);
  if (await exists(path.join(cwd, 'pyproject.toml')) || await exists(path.join(cwd, 'pytest.ini'))) {
    commands.push(['python', '-m', 'pytest']);
  }
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
  for (const relative of candidates) {
    if (await exists(path.join(git.root, relative))) contextFiles.push(relative);
  }
  const registry = contextFiles.includes('.atl/skill-registry.md') ? path.join(git.root, '.atl', 'skill-registry.md') : null;
  return {
    root: git.root,
    git,
    contextFiles,
    skillRegistryPath: registry,
    verificationCommands: await detectVerificationCommands(git.root),
    orchestration: {
      reasoningModel: 'ChatGPT',
      externalModelLaunchers: false,
      maximumParallelLanes: 3,
      laneRoles: LANE_ROLES
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

async function saveOrchestration(state: OrchestrationState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(orchestrationPath(state.id), state);
}

const INSPECTION_EXECUTABLES = new Set(['git', 'rg', 'fd', 'find', 'ls', 'cat', 'grep', 'head', 'tail', 'wc', 'jq', 'stat', 'sed']);
const READ_ONLY_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'grep', 'ls-files', 'rev-parse', 'branch', 'remote', 'tag', 'describe', 'blame']);
const SENSITIVE_ARG = /(^|\/)(\.env(?:\.|$)|\.ssh|\.gnupg|secrets?|credentials?)(\/|$)|\.(?:pem|key)$/i;

function assertSafeInspectionArg(argument: string): void {
  if (argument.startsWith('/') || argument.startsWith('~') || argument === '..' || argument.startsWith('../') || argument.includes('/../')) {
    throw new Error(`Inspection arguments must stay inside the project: ${argument}`);
  }
  if (SENSITIVE_ARG.test(argument)) throw new Error(`Inspection of credential-like paths is blocked: ${argument}`);
}

export function validateInspectionCommand(argv: string[]): void {
  if (argv.length === 0) throw new Error('Inspection command must not be empty');
  if (argv.length > 100) throw new Error('Inspection command is too long');
  const executable = path.basename(argv[0]!);
  if (!INSPECTION_EXECUTABLES.has(executable)) throw new Error(`Inspection executable is not allowed: ${executable}`);
  for (const argument of argv.slice(1)) assertSafeInspectionArg(argument);
  if (executable === 'git') {
    const subcommand = argv[1];
    if (!subcommand || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) throw new Error(`Git subcommand is not read-only: ${subcommand ?? '(missing)'}`);
  }
  if (executable === 'sed' && argv.some(argument => argument === '-i' || argument.startsWith('-i'))) throw new Error('sed -i is not allowed during inspection');
  if (executable === 'find' && argv.some(argument => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(argument))) {
    throw new Error('Mutating find actions are not allowed during inspection');
  }
}

export async function runParallelInspection(id: string, requests: LaneInspectionRequest[], timeoutMs: number): Promise<OrchestrationState> {
  return withOrchestrationLock(id, async () => {
    const state = await loadOrchestration(id);
    if (state.status !== 'active') throw new Error(`Parallel inspection requires active status; current status is ${state.status}`);
    if (requests.length < 1 || requests.length > 3) throw new Error('Between 1 and 3 lane requests are required');
    const unique = new Set(requests.map(request => request.laneId));
    if (unique.size !== requests.length) throw new Error('lane_id values must be unique within one parallel call');
    for (const request of requests) {
      const lane = state.lanes.find(candidate => candidate.id === request.laneId);
      if (!lane) throw new Error(`Unknown lane_id: ${request.laneId}`);
      if (request.commands.length < 1 || request.commands.length > 8) throw new Error('Each lane requires between 1 and 8 inspection commands');
      request.commands.forEach(validateInspectionCommand);
    }

    const completed = await Promise.all(requests.map(async request => {
      const startedAt = new Date().toISOString();
      const results: CommandResult[] = [];
      for (const argv of request.commands) {
        results.push(await runCommand(argv, { cwd: state.root, timeoutMs, maxTimeoutMs: config.developmentTimeoutMs }));
      }
      return { laneId: request.laneId, inspection: { startedAt, completedAt: new Date().toISOString(), results } satisfies LaneInspection };
    }));

    for (const item of completed) {
      const lane = state.lanes.find(candidate => candidate.id === item.laneId);
      if (!lane) throw new Error(`Lane disappeared during inspection: ${item.laneId}`);
      lane.inspection = item.inspection;
    }
    await saveOrchestration(state);
    return state;
  });
}

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
  const paths = new Set<string>();
  for (const line of patchText.split('\n')) {
    if (!line.startsWith('+++ ') && !line.startsWith('--- ')) continue;
    let value = line.slice(4).split('\t')[0]!.trim();
    if (value === '/dev/null') continue;
    if (value.startsWith('a/') || value.startsWith('b/')) value = value.slice(2);
    value = value.replace(/^"|"$/g, '');
    if (path.isAbsolute(value) || value === '..' || value.startsWith('../') || value.includes('/../')) {
      throw new Error(`Patch path escapes the project: ${value}`);
    }
    if (SENSITIVE_ARG.test(value)) throw new Error(`Patch targets a credential-like path: ${value}`);
    paths.add(value);
  }
  if (paths.size === 0) throw new Error('Patch does not contain any file paths');
  return [...paths].sort();
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
    const before = await captureGitSnapshot(state.root);
    if (before.head !== state.baseline.head || before.branch !== state.baseline.branch) throw new Error('Git branch or HEAD changed after orchestration start');
    if (before.status !== state.baseline.status) throw new Error('Worktree changed after orchestration start; inspect and start a new orchestration to avoid overwriting concurrent work');
    const patchPaths = extractPatchPaths(patchText);
    const dirtyPaths = new Set(dirtyPathsFromStatus(state.baseline.status));
    const overlap = patchPaths.filter(candidate => dirtyPaths.has(candidate));
    if (overlap.length > 0 && !allowTouchDirty) {
      throw new Error(`Patch touches pre-existing dirty paths: ${overlap.join(', ')}. Set allow_touch_dirty=true only after reviewing those exact files.`);
    }
    const check = await runCommand(['git', 'apply', '--check', '-'], { cwd: state.root, stdin: patchText, timeoutMs: 60_000 });
    if (check.exitCode !== 0 || check.timedOut) throw new Error(`git apply --check failed: ${cleanOutput(check)}`);
    const apply = await runCommand(['git', 'apply', '--whitespace=nowarn', '-'], { cwd: state.root, stdin: patchText, timeoutMs: 120_000 });
    if (apply.exitCode !== 0 || apply.timedOut) throw new Error(`git apply failed after a successful check: ${cleanOutput(apply)}`);
    const after = await captureGitSnapshot(state.root);
    state.status = 'applied';
    state.patchSha256 = sha256(patchText);
    state.patchPaths = patchPaths;
    state.appliedAt = new Date().toISOString();
    await saveOrchestration(state);
    return { state, check, apply, before, after };
  });
}

const VERIFICATION_EXECUTABLES = new Set(['git', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'tsx', 'tsc', 'python', 'python3', 'pytest', 'go', 'cargo', 'rustc', 'make', 'cmake', 'ninja']);

export function validateVerificationCommand(argv: string[]): void {
  if (argv.length === 0) throw new Error('Verification command must not be empty');
  if (argv.length > 100) throw new Error('Verification command is too long');
  const executable = path.basename(argv[0]!);
  if (!VERIFICATION_EXECUTABLES.has(executable)) throw new Error(`Verification executable is not allowed: ${executable}`);
  for (const argument of argv.slice(1)) assertSafeInspectionArg(argument);
  if (executable === 'git' && !(argv[1] === 'diff' && argv.includes('--check'))) {
    throw new Error('Only git diff --check is allowed as a custom verification command');
  }
}

export async function verifyOrchestration(id: string, commands: string[][], timeoutMs: number): Promise<OrchestrationState> {
  return withOrchestrationLock(id, async () => {
    const state = await loadOrchestration(id);
    if (state.status !== 'applied' && state.status !== 'verification_failed') {
      throw new Error(`Verification requires an applied patch; current status is ${state.status}`);
    }
    commands.forEach(validateVerificationCommand);
    const current = await captureGitSnapshot(state.root);
    if (current.head !== state.baseline.head || current.branch !== state.baseline.branch) throw new Error('Git branch or HEAD changed during orchestration');
    const diffCheck = await runCommand(['git', 'diff', '--check'], { cwd: state.root, timeoutMs: 60_000 });
    const results: CommandResult[] = [];
    for (const argv of commands) {
      results.push(await runCommand(argv, { cwd: state.root, timeoutMs, maxTimeoutMs: config.developmentTimeoutMs }));
    }
    const success = diffCheck.exitCode === 0 && !diffCheck.timedOut && results.every(result => result.exitCode === 0 && !result.timedOut);
    state.verification = {
      completedAt: new Date().toISOString(),
      success,
      diffCheck,
      commands,
      results
    };
    state.status = success ? 'verified' : 'verification_failed';
    await saveOrchestration(state);
    return state;
  });
}

export async function finalizeOrchestration(id: string): Promise<OrchestrationState> {
  return withOrchestrationLock(id, async () => {
    const state = await loadOrchestration(id);
    if (state.status !== 'verified' || state.verification?.success !== true) throw new Error('Orchestration can only be finalized after successful independent verification');
    const missingReports = state.lanes.filter(lane => !lane.report).map(lane => lane.id);
    if (missingReports.length > 0) throw new Error(`All logical lanes must report before finalization: ${missingReports.join(', ')}`);
    const current = await captureGitSnapshot(state.root);
    if (current.head !== state.baseline.head || current.branch !== state.baseline.branch) throw new Error('Git branch or HEAD changed before finalization');
    state.status = 'completed';
    state.completedAt = new Date().toISOString();
    await saveOrchestration(state);
    return state;
  });
}
