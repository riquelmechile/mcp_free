import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', args, { cwd });
}

async function waitUntilTerminal(
  coordinator: typeof import('../src/core/lane-coordinator.js'),
  orchestrationId: string
): Promise<import('../src/core/lane-coordinator.js').LaneCoordinatorState> {
  const deadline = Date.now() + 10_000;
  let revision = 0;
  while (Date.now() < deadline) {
    const state = await coordinator.waitForCoordinatorChange(orchestrationId, revision, 1_000);
    revision = state.revision;
    if (!state.lanes.some(lane => lane.status === 'queued' || lane.status === 'running')) return state;
  }
  throw new Error('Lane workers did not reach a terminal state');
}

test('dispatch returns immediately while three persistent workers finish independently', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-lanes-'));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-lane-state-'));
  process.env.MCP_MODE = 'workspace';
  process.env.MCP_ALLOWED_ROOTS = root;
  process.env.MCP_STATE_DIR = stateDir;

  try {
    await git(root, 'init', '-q');
    await git(root, 'config', 'user.email', 'test@example.com');
    await git(root, 'config', 'user.name', 'MCP Test');
    await fs.writeFile(path.join(root, 'tracked.txt'), 'baseline\n');
    await git(root, 'add', 'tracked.txt');
    await git(root, 'commit', '-qm', 'baseline');

    const development = await import(`../src/core/development.js?lanes=${Date.now()}`);
    const coordinator = await import(`../src/core/lane-coordinator.js?lanes=${Date.now()}`);
    const orchestration = await development.createOrchestration({
      cwd: root,
      objective: 'Inspect the repository through persistent asynchronous lanes',
      laneCount: 3,
      useSdd: false
    });

    const started = Date.now();
    const queued = await coordinator.enqueueParallelInspection(orchestration.id, [
      { laneId: 'lane-1', commands: [['git', 'status', '--short'], ['git', 'grep', 'baseline', '--', 'tracked.txt']] },
      { laneId: 'lane-2', commands: [['git', 'ls-files'], ['git', 'show', '--stat', '--oneline', 'HEAD']] },
      { laneId: 'lane-3', commands: [['git', 'diff', '--no-ext-diff'], ['git', 'rev-parse', '--show-toplevel']] }
    ], 30_000);

    assert.ok(Date.now() - started < 1_000, 'dispatch should not wait for all lane commands');
    assert.equal(queued.lanes.length, 3);
    assert.ok(queued.lanes.every(lane => lane.status === 'queued'));

    const terminal = await waitUntilTerminal(coordinator, orchestration.id);
    const summary = coordinator.summarizeCoordinator(terminal);
    assert.equal(summary.status, 'ready_for_synthesis');
    assert.deepEqual(summary.completed.sort(), ['lane-1', 'lane-2', 'lane-3']);
    assert.ok(terminal.lanes.every(lane => lane.results.length === 2));
    assert.ok(terminal.revision > queued.revision);

    const laneOne = await coordinator.requireLaneCompleted(orchestration.id, 'lane-1');
    assert.equal(laneOne.status, 'completed');
    assert.match(laneOne.results[1]!.stdout, /baseline/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('a worker left running by another service instance is marked interrupted', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-interrupt-'));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-interrupt-state-'));
  process.env.MCP_MODE = 'workspace';
  process.env.MCP_ALLOWED_ROOTS = root;
  process.env.MCP_STATE_DIR = stateDir;

  try {
    await git(root, 'init', '-q');
    await git(root, 'config', 'user.email', 'test@example.com');
    await git(root, 'config', 'user.name', 'MCP Test');
    await fs.writeFile(path.join(root, 'tracked.txt'), 'baseline\n');
    await git(root, 'add', 'tracked.txt');
    await git(root, 'commit', '-qm', 'baseline');

    const development = await import(`../src/core/development.js?interrupt=${Date.now()}`);
    const coordinator = await import(`../src/core/lane-coordinator.js?interrupt=${Date.now()}`);
    const orchestration = await development.createOrchestration({
      cwd: root,
      objective: 'Detect workers orphaned by a service restart',
      laneCount: 1,
      useSdd: false
    });

    const workersPath = path.join(stateDir, 'orchestration-workers', orchestration.id, 'workers.json');
    await fs.mkdir(path.dirname(workersPath), { recursive: true });
    await fs.writeFile(workersPath, `${JSON.stringify({
      schemaVersion: 1,
      orchestrationId: orchestration.id,
      root,
      revision: 4,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lanes: [{
        laneId: 'lane-1',
        commands: [['git', 'status', '--short']],
        timeoutMs: 30_000,
        status: 'running',
        attempt: 1,
        queuedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        currentCommandIndex: 0,
        totalCommands: 1,
        results: [],
        workerInstanceId: 'worker_from_previous_service_instance'
      }]
    }, null, 2)}\n`);

    const state = await coordinator.getCoordinatorState(orchestration.id);
    assert.equal(state.status, 'attention_required');
    assert.equal(state.lanes[0]?.status, 'interrupted');
    assert.match(state.lanes[0]?.error ?? '', /restarted|lost the local worker/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
