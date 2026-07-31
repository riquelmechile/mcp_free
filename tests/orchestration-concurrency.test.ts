import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
type OrchestrationLane = import('../src/core/development.js').OrchestrationLane;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', args, { cwd });
}

async function waitForTerminal(
  coordinator: typeof import('../src/core/lane-coordinator.js'),
  id: string
): Promise<void> {
  let revision = 0;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await coordinator.waitForCoordinatorChange(id, revision, 1_000);
    revision = state.revision;
    if (!state.lanes.some(lane => lane.status === 'queued' || lane.status === 'running')) return;
  }
  throw new Error('lanes did not terminate');
}

test('shared orchestration lock preserves simultaneous materialization and reports', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-concurrent-root-'));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-concurrent-state-'));
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

    const development = await import(`../src/core/development.js?concurrency=${Date.now()}`);
    const coordinator = await import(`../src/core/lane-coordinator.js?concurrency=${Date.now()}`);
    const orchestration = await development.createOrchestration({
      cwd: root,
      objective: 'Preserve concurrent lane state updates',
      laneCount: 2,
      useSdd: false
    });

    await coordinator.enqueueParallelInspection(orchestration.id, [
      { laneId: 'lane-1', commands: [['git', 'status', '--short']] },
      { laneId: 'lane-2', commands: [['git', 'grep', 'baseline', '--', 'tracked.txt']] }
    ], 30_000);
    await waitForTerminal(coordinator, orchestration.id);

    await Promise.all([
      coordinator.materializeLaneInspection(orchestration.id, 'lane-1'),
      coordinator.materializeLaneInspection(orchestration.id, 'lane-2')
    ]);
    await Promise.all([
      development.recordLaneReport(orchestration.id, {
        laneId: 'lane-1',
        summary: 'Architecture inspection completed safely.',
        findings: ['worktree is available'],
        recommendations: ['keep the change bounded'],
        evidence: ['git status --short']
      }),
      development.recordLaneReport(orchestration.id, {
        laneId: 'lane-2',
        summary: 'Adversarial inspection completed safely.',
        findings: ['baseline is present'],
        recommendations: ['verify exact bytes'],
        evidence: ['git grep baseline -- tracked.txt']
      })
    ]);

    const finalState = await development.loadOrchestration(orchestration.id);
    assert.equal(finalState.lanes.filter((lane: OrchestrationLane) => lane.inspection && lane.inspectionSha256).length, 2);
    assert.equal(finalState.lanes.filter((lane: OrchestrationLane) => lane.report).length, 2);
    assert.match(finalState.lanes[0]?.report?.summary ?? '', /Architecture/);
    assert.match(finalState.lanes[1]?.report?.summary ?? '', /Adversarial/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
