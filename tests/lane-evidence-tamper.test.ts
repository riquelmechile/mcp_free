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

async function waitForTerminal(
  coordinator: typeof import('../src/core/lane-coordinator.js'),
  id: string
): Promise<import('../src/core/lane-coordinator.js').LaneCoordinatorState> {
  let revision = 0;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await coordinator.waitForCoordinatorChange(id, revision, 1_000);
    revision = state.revision;
    if (!state.lanes.some(lane => lane.status === 'queued' || lane.status === 'running')) return state;
  }
  throw new Error('lane did not terminate');
}

test('terminal lane evidence cannot be changed without invalidating its receipt binding', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-tamper-root-'));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-free-tamper-state-'));
  process.env.MCP_MODE = 'workspace';
  process.env.MCP_ALLOWED_ROOTS = root;
  process.env.MCP_STATE_DIR = stateDir;

  try {
    await git(root, 'init', '-q');
    await git(root, 'config', 'user.email', 'test@example.com');
    await git(root, 'config', 'user.name', 'MCP Test');
    await fs.writeFile(path.join(root, 'tracked.txt'), 'trusted\n');
    await git(root, 'add', 'tracked.txt');
    await git(root, 'commit', '-qm', 'baseline');

    const development = await import(`../src/core/development.js?tamper=${Date.now()}`);
    const coordinator = await import(`../src/core/lane-coordinator.js?tamper=${Date.now()}`);
    const orchestration = await development.createOrchestration({
      cwd: root,
      objective: 'Prove terminal lane outputs are bound to receipts',
      laneCount: 1,
      useSdd: false
    });

    await coordinator.enqueueParallelInspection(orchestration.id, [{
      laneId: 'lane-1',
      commands: [['git', 'grep', 'trusted', '--', 'tracked.txt']]
    }], 30_000);
    const terminal = await waitForTerminal(coordinator, orchestration.id);
    assert.equal(terminal.lanes[0]?.status, 'completed');
    assert.match(terminal.lanes[0]?.terminalReceiptId ?? '', /^rcpt_/);

    const workersPath = path.join(stateDir, 'orchestration-workers', orchestration.id, 'workers.json');
    const persisted = JSON.parse(await fs.readFile(workersPath, 'utf8')) as {
      lanes: Array<{ results: Array<{ stdout: string }> }>;
    };
    persisted.lanes[0]!.results[0]!.stdout = 'forged output\n';
    await fs.writeFile(workersPath, `${JSON.stringify(persisted, null, 2)}\n`);

    await assert.rejects(coordinator.getCoordinatorState(orchestration.id), /evidence hash mismatch|terminal receipt/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
