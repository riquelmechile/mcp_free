import fs from 'node:fs/promises';
import path from 'node:path';
import { config, sensitivePathFragments } from '../config.js';

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isSensitivePath(candidate: string): boolean {
  const normalized = `${path.resolve(candidate).replaceAll('\\', '/')}/`;
  return sensitivePathFragments.some(fragment => normalized.includes(fragment));
}

export async function resolveAllowedPath(input: string, options: { mustExist?: boolean; write?: boolean } = {}): Promise<string> {
  const expanded = input.replace(/^~(?=\/|$)/, config.home);
  const absolute = path.resolve(expanded);

  if (config.mode === 'observe' && options.write) {
    throw new Error('Write access is disabled in observe mode');
  }

  if (config.mode !== 'full' && !config.allowedRoots.some(root => within(absolute, root))) {
    throw new Error(`Path is outside MCP_ALLOWED_ROOTS: ${absolute}`);
  }

  if (!config.allowSecrets && isSensitivePath(absolute)) {
    throw new Error('Sensitive credential path is blocked. Set MCP_ALLOW_SECRETS=1 only in a controlled environment.');
  }

  if (options.mustExist) {
    await fs.access(absolute);
  }

  return absolute;
}

export function assertWorkspaceCwd(cwd: string): void {
  const absolute = path.resolve(cwd);
  if (config.mode === 'full') return;
  if (!config.allowedRoots.some(root => within(absolute, root))) {
    throw new Error(`Command cwd is outside MCP_ALLOWED_ROOTS: ${absolute}`);
  }
}
