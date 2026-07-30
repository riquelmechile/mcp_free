import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { CommandResult } from '../types.js';
import {
  loadOrchestration,
  validateInspectionCommand,
  type LaneInspectionRequest,
  type OrchestrationState
} from './development.js';
import { runCommand } from './command.js';

export type LaneWorkerStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
export type CoordinatorStatus = 'idle' | 'running' | 'ready_for_synthesis' | 'attention_required';

export interface LaneWorkerRecord {
  laneId: string;
  commands: string[][];
  timeoutMs: number;
  status: LaneWorkerStatus;
  attempt: number;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  currentCommandIndex: number;
  totalCommands: number;
  results: CommandResult[];
  error?: string;
  workerInstanceId: string;
}

export interface LaneCoordinatorState {
  schemaVersion: 1;
  orchestrationId: string;
  root: string;
  revision: number;
  status: CoordinatorStatus;
  createdAt: string;
  updatedAt: string;
  lanes: LaneWorkerRecord[];
}

export interface LaneCoordinatorSummary {
  orchestrationId: string;
  root: string;
  revision: number;
  status: CoordinatorStatus;
  updatedAt: string;
  activeWorkerCount: number;
  queued: string[];
  running: string[];
  completed: string[];
  failed: string[];
  interrupted: string[];
  lanes: Array<{
    laneId: string;
    status: LaneWorkerStatus;
    attempt: number;
    currentCommandIndex: number;
    totalCommands: number;
    queuedAt: string;
    startedAt?: string;
    completedAt?: string;
    error?: string;
    resultCount: number;
  }>;
}

const coordinatorRoot = path.join(config.stateDir, 'orchestration-workers');
const orchestrationRoot = path.join(config.stateDir, 'orchestrations');
const coordinatorLocks = new Map<string, Promise<void>>();
const activeWorkers = new Map<string, Promise<void>>();
const pendingWorkers: Array<{ orchestrationId: string; laneId: string }> = [];
const workerInstanceId = `worker_${process.pid}_${crypto.randomBytes(8).toString('hex')}`;
const maximumConcurrentWorkers = 3;

function workerKey(orchestrationId: string, laneId: string): string {
  return `${orchestrationId}:${laneId}`;
}

function validateOrchestrationId(id: string): void {
  if (!/^orch_[a-f0-9]{24}$/.test(id)) throw new Error('Invalid orchestration_id');
}

function coordinatorPath(id: string): string {
  validateOrchestrationId(id);
  return path.join(coordinatorRoot, id, 'workers.json');
}

function orchestrationStatePath(id: string): string {
  validateOrchestrationId(id);
  return path.join(orchestrationRoot, id, 'state.json');
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
}

async function withCoordinatorLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = coordinatorLocks.get(id) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  coordinatorLocks.set(id, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
    if (coordinatorLocks.get(id) === queued) coordinatorLocks.delete(id);
  }
}

function refreshStatus(state: LaneCoordinatorState, configuredLaneCount: number): void {
  const statuses = state.lanes.map(lane => lane.status);
  if (statuses.some(status => status === 'queued' || status === 'running')) {
    state.status = 'running';
    return;
  }
  if (statuses.some(status => status === 'failed' || status === 'interrupted')) {
    state.status = 'attention_required';
    return;
  }
  state.status = state.lanes.length === configuredLaneCount && statuses.every(status => status === 'completed')
    ? 'ready_for_synthesis'
    : 'idle';
}

async function readRawCoordinator(id: string): Promise<LaneCoordinatorState | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(coordinatorPath(id), 'utf8')) as LaneCoordinatorState;
    if (parsed.schemaVersion !== 1 || parsed.orchestrationId !== id || !Array.isArray(parsed.lanes)) {
      throw new Error('Invalid lane coordinator state');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function saveCoordinator(state: LaneCoordinatorState, configuredLaneCount: number): Promise<void> {
  refreshStatus(state, configuredLaneCount);
  state.revision += 1;
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(coordinatorPath(state.orchestrationId), state);
}

function pendingContains(key: string): boolean {
  return pendingWorkers.some(item => workerKey(item.orchestrationId, item.laneId) === key);
}

async function reconcileInterrupted(state: LaneCoordinatorState, orchestration: OrchestrationState): Promise<boolean> {
  let changed = false;
  for (const lane of state.lanes) {
    if (lane.status !== 'queued' && lane.status !== 'running') continue;
    const key = workerKey(state.orchestrationId, lane.laneId);
    const ownedByThisProcess = lane.workerInstanceId === workerInstanceId;
    if (!activeWorkers.has(key) && !pendingContains(key) && !ownedByThisProcess) {
      lane.status = 'interrupted';
      lane.completedAt = new Date().toISOString();
      lane.error = 'MCP service restarted or lost the local worker before completion; requeue this lane.';
      changed = true;
    }
  }
  if (changed) await saveCoordinator(state, orchestration.lanes.length);
  return changed;
}

async function loadOrCreateCoordinator(id: string): Promise<{ orchestration: OrchestrationState; coordinator: LaneCoordinatorState }> {
  const orchestration = await loadOrchestration(id);
  let coordinator = await readRawCoordinator(id);
  if (!coordinator) {
    const now = new Date().toISOString();
    coordinator = {
      schemaVersion: 1,
      orchestrationId: id,
      root: orchestration.root,
      revision: 0,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      lanes: []
    };
    await saveCoordinator(coordinator, orchestration.lanes.length);
  } else {
    await reconcileInterrupted(coordinator, orchestration);
  }
  return { orchestration, coordinator };
}

async function assertExistingArgumentsStayInProject(root: string, argv: string[]): Promise<void> {
  const realRoot = await fs.realpath(root);
  for (const argument of argv.slice(1)) {
    if (argument === '-' || argument.startsWith('-')) continue;
    const candidate = path.resolve(realRoot, argument);
    if (!within(candidate, realRoot)) throw new Error(`Argument resolves outside project: ${argument}`);
    let metadata;
    try {
      metadata = await fs.lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (metadata.isSymbolicLink()) throw new Error(`Explicit symlink arguments are blocked during inspection: ${argument}`);
    const resolved = await fs.realpath(candidate);
    if (!within(resolved, realRoot)) throw new Error(`Argument resolves outside project through filesystem links: ${argument}`);
  }
}

const inspectionEnvironment: Record<string, string> = {
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_OPTIONAL_LOCKS: '0',
  RIPGREP_CONFIG_PATH: '/dev/null',
  NO_COLOR: '1',
  LANG: 'C'
};

async function updateLane(
  orchestrationId: string,
  laneId: string,
  updater: (lane: LaneWorkerRecord) => void
): Promise<LaneCoordinatorState> {
  return withCoordinatorLock(orchestrationId, async () => {
    const { orchestration, coordinator } = await loadOrCreateCoordinator(orchestrationId);
    const lane = coordinator.lanes.find(candidate => candidate.laneId === laneId);
    if (!lane) throw new Error(`Unknown queued lane: ${laneId}`);
    updater(lane);
    await saveCoordinator(coordinator, orchestration.lanes.length);
    return coordinator;
  });
}

async function executeLane(orchestrationId: string, laneId: string): Promise<void> {
  let record: LaneWorkerRecord | undefined;
  let root = '';
  await withCoordinatorLock(orchestrationId, async () => {
    const { orchestration, coordinator } = await loadOrCreateCoordinator(orchestrationId);
    root = orchestration.root;
    record = coordinator.lanes.find(candidate => candidate.laneId === laneId);
    if (!record || record.status !== 'queued') return;
    record.status = 'running';
    record.startedAt = new Date().toISOString();
    delete record.error;
    await saveCoordinator(coordinator, orchestration.lanes.length);
  });
  if (!record || record.status !== 'running') return;

  try {
    for (let index = record.currentCommandIndex; index < record.commands.length; index += 1) {
      const result = await runCommand(record.commands[index]!, {
        cwd: root,
        timeoutMs: record.timeoutMs,
        maxTimeoutMs: config.developmentTimeoutMs,
        env: inspectionEnvironment
      });
      await updateLane(orchestrationId, laneId, lane => {
        lane.results.push(result);
        lane.currentCommandIndex = index + 1;
      });
    }
    await updateLane(orchestrationId, laneId, lane => {
      const successful = lane.results.every(result => result.exitCode === 0 && !result.timedOut);
      lane.status = successful ? 'completed' : 'failed';
      lane.completedAt = new Date().toISOString();
      if (!successful) {
        const failed = lane.results.find(result => result.exitCode !== 0 || result.timedOut);
        lane.error = failed
          ? `Inspection command failed: ${failed.argv.join(' ')} (exit ${failed.exitCode}, timedOut=${failed.timedOut})`
          : 'Inspection lane failed without a command result';
      }
    });
  } catch (error) {
    await updateLane(orchestrationId, laneId, lane => {
      lane.status = 'failed';
      lane.completedAt = new Date().toISOString();
      lane.error = error instanceof Error ? error.message : String(error);
    });
  }
}

function pumpQueue(): void {
  while (activeWorkers.size < maximumConcurrentWorkers && pendingWorkers.length > 0) {
    const next = pendingWorkers.shift();
    if (!next) return;
    const key = workerKey(next.orchestrationId, next.laneId);
    if (activeWorkers.has(key)) continue;
    const task = executeLane(next.orchestrationId, next.laneId)
      .finally(() => {
        activeWorkers.delete(key);
        pumpQueue();
      });
    activeWorkers.set(key, task);
  }
}

export async function enqueueParallelInspection(
  orchestrationId: string,
  requests: LaneInspectionRequest[],
  timeoutMs: number
): Promise<LaneCoordinatorState> {
  const { orchestration } = await loadOrCreateCoordinator(orchestrationId);
  if (orchestration.status !== 'active') throw new Error(`Parallel inspection requires active status; current status is ${orchestration.status}`);
  if (requests.length < 1 || requests.length > 3) throw new Error('Between 1 and 3 lane requests are required');
  const unique = new Set(requests.map(request => request.laneId));
  if (unique.size !== requests.length) throw new Error('lane_id values must be unique within one enqueue call');

  for (const request of requests) {
    if (!orchestration.lanes.some(lane => lane.id === request.laneId)) throw new Error(`Unknown lane_id: ${request.laneId}`);
    if (request.commands.length < 1 || request.commands.length > 8) throw new Error('Each lane requires between 1 and 8 inspection commands');
    for (const argv of request.commands) {
      validateInspectionCommand(argv);
      await assertExistingArgumentsStayInProject(orchestration.root, argv);
    }
  }

  const coordinator = await withCoordinatorLock(orchestrationId, async () => {
    const loaded = await loadOrCreateCoordinator(orchestrationId);
    for (const request of requests) {
      const previous = loaded.coordinator.lanes.find(lane => lane.laneId === request.laneId);
      if (previous?.status === 'queued' || previous?.status === 'running') {
        throw new Error(`Lane ${request.laneId} is already ${previous.status}`);
      }
      if (previous?.status === 'completed') throw new Error(`Lane ${request.laneId} already completed; create a new orchestration to inspect it again`);
      const attempt = (previous?.attempt ?? 0) + 1;
      const replacement: LaneWorkerRecord = {
        laneId: request.laneId,
        commands: request.commands,
        timeoutMs,
        status: 'queued',
        attempt,
        queuedAt: new Date().toISOString(),
        currentCommandIndex: 0,
        totalCommands: request.commands.length,
        results: [],
        workerInstanceId
      };
      if (previous) Object.assign(previous, replacement);
      else loaded.coordinator.lanes.push(replacement);
    }
    await saveCoordinator(loaded.coordinator, loaded.orchestration.lanes.length);
    return loaded.coordinator;
  });

  for (const request of requests) {
    const key = workerKey(orchestrationId, request.laneId);
    if (!activeWorkers.has(key) && !pendingContains(key)) pendingWorkers.push({ orchestrationId, laneId: request.laneId });
  }
  pumpQueue();
  return coordinator;
}

export async function getCoordinatorState(orchestrationId: string): Promise<LaneCoordinatorState> {
  return withCoordinatorLock(orchestrationId, async () => {
    const { orchestration, coordinator } = await loadOrCreateCoordinator(orchestrationId);
    await reconcileInterrupted(coordinator, orchestration);
    return coordinator;
  });
}

export function summarizeCoordinator(state: LaneCoordinatorState): LaneCoordinatorSummary {
  const byStatus = (status: LaneWorkerStatus): string[] => state.lanes.filter(lane => lane.status === status).map(lane => lane.laneId);
  return {
    orchestrationId: state.orchestrationId,
    root: state.root,
    revision: state.revision,
    status: state.status,
    updatedAt: state.updatedAt,
    activeWorkerCount: state.lanes.filter(lane => activeWorkers.has(workerKey(state.orchestrationId, lane.laneId))).length,
    queued: byStatus('queued'),
    running: byStatus('running'),
    completed: byStatus('completed'),
    failed: byStatus('failed'),
    interrupted: byStatus('interrupted'),
    lanes: state.lanes.map(lane => ({
      laneId: lane.laneId,
      status: lane.status,
      attempt: lane.attempt,
      currentCommandIndex: lane.currentCommandIndex,
      totalCommands: lane.totalCommands,
      queuedAt: lane.queuedAt,
      ...(lane.startedAt ? { startedAt: lane.startedAt } : {}),
      ...(lane.completedAt ? { completedAt: lane.completedAt } : {}),
      ...(lane.error ? { error: lane.error } : {}),
      resultCount: lane.results.length
    }))
  };
}

export async function waitForCoordinatorChange(
  orchestrationId: string,
  afterRevision: number,
  waitMs: number
): Promise<LaneCoordinatorState> {
  const deadline = Date.now() + Math.max(0, Math.min(waitMs, 30_000));
  while (true) {
    const state = await getCoordinatorState(orchestrationId);
    const active = state.lanes.some(lane => lane.status === 'queued' || lane.status === 'running');
    if (state.revision > afterRevision || !active || Date.now() >= deadline) return state;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

export async function getLaneWorker(orchestrationId: string, laneId: string): Promise<LaneWorkerRecord> {
  const state = await getCoordinatorState(orchestrationId);
  const lane = state.lanes.find(candidate => candidate.laneId === laneId);
  if (!lane) throw new Error(`Lane ${laneId} has not been queued`);
  return lane;
}

export async function requireLaneCompleted(orchestrationId: string, laneId: string): Promise<LaneWorkerRecord> {
  const lane = await getLaneWorker(orchestrationId, laneId);
  if (lane.status !== 'completed') throw new Error(`Lane ${laneId} is ${lane.status}; wait for completion before synthesizing its report`);
  return lane;
}

export async function materializeLaneInspection(orchestrationId: string, laneId: string): Promise<OrchestrationState> {
  return withCoordinatorLock(orchestrationId, async () => {
    const orchestration = await loadOrchestration(orchestrationId);
    const coordinator = await readRawCoordinator(orchestrationId);
    if (!coordinator) throw new Error(`No lane coordinator exists for ${orchestrationId}`);
    const worker = coordinator.lanes.find(candidate => candidate.laneId === laneId);
    if (!worker) throw new Error(`Lane ${laneId} has not been queued`);
    if (worker.status !== 'completed') throw new Error(`Lane ${laneId} is ${worker.status}; completed evidence is required`);
    const lane = orchestration.lanes.find(candidate => candidate.id === laneId);
    if (!lane) throw new Error(`Unknown lane_id: ${laneId}`);
    lane.inspection = {
      startedAt: worker.startedAt ?? worker.queuedAt,
      completedAt: worker.completedAt ?? coordinator.updatedAt,
      results: worker.results
    };
    await writeJsonAtomic(orchestrationStatePath(orchestrationId), orchestration);
    return orchestration;
  });
}

export async function assertAllLanesCompleted(orchestrationId: string): Promise<LaneCoordinatorState> {
  const orchestration = await loadOrchestration(orchestrationId);
  const coordinator = await getCoordinatorState(orchestrationId);
  const incomplete = orchestration.lanes.filter(lane => {
    const worker = coordinator.lanes.find(candidate => candidate.laneId === lane.id);
    return worker?.status !== 'completed';
  }).map(lane => lane.id);
  if (incomplete.length > 0) throw new Error(`All lane workers must complete before patch synthesis: ${incomplete.join(', ')}`);
  return coordinator;
}
