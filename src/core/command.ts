import { spawn } from 'node:child_process';
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
