#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def read(path: str) -> str:
    return (ROOT / path).read_text()

def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)

def replace(path: str, old: str, new: str) -> None:
    content = read(path)
    if old not in content:
        raise SystemExit(f"expected text not found in {path}: {old[:120]!r}")
    write(path, content.replace(old, new, 1))

def regex_replace(path: str, pattern: str, replacement: str) -> None:
    content = read(path)
    updated, count = re.subn(pattern, replacement, content, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"expected one regex match in {path}, got {count}: {pattern[:120]!r}")
    write(path, updated)

if (ROOT / '.final-security-boundary-applied').exists():
    print('final security boundary already applied')
    raise SystemExit(0)

write('src/core/command.ts', r'''import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from '../config.js';
import type { CommandResult } from '../types.js';

function truncate(value: string, limitBytes: number): string {
  const bytes = Buffer.byteLength(value);
  if (bytes <= limitBytes) return value;
  return `${value.slice(0, Math.max(0, limitBytes - 200))}\n...[output truncated; ${bytes} bytes total]`;
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        try { process.kill(pid, signal); } catch { /* Process already exited. */ }
      }
      return;
    }
  }
  try { process.kill(pid, signal); } catch { /* Process already exited. */ }
}

export async function runCommand(
  argv: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    maxTimeoutMs?: number;
    maxOutputBytes?: number;
    env?: Record<string, string>;
    inheritEnv?: boolean;
    stdin?: string;
    signal?: AbortSignal;
  } = {}
): Promise<CommandResult> {
  if (argv.length === 0) throw new Error('argv must not be empty');
  const cwd = path.resolve(options.cwd ?? config.home);
  const maxTimeoutMs = options.maxTimeoutMs ?? 15 * 60_000;
  const timeoutMs = Math.min(options.timeoutMs ?? config.commandTimeoutMs, maxTimeoutMs);
  const maxOutputBytes = Math.min(options.maxOutputBytes ?? config.maxOutputBytes, 16 * 1024 * 1024);
  const started = Date.now();
  const childEnvironment = options.inheritEnv === false
    ? { ...(options.env ?? {}) }
    : { ...process.env, ...(options.env ?? {}) };

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: childEnvironment,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const terminate = (reason: 'timeout' | 'cancel'): void => {
      if (settled) return;
      if (reason === 'timeout') timedOut = true;
      else cancelled = true;
      terminateProcessGroup(child.pid, 'SIGTERM');
      forceKillTimer = setTimeout(() => terminateProcessGroup(child.pid, 'SIGKILL'), 2_000);
      forceKillTimer.unref();
    };

    const timer = setTimeout(() => terminate('timeout'), timeoutMs);
    const onAbort = (): void => terminate('cancel');
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        argv,
        cwd,
        exitCode,
        signal,
        stdout: truncate(stdout, maxOutputBytes),
        stderr: truncate(stderr, maxOutputBytes),
        timedOut,
        ...(cancelled ? { cancelled: true } : {}),
        durationMs: Date.now() - started
      });
    });

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

export async function commandExists(command: string): Promise<boolean> {
  const result = await runCommand(['/usr/bin/env', 'bash', '-c', 'command -v -- "$1"', 'mcp-free', command], {
    timeoutMs: 5_000,
    inheritEnv: false,
    env: { PATH: '/usr/bin:/bin' }
  });
  return result.exitCode === 0;
}
''')

write('src/config.ts', r'''import os from 'node:os';
import path from 'node:path';
import type { AccessMode } from './types.js';

const home = os.homedir();

function intEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function modeEnv(): AccessMode {
  const value = process.env.MCP_MODE ?? 'observe';
  if (value !== 'observe' && value !== 'workspace' && value !== 'full') {
    throw new Error('MCP_MODE must be observe, workspace, or full');
  }
  return value;
}

function pathList(value: string | undefined, fallback: string[]): string[] {
  const items = value ? value.split(':') : fallback;
  return [...new Set(items.map(item => path.resolve(item.replace(/^~(?=\/|$)/, home))).filter(Boolean))];
}

export function assertSafeNetworkBinding(host: string, authToken: string | null): void {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = normalized === 'localhost' || normalized === '::1' || /^127\./.test(normalized);
  if (!loopback && !authToken) throw new Error('MCP_AUTH_TOKEN is required when MCP_HOST is not loopback');
}

const accessMode = modeEnv();
const verificationSandbox = process.env.MCP_VERIFICATION_SANDBOX !== '0';
const requestedVerificationNetwork = process.env.MCP_VERIFICATION_NETWORK === '1';
if (accessMode === 'workspace' && !verificationSandbox) {
  throw new Error('MCP_VERIFICATION_SANDBOX=0 is forbidden in workspace mode');
}
if (accessMode !== 'full' && requestedVerificationNetwork) {
  throw new Error('MCP_VERIFICATION_NETWORK=1 is allowed only in full mode');
}

export const config = {
  host: process.env.MCP_HOST ?? '127.0.0.1',
  port: intEnv('MCP_PORT', 8787),
  mcpPath: process.env.MCP_PATH ?? '/mcp',
  mode: accessMode,
  allowedRoots: pathList(process.env.MCP_ALLOWED_ROOTS, [path.join(home, 'code'), path.join(home, 'Documents'), path.join(home, 'Downloads')]),
  allowSecrets: process.env.MCP_ALLOW_SECRETS === '1',
  authToken: process.env.MCP_AUTH_TOKEN || null,
  maxReadBytes: intEnv('MCP_MAX_READ_BYTES', 1_048_576),
  maxOutputBytes: intEnv('MCP_MAX_OUTPUT_BYTES', 262_144),
  commandTimeoutMs: intEnv('MCP_COMMAND_TIMEOUT_MS', 120_000),
  developmentTimeoutMs: intEnv('MCP_DEVELOPMENT_TIMEOUT_MS', 1_800_000),
  rateLimitPerMinute: intEnv('MCP_RATE_LIMIT_PER_MINUTE', 120),
  stateDir: path.resolve(process.env.MCP_STATE_DIR ?? path.join(home, '.local', 'state', 'mcp-free')),
  logLevel: process.env.MCP_LOG_LEVEL ?? 'info',
  verificationSandbox,
  verificationNetwork: accessMode === 'full' && requestedVerificationNetwork,
  home
} as const;

export const sensitivePathFragments = [
  '/.ssh/',
  '/.gnupg/',
  '/.aws/',
  '/.config/gcloud/',
  '/.kube/',
  '/.password-store/',
  '/.local/share/keyrings/',
  '/etc/shadow',
  '/etc/sudoers'
] as const;
''')

write('src/tools/workspace.ts', r'''import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { classifyFileAction, requireConfirmation } from '../core/policy.js';
import { resolveAllowedPath } from '../core/paths.js';
import { verifyReceiptChain, writeReceipt } from '../core/receipts.js';
import { ensureAnchoredDirectory, openAnchoredFile, renameAnchoredPath } from '../core/safe-fs.js';
import { assertPathNotLeased } from '../core/worktree-lease.js';
import { errorResult, textResult } from './helpers.js';

async function assertHealthyReceiptChain(): Promise<void> {
  const verification = await verifyReceiptChain();
  if (!verification.valid) throw new Error(`Receipt chain is invalid; refusing workspace write: ${verification.errors.join('; ')}`);
}

export async function writeFileNoFollow(target: string, content: string, overwrite: boolean): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | (overwrite ? 0 : constants.O_EXCL);
  const opened = await openAnchoredFile(target, flags, { mode: 0o600, createParents: true, write: true });
  try {
    if (overwrite) await opened.file.truncate(0);
    const buffer = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await opened.file.write(buffer, offset, buffer.length - offset, offset);
      if (bytesWritten <= 0) throw new Error(`Failed to write bytes to ${target}`);
      offset += bytesWritten;
    }
    await opened.file.sync();
  } finally {
    await Promise.all([opened.file.close(), opened.parent.close()]);
  }
}

export async function patchFileNoFollow(target: string, expected: string, replacement: string): Promise<{ original: string; updated: string }> {
  const opened = await openAnchoredFile(target, constants.O_RDWR, { write: true });
  try {
    const original = await opened.file.readFile('utf8');
    const matches = original.split(expected).length - 1;
    if (matches !== 1) throw new Error(`Expected text must occur exactly once; found ${matches} matches`);
    const updated = original.replace(expected, replacement);
    await opened.file.truncate(0);
    const buffer = Buffer.from(updated, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await opened.file.write(buffer, offset, buffer.length - offset, offset);
      if (bytesWritten <= 0) throw new Error(`Failed to write patched bytes to ${target}`);
      offset += bytesWritten;
    }
    await opened.file.sync();
    return { original, updated };
  } finally {
    await Promise.all([opened.file.close(), opened.parent.close()]);
  }
}

export async function renameAnchored(from: string, to: string): Promise<void> {
  await renameAnchoredPath(from, to);
}

export function registerWorkspaceTools(server: McpServer): void {
  server.registerTool('filesystem_write', {
    title: 'Write file',
    description: 'Create or replace one UTF-8 file through descriptor-anchored, no-follow operations inside a physical allowed root.',
    inputSchema: {
      path: z.string(),
      content: z.string(),
      overwrite: z.boolean().default(false),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ path: inputPath, content, overwrite, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const target = await resolveAllowedPath(inputPath, { write: true });
      await assertPathNotLeased(target);
      const risk = classifyFileAction('write', target);
      await writeFileNoFollow(target, content, overwrite);
      const receipt = await writeReceipt({
        action: 'filesystem_write', riskTier: risk, success: true, durationMs: Date.now() - started,
        requestId: request_id, target, output: content,
        details: { bytesWritten: Buffer.byteLength(content), overwrite, descriptorAnchored: true, noFollow: true }
      });
      return textResult(`Wrote ${Buffer.byteLength(content)} bytes to ${target}. Receipt: ${receipt.id}.`, { path: target, bytesWritten: Buffer.byteLength(content), receipt });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool('filesystem_mkdir', {
    title: 'Create directory',
    description: 'Create one directory path component-by-component through verified directory descriptors.',
    inputSchema: { path: z.string(), request_id: z.string().min(8).max(128).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ path: inputPath, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const target = await resolveAllowedPath(inputPath, { write: true });
      await assertPathNotLeased(target);
      const handle = await ensureAnchoredDirectory(target);
      await handle.close();
      const receipt = await writeReceipt({ action: 'filesystem_mkdir', riskTier: 1, success: true, durationMs: Date.now() - started, requestId: request_id, target, details: { descriptorAnchored: true } });
      return textResult(`Created directory ${target}. Receipt: ${receipt.id}.`, { path: target, receipt });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool('filesystem_patch', {
    title: 'Patch file',
    description: 'Replace one exact occurrence in a regular UTF-8 file opened relative to a verified parent descriptor.',
    inputSchema: {
      path: z.string(), expected: z.string().min(1), replacement: z.string(),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ path: inputPath, expected, replacement, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const target = await resolveAllowedPath(inputPath, { mustExist: true, write: true });
      await assertPathNotLeased(target);
      const { original, updated } = await patchFileNoFollow(target, expected, replacement);
      const receipt = await writeReceipt({
        action: 'filesystem_patch', riskTier: 1, success: true, durationMs: Date.now() - started,
        requestId: request_id, target, output: updated,
        details: { beforeBytes: Buffer.byteLength(original), afterBytes: Buffer.byteLength(updated), descriptorAnchored: true, noFollow: true }
      });
      return textResult(`Patched ${target}. Receipt: ${receipt.id}.`, { path: target, receipt });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool('filesystem_move', {
    title: 'Move file or directory',
    description: 'Move a non-symlink entry between descriptor-anchored allowed directories. Every move requires explicit confirmation.',
    inputSchema: {
      source: z.string(), destination: z.string(), replace: z.boolean().default(false),
      confirm: z.literal(true), request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ source, destination, replace, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const from = await resolveAllowedPath(source, { mustExist: true, write: true });
      const to = await resolveAllowedPath(destination, { write: true });
      await Promise.all([assertPathNotLeased(from), assertPathNotLeased(to)]);
      requireConfirmation(2, true);
      try {
        await fs.lstat(to);
        if (!replace) throw new Error('Destination exists; set replace=true after reviewing it');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await renameAnchored(from, to);
      const receipt = await writeReceipt({
        action: 'filesystem_move', riskTier: 2, success: true, durationMs: Date.now() - started,
        requestId: request_id, target: `${from} -> ${to}`, details: { replace, descriptorAnchored: true }
      });
      return textResult(`Moved ${from} to ${to}. Receipt: ${receipt.id}.`, { source: from, destination: to, receipt });
    } catch (error) { return errorResult(error); }
  });
}
''')

# command sandbox must reproduce host merged-/usr links exactly.
replace('src/core/verification-sandbox.ts', "import fs from 'node:fs/promises';", "import { readlinkSync } from 'node:fs';\nimport fs from 'node:fs/promises';")
replace('src/core/verification-sandbox.ts', "const HOST_ENVIRONMENT: Record<string, string> = {", "function hostLinkTarget(link: string, fallback: string): string {\n  try { return readlinkSync(link); } catch { return fallback; }\n}\n\nconst HOST_ENVIRONMENT: Record<string, string> = {")
replace('src/core/verification-sandbox.ts', "    '--symlink', 'usr/bin', '/bin',\n    '--symlink', 'usr/lib', '/lib',\n    '--symlink', 'usr/lib', '/lib64',", "    '--symlink', hostLinkTarget('/bin', 'usr/bin'), '/bin',\n    '--symlink', hostLinkTarget('/lib', 'usr/lib'), '/lib',\n    '--symlink', hostLinkTarget('/lib64', 'usr/lib64'), '/lib64',")

# Read tools: descriptor identity and sandboxed search.
replace('src/tools/read.ts', "import { commandExists, runCommand } from '../core/command.js';", "import { runCommand } from '../core/command.js';\nimport { canonicalizeInspectionCommand } from '../core/command-policy.js';")
replace('src/tools/read.ts', "import { revalidateAllowedPath, resolveAllowedPath } from '../core/paths.js';", "import { revalidateAllowedPath, resolveAllowedPath } from '../core/paths.js';\nimport { assertOpenedDescriptorAllowed } from '../core/safe-fs.js';\nimport { runInspectionCommand } from '../core/verification-sandbox.js';")
replace('src/tools/read.ts', "        await revalidateAllowedPath(target, { mustExist: true });\n        const buffer = Buffer.alloc(max_bytes);", "        await assertOpenedDescriptorAllowed(handle, { expectedPath: target });\n        const buffer = Buffer.alloc(max_bytes);")
regex_replace('src/tools/read.ts', r"      let result;\n      if \(mode === 'content'.*?      const lines = result\.stdout\.split\('\\n'\)\.filter\(Boolean\);", r"      const logical = mode === 'content'\n        ? ['rg', '--line-number', '--hidden', '--no-ignore', '--no-messages', '--max-count', String(max_results), '--', query, '.']\n        : ['fd', '--hidden', '--exclude', '.git', '--max-results', String(max_results), '--', query, '.'];\n      const canonical = await canonicalizeInspectionCommand(logical, target);\n      const result = await runInspectionCommand(target, canonical, { timeoutMs: 30_000 });\n      result.stdout = result.stdout.replaceAll('/workspace', target);\n      result.stderr = result.stderr.replaceAll('/workspace', target);\n      const lines = result.stdout.split('\\n').filter(Boolean);")

# Development core imports and validators.
replace('src/core/development.ts', "import { runCommand } from './command.js';", "import { runCommand } from './command.js';\nimport {\n  canonicalizeInspectionCommand,\n  canonicalizeVerificationCommand,\n  resolveTrustedExecutable,\n  validateInspectionCommand as validateInspectionCommandPolicy,\n  validateVerificationCommand as validateVerificationCommandPolicy\n} from './command-policy.js';")
replace('src/core/development.ts', "import { withOrchestrationLock } from './orchestration-lock.js';", "import { withOrchestrationLock } from './orchestration-lock.js';\nimport { runInspectionCommand, runVerificationCommand } from './verification-sandbox.js';")
regex_replace('src/core/development.ts', r"export async function captureGitSnapshot\(cwd: string\): Promise<GitSnapshot> \{.*?\n\}\n\nexport function defaultLaneSpecs", r"export async function captureGitSnapshot(cwd: string): Promise<GitSnapshot> {\n  const git = await resolveTrustedExecutable('git');\n  const hostEnvironment = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };\n  const rootResult = await runCommand([git, '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 10_000, inheritEnv: false, env: hostEnvironment });\n  if (rootResult.exitCode !== 0) throw new Error(`Development orchestration requires a Git worktree: ${cleanOutput(rootResult)}`);\n  const root = await fs.realpath(rootResult.stdout.trim());\n  const logicalCommands = [\n    ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],\n    ['git', 'rev-parse', '--verify', 'HEAD'],\n    ['git', 'status', '--porcelain', '--untracked-files', 'all'],\n    ['git', 'diff', '--stat']\n  ];\n  const canonical = await Promise.all(logicalCommands.map(command => canonicalizeInspectionCommand(command, root)));\n  const [branch, head, status, diffStat] = await Promise.all(canonical.map(command => runInspectionCommand(root, command, { timeoutMs: 15_000 })));\n  return {\n    root,\n    branch: branch.stdout.trim() || '(detached)',\n    head: head.exitCode === 0 ? head.stdout.trim() : null,\n    status: status.stdout.trim(),\n    diffStat: diffStat.stdout.trim()\n  };\n}\n\nexport function defaultLaneSpecs")
regex_replace('src/core/development.ts', r"const INSPECTION_EXECUTABLES.*?const INSPECTION_ENV: Record<string, string> = \{.*?\n\};", r"export const validateInspectionCommand = validateInspectionCommandPolicy;\nexport const validateVerificationCommand = validateVerificationCommandPolicy;\n\nconst INSPECTION_ENV: Record<string, string> = {\n  PATH: '/usr/bin:/bin',\n  LANG: 'C',\n  LC_ALL: 'C',\n  GIT_CONFIG_GLOBAL: '/dev/null',\n  GIT_CONFIG_NOSYSTEM: '1',\n  GIT_OPTIONAL_LOCKS: '0',\n  NO_COLOR: '1'\n};")
replace('src/core/development.ts', "      const check = await runCommand(['git', 'apply', '--check', '--', '-'], { cwd: state.root, stdin: patchText, timeoutMs: 60_000 });", "      const git = await resolveTrustedExecutable('git');\n      const check = await runCommand([git, 'apply', '--check', '--', '-'], { cwd: state.root, stdin: patchText, timeoutMs: 60_000, inheritEnv: false, env: INSPECTION_ENV });")
replace('src/core/development.ts', "      const apply = await runCommand(['git', 'apply', '--whitespace=nowarn', '--', '-'], { cwd: state.root, stdin: patchText, timeoutMs: 120_000 });", "      const apply = await runCommand([git, 'apply', '--whitespace=nowarn', '--', '-'], { cwd: state.root, stdin: patchText, timeoutMs: 120_000, inheritEnv: false, env: INSPECTION_ENV });")
regex_replace('src/core/development.ts', r"const VERIFICATION_EXECUTABLES.*?\nexport async function verifyOrchestration", r"export async function verifyOrchestration")
regex_replace('src/core/development.ts', r"export async function verifyOrchestration\(id: string, commands: string\[\]\[\], timeoutMs: number\): Promise<OrchestrationState> \{.*?\n\}\n\nexport async function finalizeOrchestration", r"export async function verifyOrchestration(id: string, commands: string[][], timeoutMs: number): Promise<OrchestrationState> {\n  return withOrchestrationLock(id, async () => {\n    const state = await loadOrchestration(id);\n    if (state.status !== 'applied' && state.status !== 'verification_failed') throw new Error(`Verification requires an applied patch; current status is ${state.status}`);\n    await acquireWorktreeLease(state.root, state.id);\n    try {\n      commands.forEach(validateVerificationCommand);\n      const canonicalCommands = await Promise.all(commands.map(command => canonicalizeVerificationCommand(command)));\n      const current = await captureGitSnapshot(state.root);\n      if (current.head !== state.baseline.head || current.branch !== state.baseline.branch) throw new Error('Git branch or HEAD changed during orchestration');\n\n      const preFingerprint = await computeWorktreeFingerprint(state.root);\n      const diffCommand = await canonicalizeInspectionCommand(['git', 'diff', '--check'], state.root);\n      const diffCheck = await runInspectionCommand(state.root, diffCommand, { timeoutMs: 60_000 });\n      const results: CommandResult[] = [];\n      for (const command of canonicalCommands) {\n        results.push(await runVerificationCommand(state.root, command, { timeoutMs, maxTimeoutMs: config.developmentTimeoutMs }));\n      }\n      const postFingerprint = await computeWorktreeFingerprint(state.root);\n      const worktreeStable = preFingerprint === postFingerprint;\n      const success = worktreeStable\n        && diffCheck.exitCode === 0\n        && !diffCheck.timedOut\n        && results.every(result => result.exitCode === 0 && !result.timedOut && !result.cancelled);\n      state.verification = {\n        completedAt: new Date().toISOString(), success, diffCheck, commands, results,\n        preFingerprint, postFingerprint, worktreeStable\n      };\n      state.status = success ? 'verified' : 'verification_failed';\n      await saveOrchestration(state);\n      if (success) await writeVerifiedWorktreeFingerprint(state, postFingerprint);\n      else await releaseWorktreeLease(state.root, state.id);\n      return state;\n    } catch (error) {\n      await releaseWorktreeLease(state.root, state.id);\n      throw error;\n    }\n  });\n}\n\nexport async function finalizeOrchestration")

# Lane coordinator canonicalizes before persistence and executes only in read-only sandbox.
replace('src/core/lane-coordinator.ts', "  loadOrchestration,\n  validateInspectionCommand,", "  loadOrchestration,")
replace('src/core/lane-coordinator.ts', "import { runCommand } from './command.js';", "import { canonicalizeInspectionCommand } from './command-policy.js';")
replace('src/core/lane-coordinator.ts', "import { withOrchestrationLock } from './orchestration-lock.js';", "import { withOrchestrationLock } from './orchestration-lock.js';\nimport { runInspectionCommand } from './verification-sandbox.js';")
regex_replace('src/core/lane-coordinator.ts', r"async function assertExistingArgumentsStayInProject.*?const inspectionEnvironment: Record<string, string> = \{.*?\n\};\n", "")
replace('src/core/lane-coordinator.ts', "      const result = await runCommand(record.commands[index]!, {\n        cwd: root,\n        timeoutMs: record.timeoutMs,\n        maxTimeoutMs: config.developmentTimeoutMs,\n        env: inspectionEnvironment,\n        signal: controller.signal\n      });", "      const result = await runInspectionCommand(root, record.commands[index]!, {\n        timeoutMs: record.timeoutMs,\n        maxTimeoutMs: config.developmentTimeoutMs,\n        signal: controller.signal\n      });")
replace('src/core/lane-coordinator.ts', "      for (const argv of request.commands) {\n        validateInspectionCommand(argv);\n        await assertExistingArgumentsStayInProject(loaded.orchestration.root, argv);\n      }", "      const canonicalCommands: string[][] = [];\n      for (const argv of request.commands) {\n        canonicalCommands.push(await canonicalizeInspectionCommand(argv, loaded.orchestration.root));\n      }")
replace('src/core/lane-coordinator.ts', "        commands: request.commands,", "        commands: canonicalCommands,")

# Fingerprints never resolve git through a user-writable PATH.
replace('src/core/worktree-fingerprint.ts', "import { runCommand } from './command.js';", "import { runCommand } from './command.js';\nimport { resolveTrustedExecutable } from './command-policy.js';")
replace('src/core/worktree-fingerprint.ts', "const TRUNCATED_MARKER = '\\n...[output truncated; ';", "const TRUNCATED_MARKER = '\\n...[output truncated; ';\nconst GIT_ENV = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };\n\nasync function runGit(args: string[], options: { cwd: string; timeoutMs: number; maxOutputBytes?: number }): Promise<CommandResult> {\n  const git = await resolveTrustedExecutable('git');\n  return runCommand([git, '-c', 'core.fsmonitor=false', ...args], { ...options, inheritEnv: false, env: GIT_ENV });\n}")
replace('src/core/worktree-fingerprint.ts', "import type { OrchestrationState } from './development.js';", "import type { CommandResult } from '../types.js';\nimport type { OrchestrationState } from './development.js';")
write('src/core/worktree-fingerprint.ts', read('src/core/worktree-fingerprint.ts').replace("runCommand(['git', ", "runGit(["))

# Receipts serialize across service instances and fsync every durable component.
replace('src/core/receipts.ts', "let receiptWriteQueue: Promise<void> = Promise.resolve();", "let receiptWriteQueue: Promise<void> = Promise.resolve();\nconst receiptLockPath = path.join(config.stateDir, 'receipt-chain.lock');\nconst receiptLockToken = `${process.pid}-${crypto.randomBytes(12).toString('hex')}`;\n\nasync function processIsAlive(pid: number): Promise<boolean> {\n  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }\n}\n\nasync function withReceiptFilesystemLock<T>(operation: () => Promise<T>): Promise<T> {\n  const deadline = Date.now() + 60_000;\n  while (true) {\n    try {\n      await fs.mkdir(receiptLockPath, { mode: 0o700 });\n      await fs.writeFile(path.join(receiptLockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token: receiptLockToken }), { mode: 0o600, flag: 'wx' });\n      break;\n    } catch (error) {\n      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;\n      let stale = false;\n      try {\n        const owner = JSON.parse(await fs.readFile(path.join(receiptLockPath, 'owner.json'), 'utf8')) as { pid?: number };\n        stale = !(await processIsAlive(owner.pid ?? -1));\n      } catch {\n        const metadata = await fs.stat(receiptLockPath);\n        stale = Date.now() - metadata.mtimeMs > 60_000;\n      }\n      if (stale) { await fs.rm(receiptLockPath, { recursive: true, force: true }); continue; }\n      if (Date.now() >= deadline) throw new Error('Timed out waiting for receipt-chain lock');\n      await new Promise(resolve => setTimeout(resolve, 25));\n    }\n  }\n  try { return await operation(); } finally {\n    try {\n      const owner = JSON.parse(await fs.readFile(path.join(receiptLockPath, 'owner.json'), 'utf8')) as { token?: string };\n      if (owner.token !== receiptLockToken) throw new Error('Refusing to release another process receipt lock');\n      await fs.rm(receiptLockPath, { recursive: true, force: true });\n    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }\n  }\n}")
replace('src/core/receipts.ts', "export async function verifyReceiptChain(): Promise<ReceiptChainVerification> {\n  await receiptWriteQueue;\n  return verifyReceiptChainUnlocked();\n}", "export async function verifyReceiptChain(): Promise<ReceiptChainVerification> {\n  await receiptWriteQueue;\n  return withReceiptFilesystemLock(() => verifyReceiptChainUnlocked());\n}")
replace('src/core/receipts.ts', "  await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' });\n  await fs.rename(temporary, chainHeadPath);\n  await fs.chmod(chainHeadPath, 0o600);", "  const handle = await fs.open(temporary, 'wx', 0o600);\n  try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }\n  await fs.rename(temporary, chainHeadPath);\n  await fs.chmod(chainHeadPath, 0o600);\n  const directory = await fs.open(path.dirname(chainHeadPath), 'r');\n  try { await directory.sync(); } finally { await directory.close(); }")
replace('src/core/receipts.ts', "  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\\n`, { mode: 0o600, flag: 'wx' });", "  const receiptFile = await fs.open(receiptPath, 'wx', 0o600);\n  try { await receiptFile.writeFile(`${JSON.stringify(receipt, null, 2)}\\n`, 'utf8'); await receiptFile.sync(); } finally { await receiptFile.close(); }")
replace('src/core/receipts.ts', "  const operation = receiptWriteQueue.then(() => writeReceiptUnlocked(input));", "  const operation = receiptWriteQueue.then(() => withReceiptFilesystemLock(() => writeReceiptUnlocked(input)));")

# Versions, health contract, installer, and docs.
for path in ['package.json', '.codex-plugin/plugin.json', 'src/server.ts']:
    write(path, read(path).replace('0.5.0', '0.6.0'))
replace('src/server.ts', "    processGroupTermination: true", "    processGroupTermination: true,\n    canonicalRootOwnedExecutables: true,\n    inspectionSandbox: config.verificationSandbox,\n    verificationSandbox: config.verificationSandbox,\n    verificationNetwork: config.verificationNetwork,\n    cleanVerificationEnvironment: true,\n    descriptorAnchoredWrites: true")
replace('scripts/install-cachyos.sh', "  nodejs npm git ripgrep fd jq curl", "  nodejs npm git ripgrep fd jq bubblewrap curl")
replace('scripts/install-cachyos.sh', "MCP_DEVELOPMENT_TIMEOUT_MS=1800000\n", "MCP_DEVELOPMENT_TIMEOUT_MS=1800000\nMCP_VERIFICATION_SANDBOX=1\nMCP_VERIFICATION_NETWORK=0\n")
replace('scripts/install-cachyos.sh', "  grep -q '^MCP_DEVELOPMENT_TIMEOUT_MS=' \"$ENV_FILE\" || printf '\\nMCP_DEVELOPMENT_TIMEOUT_MS=1800000\\n' >> \"$ENV_FILE\"", "  grep -q '^MCP_DEVELOPMENT_TIMEOUT_MS=' \"$ENV_FILE\" || printf '\\nMCP_DEVELOPMENT_TIMEOUT_MS=1800000\\n' >> \"$ENV_FILE\"\n  grep -q '^MCP_VERIFICATION_SANDBOX=' \"$ENV_FILE\" || printf 'MCP_VERIFICATION_SANDBOX=1\\n' >> \"$ENV_FILE\"\n  grep -q '^MCP_VERIFICATION_NETWORK=' \"$ENV_FILE\" || printf 'MCP_VERIFICATION_NETWORK=0\\n' >> \"$ENV_FILE\"")

security_note = r'''

## Command and test isolation (0.6.0)

Workspace and observe development tools accept logical executable names only. The server resolves them to root-owned, non-writable binaries below `/usr` or `/usr/local`; inputs such as `/tmp/git`, `./git`, and user-controlled PATH replacements are rejected. Each supported command has a closed argument grammar, and path-bearing options cannot escape the project.

Inspection commands run in a read-only Bubblewrap namespace. Verification commands run in a writable worktree namespace with an empty environment, a temporary HOME, no MCP state mount, no credentials, no network by default, and no access to the rest of the user's home. Workspace mode refuses to start if sandbox bypass is requested. Networked or unsandboxed verification is available only in full mode and remains equivalent to arbitrary code execution.

The local receipt chain is an operational tamper detector, not protection against a hostile process already controlling the same Linux account. Receipt appends are serialized across service instances and fsynced, while stronger adversarial guarantees still require a dedicated OS user or external append-only storage.
'''
for path in ['README.md', 'docs/SECURITY.md', 'docs/DEVELOPMENT.md']:
    content = read(path)
    if 'Command and test isolation (0.6.0)' not in content:
        write(path, content.rstrip() + security_note + '\n')

# CI-facing tests expect new config defaults.
replace('tests/development.test.ts', "  assert.throws(() => validateInspectionCommand(['cat', '.env']), /Credential-like/);", "  assert.throws(() => validateInspectionCommand(['cat', '.env']), /Credential-like/);\n  assert.throws(() => validateInspectionCommand(['/tmp/git', 'status']), /logical name|never a path/);\n  assert.throws(() => validateInspectionCommand(['./git', 'status']), /logical name|never a path/);")

write('.final-security-boundary-applied', '0.6.0\n')
print('final security boundary applied')
