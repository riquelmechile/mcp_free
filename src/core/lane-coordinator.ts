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
import { withOrchestrationLock } from './orchestration-lock.js';
import { canonicalJson, getReceipt, sha256, writeReceipt } from './receipts.js';

export type LaneWorkerStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
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
  cancelRequestedAt?: string;
  currentCommandIndex: number;
  totalCommands: number;
  results: CommandResult[];
  error?: string;
  workerInstanceId: string;
  evidenceSha256?: string;
  terminalReceiptId?: string;
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
  cancelled: string[];
  lanes: Array<{
    laneId: string;
    status: LaneWorkerStatus;
    attempt: number;
    currentCommandIndex: number;
    totalCommands: number;
    queuedAt: string;
    startedAt?: string;
    completedAt?: string;
    cancelRequestedAt?: string;
    error?: string;
    resultCount: number;
    evidenceSha256?: string;
    terminalReceiptId?: string;
  }>;
}

const coordinatorRoot = path.join(config.stateDir, 'orchestration-workers');
const orchestrationRoot = path.join(config.stateDir, 'orchestrations');
const activeWorkers = new Map<string, Promise<void>>();
const activeControllers = new Map<string, AbortController>();
const pendingWorkers: Array<{ orchestrationId: string; laneId: string }> = [];
const workerInstanceId = `worker_${process.pid}_${crypto.randomBytes(8).toString('hex')}`;
const maximumConcurrentWorkers = 3;
const terminalStatuses = new Set<LaneWorkerStatus>(['completed', 'failed', 'interrupted', 'cancelled']);

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

function refreshStatus(state: LaneCoordinatorState, configuredLaneCount: number): void {
  const statuses = state.lanes.map(lane => lane.status);
  if (statuses.some(status => status === 'queued' || status === 'running')) {
    state.status = 'running';
    return;
  }
  if (statuses.some(status => status === 'failed' || status === 'interrupted' || status === 'cancelled')) {
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

function evidencePayload(orchestrationId: string, lane: LaneWorkerRecord, terminalStatus: LaneWorkerStatus): Record<string, unknown> {
  return {
    schemaVersion: 1,
    orchestrationId,
    laneId: lane.laneId,
    attempt: lane.attempt,
    terminalStatus,
    commands: lane.commands,
    timeoutMs: lane.timeoutMs,
    queuedAt: lane.queuedAt,
    startedAt: lane.startedAt ?? null,
    currentCommandIndex: lane.currentCommandIndex,
    totalCommands: lane.totalCommands,
    results: lane.results,
    error: lane.error ?? null
  };
}

async function bindTerminalEvidence(
  orchestration: OrchestrationState,
  lane: LaneWorkerRecord,
  status: Exclude<LaneWorkerStatus, 'queued' | 'running'>,
  error?: string
): Promise<void> {
  if (error) lane.error = error;
  else delete lane.error;
  const payload = evidencePayload(orchestration.id, lane, status);
  const serialized = canonicalJson(payload);
  const evidenceSha256 = sha256(serialized);
  const receipt = await writeReceipt({
    action: 'development_lane_worker_terminal',
    riskTier: 0,
    success: status === 'completed',
    durationMs: lane.results.reduce((total, result) => total + result.durationMs, 0),
    target: orchestration.root,
    output: serialized,
    details: {
      orchestrationId: orchestration.id,
      laneId: lane.laneId,
      attempt: lane.attempt,
      terminalStatus: status,
      evidenceSha256,
      resultCount: lane.results.length
    }
  });
  lane.status = status;
  lane.completedAt = new Date().toISOString();
  lane.evidenceSha256 = evidenceSha256;
  lane.terminalReceiptId = receipt.id;
}

async function verifyTerminalEvidence(orchestrationId: string, lane: LaneWorkerRecord): Promise<void> {
  if (!terminalStatuses.has(lane.status)) return;
  if (!lane.evidenceSha256 || !lane.terminalReceiptId) {
    throw new Error(`Terminal lane ${lane.laneId} is missing evidence binding`);
  }
  const expected = sha256(canonicalJson(evidencePayload(orchestrationId, lane, lane.status)));
  if (expected !== lane.evidenceSha256) throw new Error(`Lane ${lane.laneId} evidence hash mismatch`);
  const receipt = await getReceipt(lane.terminalReceiptId);
  if (receipt.action !== 'development_lane_worker_terminal'
      || receipt.details.orchestrationId !== orchestrationId
      || receipt.details.laneId !== lane.laneId
      || receipt.details.evidenceSha256 !== lane.evidenceSha256
      || receipt.details.terminalStatus !== lane.status) {
    throw new Error(`Lane ${lane.laneId} terminal receipt does not match persisted evidence`);
  }
}

async function reconcileInterruptedUnlocked(state: LaneCoordinatorState, orchestration: OrchestrationState): Promise<boolean> {
  let changed = false;
  for (const lane of state.lanes) {
    if (lane.status !== 'queued' && lane.status !== 'running') continue;
    const key = workerKey(state.orchestrationId, lane.laneId);
    const ownedByThisProcess = lane.workerInstanceId === workerInstanceId;
    if (!activeWorkers.has(key) && !pendingContains(key) && !ownedByThisProcess) {
      await bindTerminalEvidence(
        orchestration,
        lane,
        'interrupted',
        'MCP service restarted or lost the local worker before completion; resume this lane explicitly.'
      );
      changed = true;
    }
  }
  if (changed) await saveCoordinator(state, orchestration.lanes.length);
  return changed;
}

async function loadOrCreateCoordinatorUnlocked(id: string): Promise<{ orchestration: OrchestrationState; coordinator: LaneCoordinatorState }> {
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
    await reconcileInterruptedUnlocked(coordinator, orchestration);
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

async function updateLane(orchestrationId: string, laneId: string, updater: (lane: LaneWorkerRecord) => void): Promise<void> {
  await withOrchestrationLock(orchestrationId, async () => {
    const { orchestration, coordinator } = await loadOrCreateCoordinatorUnlocked(orchestrationId);
    const lane = coordinator.lanes.find(candidate => candidate.laneId === laneId);
    if (!lane) throw new Error(`Unknown queued lane: ${laneId}`);
    updater(lane);
    await saveCoordinator(coordinator, orchestration.lanes.length);
  });
}

async function finishLane(
  orchestrationId: string,
  laneId: string,
  status: Exclude<LaneWorkerStatus, 'queued' | 'running'>,
  error?: string
): Promise<void> {
  await withOrchestrationLock(orchestrationId, async () => {
    const { orchestration, coordinator } = await loadOrCreateCoordinatorUnlocked(orchestrationId);
    const lane = coordinator.lanes.find(candidate => candidate.laneId === laneId);
    if (!lane) throw new Error(`Unknown queued lane: ${laneId}`);
    if (terminalStatuses.has(lane.status)) return;
    await bindTerminalEvidence(orchestration, lane, status, error);
    await saveCoordinator(coordinator, orchestration.lanes.length);
  });
}

async function executeLane(orchestrationId: string, laneId: string, controller: AbortController): Promise<void> {
  let record: LaneWorkerRecord | undefined;
  let root = '';
  await withOrchestrationLock(orchestrationId, async () => {
    const { orchestration, coordinator } = await loadOrCreateCoordinatorUnlocked(orchestrationId);
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
      if (controller.signal.aborted) {
        await finishLane(orchestrationId, laneId, 'cancelled', 'Lane cancelled before the next inspection command started.');
        return;
      }
      const result = await runCommand(record.commands[index]!, {
        cwd: root,
        timeoutMs: record.timeoutMs,
        maxTimeoutMs: config.developmentTimeoutMs,
        env: inspectionEnvironment,
        signal: controller.signal
      });
      await updateLane(orchestrationId, laneId, lane => {
        lane.results.push(result);
        lane.currentCommandIndex = index + 1;
      });
      if (result.cancelled || controller.signal.aborted) {
        await finishLane(orchestrationId, laneId, 'cancelled', `Inspection cancelled while running: ${result.argv.join(' ')}`);
        return;
      }
      if (result.exitCode !== 0 || result.timedOut) {
        await finishLane(
          orchestrationId,
          laneId,
          'failed',
          `Inspection command failed: ${result.argv.join(' ')} (exit ${result.exitCode}, timedOut=${result.timedOut})`
        );
        return;
      }
    }
    await finishLane(orchestrationId, laneId, 'completed');
  } catch (error) {
    await finishLane(orchestrationId, laneId, 'failed', error instanceof Error ? error.message : String(error));
  }
}

function pumpQueue(): void {
  while (activeWorkers.size < maximumConcurrentWorkers && pendingWorkers.length > 0) {
    const next = pendingWorkers.shift();
    if (!next) return;
    const key = workerKey(next.orchestrationId, next.laneId);
    if (activeWorkers.has(key)) continue;
    const controller = new AbortController();
    activeControllers.set(key, controller);
    const task = executeLane(next.orchestrationId, next.laneId, controller)
      .finally(() => {
        activeWorkers.delete(key);
        activeControllers.delete(key);
        pumpQueue();
      });
    activeWorkers.set(key, task);
  }
}

function queueLane(orchestrationId: string, laneId: string): void {
  const key = workerKey(orchestrationId, laneId);
  if (!activeWorkers.has(key) && !pendingContains(key)) pendingWorkers.push({ orchestrationId, laneId });
}

export async function enqueueParallelInspection(
  orchestrationId: string,
  requests: LaneInspectionRequest[],
  timeoutMs: number
): Promise<LaneCoordinatorState> {
  const coordinator = await withOrchestrationLock(orchestrationId, async () => {
    const loaded = await loadOrCreateCoordinatorUnlocked(orchestrationId);
    if (loaded.orchestration.status !== 'active') {
      throw new Error(`Parallel inspection requires active status; current status is ${loaded.orchestration.status}`);
    }
    if (requests.length < 1 || requests.length > 3) throw new Error('Between 1 and 3 lane requests are required');
    const unique = new Set(requests.map(request => request.laneId));
    if (unique.size !== requests.length) throw new Error('lane_id values must be unique within one enqueue call');

    for (const request of requests) {
      if (!loaded.orchestration.lanes.some(lane => lane.id === request.laneId)) throw new Error(`Unknown lane_id: ${request.laneId}`);
      if (request.commands.length < 1 || request.commands.length > 8) throw new Error('Each lane requires between 1 and 8 inspection commands');
      for (const argv of request.commands) {
        validateInspectionCommand(argv);
        await assertExistingArgumentsStayInProject(loaded.orchestration.root, argv);
      }
      const previous = loaded.coordinator.lanes.find(lane => lane.laneId === request.laneId);
      if (previous?.status === 'queued' || previous?.status === 'running') throw new Error(`Lane ${request.laneId} is already ${previous.status}`);
      if (previous?.status === 'completed') throw new Error(`Lane ${request.laneId} already completed; create a new orchestration to inspect it again`);
      const replacement: LaneWorkerRecord = {
        laneId: request.laneId,
        commands: request.commands,
        timeoutMs,
        status: 'queued',
        attempt: (previous?.attempt ?? 0) + 1,
        queuedAt: new Date().toISOString(),
        currentCommandIndex: 0,
        totalCommands: request.commands.length,
        results: [],
        workerInstanceId
      };
      if (previous) Object.assign(previous, replacement);
      else loaded.coordinator.lanes.push(replacement);
      if (previous) {
        delete previous.startedAt;
        delete previous.completedAt;
        delete previous.cancelRequestedAt;
        delete previous.error;
        delete previous.evidenceSha256;
        delete previous.terminalReceiptId;
      }
    }
    await saveCoordinator(loaded.coordinator, loaded.orchestration.lanes.length);
    return loaded.coordinator;
  });

  for (const request of requests) queueLane(orchestrationId, request.laneId);
  pumpQueue();
  return coordinator;
}

export async function cancelLaneWorkers(orchestrationId: string, laneIds?: string[]): Promise<LaneCoordinatorState> {
  const state = await withOrchestrationLock(orchestrationId, async () => {
    const { orchestration, coordinator } = await loadOrCreateCoordinatorUnlocked(orchestrationId);
    const targets = laneIds?.length ? new Set(laneIds) : new Set(coordinator.lanes.map(lane => lane.laneId));
    for (const laneId of targets) {
      const lane = coordinator.lanes.find(candidate => candidate.laneId === laneId);
      if (!lane) throw new Error(`Lane ${laneId} has not been queued`);
      if (lane.status === 'queued') {
        for (let index = pendingWorkers.length - 1; index >= 0; index -= 1) {
          if (workerKey(pendingWorkers[index]!.orchestrationId, pendingWorkers[index]!.laneId) === workerKey(orchestrationId, laneId)) {
            pendingWorkers.splice(index, 1);
          }
        }
        await bindTerminalEvidence(orchestration, lane, 'cancelled', 'Lane cancelled before execution.');
      } else if (lane.status === 'running') {
        lane.cancelRequestedAt = new Date().toISOString();
        activeControllers.get(workerKey(orchestrationId, laneId))?.abort();
      }
    }
    await saveCoordinator(coordinator, orchestration.lanes.length);
    return coordinator;
  });
  return state;
}

export async function resumeLaneWorkers(orchestrationId: string, laneIds: string[]): Promise<LaneCoordinatorState> {
  if (laneIds.length < 1 || laneIds.length > 3) throw new Error('Between 1 and 3 lane_ids are required');
  const coordinator = await withOrchestrationLock(orchestrationId, async () => {
    const { orchestration, coordinator: current } = await loadOrCreateCoordinatorUnlocked(orchestrationId);
    if (orchestration.status !== 'active') throw new Error(`Only active orchestrations can resume lanes; current status is ${orchestration.status}`);
    for (const laneId of new Set(laneIds)) {
      const lane = current.lanes.find(candidate => candidate.laneId === laneId);
      if (!lane) throw new Error(`Lane ${laneId} has not been queued`);
      if (lane.status !== 'failed' && lane.status !== 'interrupted' && lane.status !== 'cancelled') {
        throw new Error(`Lane ${laneId} is ${lane.status}; only failed, interrupted, or cancelled lanes can resume`);
      }
      lane.status = 'queued';
      lane.attempt += 1;
      lane.queuedAt = new Date().toISOString();
      lane.currentCommandIndex = 0;
      lane.results = [];
      lane.workerInstanceId = workerInstanceId;
      delete lane.startedAt;
      delete lane.completedAt;
      delete lane.cancelRequestedAt;
      delete lane.error;
      delete lane.evidenceSha256;
      delete lane.terminalReceiptId;
    }
    await saveCoordinator(current, orchestration.lanes.length);
    return current;
  });
  for (const laneId of new Set(laneIds)) queueLane(orchestrationId, laneId);
  pumpQueue();
  return coordinator;
}

export async function getCoordinatorState(orchestrationId: string): Promise<LaneCoordinatorState> {
  return withOrchestrationLock(orchestrationId, async () => {
    const { orchestration, coordinator } = await loadOrCreateCoordinatorUnlocked(orchestrationId);
    await reconcileInterruptedUnlocked(coordinator, orchestration);
    for (const lane of coordinator.lanes) await verifyTerminalEvidence(orchestrationId, lane);
    return structuredClone(coordinator);
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
    cancelled: byStatus('cancelled'),
    lanes: state.lanes.map(lane => ({
      laneId: lane.laneId,
      status: lane.status,
      attempt: lane.attempt,
      currentCommandIndex: lane.currentCommandIndex,
      totalCommands: lane.totalCommands,
      queuedAt: lane.queuedAt,
      ...(lane.startedAt ? { startedAt: lane.startedAt } : {}),
      ...(lane.completedAt ? { completedAt: lane.completedAt } : {}),
      ...(lane.cancelRequestedAt ? { cancelRequestedAt: lane.cancelRequestedAt } : {}),
      ...(lane.error ? { error: lane.error } : {}),
      resultCount: lane.results.length,
      ...(lane.evidenceSha256 ? { evidenceSha256: lane.evidenceSha256 } : {}),
      ...(lane.terminalReceiptId ? { terminalReceiptId: lane.terminalReceiptId } : {})
    }))
  };
}

export async function waitForCoordinatorChange(orchestrationId: string, afterRevision: number, waitMs: number): Promise<LaneCoordinatorState> {
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
  return withOrchestrationLock(orchestrationId, async () => {
    const orchestration = await loadOrchestration(orchestrationId);
    const coordinator = await readRawCoordinator(orchestrationId);
    if (!coordinator) throw new Error(`No lane coordinator exists for ${orchestrationId}`);
    const worker = coordinator.lanes.find(candidate => candidate.laneId === laneId);
    if (!worker) throw new Error(`Lane ${laneId} has not been queued`);
    if (worker.status !== 'completed') throw new Error(`Lane ${laneId} is ${worker.status}; completed evidence is required`);
    await verifyTerminalEvidence(orchestrationId, worker);
    const lane = orchestration.lanes.find(candidate => candidate.id === laneId);
    if (!lane) throw new Error(`Unknown lane_id: ${laneId}`);
    lane.inspection = {
      startedAt: worker.startedAt ?? worker.queuedAt,
      completedAt: worker.completedAt ?? coordinator.updatedAt,
      results: worker.results
    };
    lane.inspectionSha256 = worker.evidenceSha256;
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
