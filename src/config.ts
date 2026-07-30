import os from 'node:os';
import path from 'node:path';
import type { AccessMode } from './types.js';

const home = os.homedir();

function intEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function modeEnv(): AccessMode {
  const value = process.env.MCP_MODE ?? 'workspace';
  if (value !== 'observe' && value !== 'workspace' && value !== 'full') {
    throw new Error('MCP_MODE must be observe, workspace, or full');
  }
  return value;
}

function pathList(value: string | undefined, fallback: string[]): string[] {
  const items = value ? value.split(':') : fallback;
  return [...new Set(items.map(item => path.resolve(item.replace(/^~(?=\/|$)/, home))).filter(Boolean))];
}

export const config = {
  host: process.env.MCP_HOST ?? '127.0.0.1',
  port: intEnv('MCP_PORT', 8787),
  mcpPath: process.env.MCP_PATH ?? '/mcp',
  mode: modeEnv(),
  allowedRoots: pathList(process.env.MCP_ALLOWED_ROOTS, [path.join(home, 'code'), path.join(home, 'Documents'), path.join(home, 'Downloads')]),
  allowSecrets: process.env.MCP_ALLOW_SECRETS === '1',
  authToken: process.env.MCP_AUTH_TOKEN || null,
  maxReadBytes: intEnv('MCP_MAX_READ_BYTES', 1_048_576),
  maxOutputBytes: intEnv('MCP_MAX_OUTPUT_BYTES', 262_144),
  commandTimeoutMs: intEnv('MCP_COMMAND_TIMEOUT_MS', 120_000),
  rateLimitPerMinute: intEnv('MCP_RATE_LIMIT_PER_MINUTE', 120),
  stateDir: path.resolve(process.env.MCP_STATE_DIR ?? path.join(home, '.local', 'state', 'mcp-free')),
  logLevel: process.env.MCP_LOG_LEVEL ?? 'info',
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
