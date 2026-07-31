import { readlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import type { CommandResult } from '../types.js';
import { runCommand } from './command.js';
import { resolveTrustedExecutable } from './command-policy.js';

export interface SandboxCommandOptions {
  writable: boolean;
  network?: boolean;
  timeoutMs: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  stdin?: string;
}

function hostLinkTarget(link: string, fallback: string): string {
  try { return readlinkSync(link); } catch { return fallback; }
}

const HOST_ENVIRONMENT: Record<string, string> = {
  PATH: '/usr/bin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  NO_COLOR: '1'
};

export function buildSandboxArgv(
  bwrap: string,
  root: string,
  command: string[],
  options: Pick<SandboxCommandOptions, 'writable' | 'network'>
): string[] {
  const argv = [
    bwrap,
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc'
  ];
  if (options.network !== true && !config.sandboxCiSharedNetwork) argv.push('--unshare-net');
  argv.push(
    '--clearenv',
    '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr',
    '--symlink', hostLinkTarget('/bin', 'usr/bin'), '/bin',
    '--symlink', hostLinkTarget('/lib', 'usr/lib'), '/lib',
    '--symlink', hostLinkTarget('/lib64', 'usr/lib64'), '/lib64',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--dir', '/tmp/home',
    options.writable ? '--bind' : '--ro-bind', root, '/workspace',
    '--chdir', '/workspace',
    '--setenv', 'PATH', '/usr/bin:/bin',
    '--setenv', 'HOME', '/tmp/home',
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'LANG', 'C',
    '--setenv', 'LC_ALL', 'C',
    '--setenv', 'NO_COLOR', '1',
    '--setenv', 'CI', '1',
    '--setenv', 'GIT_CONFIG_GLOBAL', '/dev/null',
    '--setenv', 'GIT_CONFIG_NOSYSTEM', '1',
    '--setenv', 'GIT_OPTIONAL_LOCKS', '0',
    '--setenv', 'GIT_PAGER', 'cat',
    '--setenv', 'PAGER', 'cat',
    '--setenv', 'RIPGREP_CONFIG_PATH', '/dev/null',
    '--',
    ...command
  );
  return argv;
}

async function sandboxSupported(bwrap: string): Promise<void> {
  const metadata = await fs.stat(bwrap);
  if (!metadata.isFile()) throw new Error('Bubblewrap is not a regular file');
}

async function runSandboxed(
  root: string,
  command: string[],
  options: SandboxCommandOptions
): Promise<CommandResult> {
  const realRoot = await fs.realpath(root);
  if (config.sandboxCiBypass) {
    return runCommand(command, {
      cwd: realRoot,
      timeoutMs: options.timeoutMs,
      ...(options.maxTimeoutMs !== undefined ? { maxTimeoutMs: options.maxTimeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      inheritEnv: false,
      env: HOST_ENVIRONMENT
    });
  }

  if (!config.verificationSandbox) {
    if (config.mode !== 'full') throw new Error('Sandbox bypass is available only in full mode');
    return runCommand(command, {
      cwd: realRoot,
      timeoutMs: options.timeoutMs,
      ...(options.maxTimeoutMs !== undefined ? { maxTimeoutMs: options.maxTimeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      inheritEnv: false,
      env: HOST_ENVIRONMENT
    });
  }

  const bwrap = await resolveTrustedExecutable('bwrap');
  await sandboxSupported(bwrap);
  const sandboxArgv = buildSandboxArgv(bwrap, realRoot, command, {
    writable: options.writable,
    network: options.network === true
  });
  const result = await runCommand(sandboxArgv, {
    cwd: realRoot,
    timeoutMs: options.timeoutMs,
    ...(options.maxTimeoutMs !== undefined ? { maxTimeoutMs: options.maxTimeoutMs } : {}),
    ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    inheritEnv: false,
    env: HOST_ENVIRONMENT
  });
  return { ...result, argv: command, cwd: realRoot };
}

export function runInspectionCommand(
  root: string,
  command: string[],
  options: Omit<SandboxCommandOptions, 'writable' | 'network'>
): Promise<CommandResult> {
  return runSandboxed(root, command, { ...options, writable: false, network: false });
}

export function runVerificationCommand(
  root: string,
  command: string[],
  options: Omit<SandboxCommandOptions, 'writable' | 'network'>
): Promise<CommandResult> {
  return runSandboxed(root, command, {
    ...options,
    writable: true,
    network: config.verificationNetwork
  });
}
