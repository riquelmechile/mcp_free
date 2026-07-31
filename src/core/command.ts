import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { CommandResult } from '../types.js';

const TRUSTED_SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin';
const TRUSTED_EXECUTABLE_DIRECTORIES = ['/usr/bin', '/usr/local/bin'] as const;
const TRUSTED_EXECUTABLE_ROOTS = ['/usr/bin', '/usr/lib', '/usr/libexec', '/usr/share', '/usr/local/bin', '/usr/local/lib'] as const;

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveRunExecutable(executable: string): Promise<string> {
  if (executable.includes('\0')) throw new Error('NUL bytes are not allowed in executable names');
  if (path.isAbsolute(executable)) return executable;
  if (path.basename(executable) !== executable || executable.includes('/') || executable.includes('\\')) {
    throw new Error(`Executable must be an absolute path or a logical system name: ${executable}`);
  }

  for (const directory of TRUSTED_EXECUTABLE_DIRECTORIES) {
    const candidate = path.join(directory, executable);
    try {
      const physical = await fs.realpath(candidate);
      const metadata = await fs.stat(physical);
      if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) continue;
      if (!TRUSTED_EXECUTABLE_ROOTS.some(root => within(physical, root))) continue;
      return physical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  throw new Error(`Trusted root-owned system executable is unavailable: ${executable}`);
}

function fitUtf8(value: Buffer, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let text = value.subarray(0, maxBytes).toString('utf8');
  while (Buffer.byteLength(text) > maxBytes && text.length > 0) text = text.slice(0, -1);
  return text;
}

export class BoundedOutputCollector {
  readonly maxBytes: number;
  totalBytes = 0;
  retainedBytes = 0;
  readonly #chunks: Buffer[] = [];

  constructor(maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive integer');
    this.maxBytes = maxBytes;
  }

  append(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += buffer.length;
    const remaining = this.maxBytes - this.retainedBytes;
    if (remaining <= 0) return;
    const retained = buffer.subarray(0, Math.min(remaining, buffer.length));
    if (retained.length > 0) {
      this.#chunks.push(Buffer.from(retained));
      this.retainedBytes += retained.length;
    }
  }

  render(): string {
    const retained = Buffer.concat(this.#chunks, this.retainedBytes);
    if (this.totalBytes <= this.maxBytes) return retained.toString('utf8');
    const marker = Buffer.from(`\n...[output truncated; ${this.totalBytes} bytes total]`);
    if (marker.length >= this.maxBytes) return fitUtf8(marker, this.maxBytes);
    return `${fitUtf8(retained, this.maxBytes - marker.length)}${marker.toString('utf8')}`;
  }
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
  const logicalExecutable = !path.isAbsolute(argv[0]!);
  const resolvedArgv = [await resolveRunExecutable(argv[0]!), ...argv.slice(1)];
  const cwd = path.resolve(options.cwd ?? config.home);
  const maxTimeoutMs = options.maxTimeoutMs ?? 15 * 60_000;
  const timeoutMs = Math.min(options.timeoutMs ?? config.commandTimeoutMs, maxTimeoutMs);
  const maxOutputBytes = Math.min(options.maxOutputBytes ?? config.maxOutputBytes, 16 * 1024 * 1024);
  const started = Date.now();
  const childEnvironment: NodeJS.ProcessEnv = options.inheritEnv === false
    ? { ...(options.env ?? {}) }
    : { ...process.env, ...(options.env ?? {}) };
  if (logicalExecutable) childEnvironment.PATH = TRUSTED_SYSTEM_PATH;

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(resolvedArgv[0]!, resolvedArgv.slice(1), {
      cwd,
      env: childEnvironment,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });

    const stdout = new BoundedOutputCollector(maxOutputBytes);
    const stderr = new BoundedOutputCollector(maxOutputBytes);
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

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateProcessGroup(child.pid, 'SIGKILL');
      reject(error);
    };

    child.stdout.on('data', chunk => { stdout.append(chunk as Buffer); });
    child.stderr.on('data', chunk => { stderr.append(chunk as Buffer); });
    child.stdin.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') return;
      fail(error);
    });
    child.on('error', fail);
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        argv: resolvedArgv,
        cwd,
        exitCode,
        signal,
        stdout: stdout.render(),
        stderr: stderr.render(),
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
  try {
    await resolveRunExecutable(command);
    return true;
  } catch {
    return false;
  }
}
