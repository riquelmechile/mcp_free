import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { commandExists, runCommand } from './command.js';
import type { CommandResult } from '../types.js';

export const DEVELOPMENT_AGENTS = ['opencode', 'codex', 'claude', 'gemini'] as const;
export type DevelopmentAgent = typeof DEVELOPMENT_AGENTS[number];
export type DevelopmentAgentPreference = DevelopmentAgent | 'auto';

export interface DevelopmentAgentState {
  id: DevelopmentAgent;
  executable: string;
  available: boolean;
  gentleConfigured: boolean;
  configurationEvidence: string[];
}

export interface GitSnapshot {
  root: string;
  branch: string;
  head: string | null;
  status: string;
  diffStat: string;
}

export interface GentleProjectState {
  cwd: string;
  git: GitSnapshot;
  gentleAi: {
    installed: boolean;
    version: string | null;
    doctorExitCode: number | null;
    doctorOutput: string | null;
    reviewModeExitCode: number | null;
    reviewModeOutput: string | null;
    skillRegistryPresent: boolean;
  };
  agents: DevelopmentAgentState[];
  recommendedAgent: DevelopmentAgent | null;
}

export interface DevelopmentPromptOptions {
  task: string;
  cwd: string;
  useSdd: boolean;
  baselineStatus: string;
  verificationCommands: string[][];
}

const AGENT_EXECUTABLE: Record<DevelopmentAgent, string> = {
  opencode: 'opencode',
  codex: 'codex',
  claude: 'claude',
  gemini: 'gemini'
};

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

async function detectAgentState(id: DevelopmentAgent, cwd: string): Promise<DevelopmentAgentState> {
  const executable = AGENT_EXECUTABLE[id];
  const available = await commandExists(executable);
  const evidence: string[] = [];

  if (id === 'opencode') {
    const candidates = [
      path.join(cwd, 'opencode.json'),
      path.join(cwd, '.opencode', 'opencode.json'),
      path.join(config.home, '.config', 'opencode', 'opencode.json')
    ];
    for (const candidate of candidates) {
      const text = await readText(candidate);
      if (text?.includes('gentle-orchestrator')) evidence.push(candidate);
    }
  } else if (id === 'codex') {
    for (const candidate of [path.join(cwd, 'AGENTS.md'), path.join(config.home, '.codex', 'AGENTS.md')]) {
      if (await exists(candidate)) evidence.push(candidate);
    }
  } else if (id === 'claude') {
    for (const candidate of [path.join(cwd, 'CLAUDE.md'), path.join(config.home, '.claude', 'CLAUDE.md'), path.join(config.home, '.claude', 'skills')]) {
      if (await exists(candidate)) evidence.push(candidate);
    }
  } else {
    for (const candidate of [path.join(config.home, '.gemini', 'agents'), path.join(config.home, '.gemini', 'GEMINI.md')]) {
      if (await exists(candidate)) evidence.push(candidate);
    }
  }

  return { id, executable, available, gentleConfigured: evidence.length > 0, configurationEvidence: evidence };
}

export function chooseDevelopmentAgent(states: DevelopmentAgentState[], preference: DevelopmentAgentPreference): DevelopmentAgentState {
  if (preference !== 'auto') {
    const selected = states.find(state => state.id === preference);
    if (!selected?.available) throw new Error(`Requested development agent is not installed: ${preference}`);
    if (!selected.gentleConfigured) {
      const gentleId = preference === 'claude' ? 'claude-code' : preference === 'gemini' ? 'gemini-cli' : preference;
      throw new Error(`Agent ${preference} is installed but no Gentle AI configuration was detected. Run gentle-ai sync --agent ${gentleId}.`);
    }
    return selected;
  }

  const configured = states.find(state => state.available && state.gentleConfigured);
  if (configured) return configured;
  const available = states.find(state => state.available);
  if (available) throw new Error(`Agent ${available.id} is installed but Gentle AI configuration was not detected. Run gentle-ai sync for that agent first.`);
  throw new Error('No supported development agent is installed. Install OpenCode, Codex, Claude Code, or Gemini CLI, then configure it with Gentle AI.');
}

export async function inspectGentleProject(cwd: string): Promise<GentleProjectState> {
  const git = await captureGitSnapshot(cwd);
  const installed = await commandExists('gentle-ai');
  let version: CommandResult | null = null;
  let doctor: CommandResult | null = null;
  let reviewMode: CommandResult | null = null;

  if (installed) {
    [version, doctor, reviewMode] = await Promise.all([
      runCommand(['gentle-ai', 'version'], { cwd: git.root, timeoutMs: 20_000 }),
      runCommand(['gentle-ai', 'doctor'], { cwd: git.root, timeoutMs: 90_000 }),
      runCommand(['gentle-ai', 'review', 'mode', 'status', '--cwd', git.root], { cwd: git.root, timeoutMs: 30_000 })
    ]);
  }

  const agents = await Promise.all(DEVELOPMENT_AGENTS.map(agent => detectAgentState(agent, git.root)));
  const recommendedAgent = agents.find(agent => agent.available && agent.gentleConfigured)?.id ?? null;
  return {
    cwd: git.root,
    git,
    gentleAi: {
      installed,
      version: version ? cleanOutput(version) || null : null,
      doctorExitCode: doctor?.exitCode ?? null,
      doctorOutput: doctor ? cleanOutput(doctor) || null : null,
      reviewModeExitCode: reviewMode?.exitCode ?? null,
      reviewModeOutput: reviewMode ? cleanOutput(reviewMode) || null : null,
      skillRegistryPresent: await exists(path.join(git.root, '.atl', 'skill-registry.md'))
    },
    agents,
    recommendedAgent
  };
}

export async function refreshGentleProject(cwd: string): Promise<CommandResult> {
  if (!await commandExists('gentle-ai')) throw new Error('gentle-ai is not installed or not on PATH');
  const result = await runCommand(
    ['gentle-ai', 'skill-registry', 'refresh', '--cwd', cwd, '--quiet'],
    { cwd, timeoutMs: 120_000 }
  );
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`Gentle AI skill-registry refresh failed: ${cleanOutput(result)}`);
  }
  return result;
}

export function buildDevelopmentPrompt(options: DevelopmentPromptOptions): string {
  const verification = options.verificationCommands.length > 0
    ? options.verificationCommands.map(argv => argv.join(' ')).join('\n- ')
    : 'No independent command was preselected; detect and run the narrowest relevant tests yourself.';
  const routing = options.useSdd
    ? 'The user explicitly requested SDD. Use the Gentle AI SDD workflow and persist the appropriate artifacts before implementation.'
    : 'Use Gentle AI organic routing: keep a truly bounded change direct, delegate broad exploration/writes, and propose SDD only when durable artifacts materially reduce ambiguity.';

  return [
    'You are the coding agent configured by Gentle AI, running non-interactively inside an authorized project.',
    `Project root: ${options.cwd}`,
    routing,
    'Required operating contract:',
    '1. Inspect the exact repository state before editing and preserve unrelated pre-existing changes.',
    '2. Read project AGENTS.md/CLAUDE.md and the Gentle AI skill registry. Use matching skills and focused subagents when supported.',
    '3. Work only inside the project root. Do not use sudo, modify accounts/network/boot settings, or read credential stores.',
    '4. Do not commit, push, open a PR, reset, clean, rebase, or discard existing work unless the task explicitly says so.',
    '5. Implement the smallest complete solution. Run relevant tests/typecheck/build and inspect the final diff.',
    '6. Finish with a concise report: outcome, files changed, commands/checks with results, remaining uncertainty. Do not claim success without evidence.',
    `Baseline git status before your run:\n${options.baselineStatus || '(clean worktree)'}`,
    `Independent verification planned by the MCP after your run:\n- ${verification}`,
    `User development task:\n${options.task}`
  ].join('\n\n');
}

export function buildAgentInvocation(input: { agent: DevelopmentAgentState; prompt: string; cwd: string; autoApprove: boolean }): string[] {
  switch (input.agent.id) {
    case 'opencode': {
      const argv = ['opencode', 'run', '--dir', input.cwd, '--agent', 'gentle-orchestrator', '--title', 'MCP Free Gentle development'];
      if (input.autoApprove) argv.push('--auto');
      argv.push(input.prompt);
      return argv;
    }
    case 'codex':
      return ['codex', 'exec', input.prompt];
    case 'claude':
      return ['claude', '--print', '-p', input.prompt];
    case 'gemini':
      return ['gemini', '-p', input.prompt];
  }
}

function uniqueCommands(commands: string[][]): string[][] {
  const seen = new Set<string>();
  return commands.filter(command => {
    const key = JSON.stringify(command);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
      // The coding agent can report an invalid package.json; Git diff checks still run.
    }
  }
  if (await exists(path.join(cwd, 'go.mod'))) commands.push(['go', 'test', './...']);
  if (await exists(path.join(cwd, 'Cargo.toml'))) commands.push(['cargo', 'test']);
  if (await exists(path.join(cwd, 'pyproject.toml')) || await exists(path.join(cwd, 'pytest.ini'))) {
    commands.push(['python', '-m', 'pytest']);
  }
  return uniqueCommands(commands).slice(0, 4);
}
