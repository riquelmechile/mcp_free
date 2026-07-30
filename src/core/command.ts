import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from '../config.js';
import type { CommandResult } from '../types.js';

function truncate(value: string): string {
  const bytes = Buffer.byteLength(value);
  if (bytes <= config.maxOutputBytes) return value;
  return `${value.slice(0, Math.max(0, config.maxOutputBytes - 200))}\n...[output truncated; ${bytes} bytes total]`;
}

export async function runCommand(
  argv: string[],
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; stdin?: string } = {}
): Promise<CommandResult> {
  if (argv.length === 0) throw new Error('argv must not be empty');
  const cwd = path.resolve(options.cwd ?? config.home);
  const timeoutMs = Math.min(options.timeoutMs ?? config.commandTimeoutMs, 15 * 60_000);
  const started = Date.now();

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        argv,
        cwd,
        exitCode,
        signal,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        timedOut,
        durationMs: Date.now() - started
      });
    });

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

export async function commandExists(command: string): Promise<boolean> {
  const result = await runCommand(['/usr/bin/env', 'bash', '-c', 'command -v -- "$1"', 'mcp-free', command], { timeoutMs: 5_000 });
  return result.exitCode === 0;
}
