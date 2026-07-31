import fs from 'node:fs/promises';
import path from 'node:path';
import { config, sensitivePathFragments } from '../config.js';

interface AllowedRoot {
  configured: string;
  physical: string;
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isSensitivePath(candidate: string): boolean {
  const normalized = `${path.resolve(candidate).replaceAll('\\', '/')}/`;
  return sensitivePathFragments.some(fragment => normalized.includes(fragment));
}

async function allowedRoots(): Promise<AllowedRoot[]> {
  const roots: AllowedRoot[] = [];
  for (const configuredValue of config.allowedRoots) {
    const configured = path.resolve(configuredValue);
    try {
      roots.push({ configured, physical: await fs.realpath(configured) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') roots.push({ configured, physical: configured });
      else throw error;
    }
  }
  return roots.filter((root, index, all) => all.findIndex(candidate => candidate.configured === root.configured && candidate.physical === root.physical) === index);
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let cursor = candidate;
  while (true) {
    try {
      await fs.lstat(cursor);
      return cursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`No existing ancestor found for ${candidate}`);
      cursor = parent;
    }
  }
}

async function assertNoSymlinkComponents(candidate: string, configuredRoot: string): Promise<void> {
  const relative = path.relative(configuredRoot, candidate);
  if (relative === '') return;
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Path escapes configured root: ${candidate}`);
  let cursor = configuredRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      const metadata = await fs.lstat(cursor);
      if (metadata.isSymbolicLink()) throw new Error(`Symbolic-link traversal is blocked: ${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function matchLexicalRoot(absolute: string, roots: AllowedRoot[]): AllowedRoot | undefined {
  return roots.find(root => within(absolute, root.configured) || within(absolute, root.physical));
}

function matchPhysicalRoot(absolute: string, roots: AllowedRoot[]): AllowedRoot | undefined {
  return roots.find(root => within(absolute, root.physical));
}

async function assertPhysicalPolicy(absolute: string, options: { mustExist?: boolean; write?: boolean }): Promise<void> {
  const roots = await allowedRoots();
  const lexicalRoot = matchLexicalRoot(absolute, roots);
  if (config.mode !== 'full' && !lexicalRoot) throw new Error(`Path is outside MCP_ALLOWED_ROOTS: ${absolute}`);

  const ancestor = await nearestExistingAncestor(absolute);
  const realAncestor = await fs.realpath(ancestor);
  const physicalRoot = matchPhysicalRoot(realAncestor, roots);
  if (config.mode !== 'full' && !physicalRoot) throw new Error(`Path resolves outside MCP_ALLOWED_ROOTS: ${absolute}`);

  if (lexicalRoot && within(absolute, lexicalRoot.configured)) {
    await assertNoSymlinkComponents(ancestor, lexicalRoot.configured);
  } else if (physicalRoot) {
    await assertNoSymlinkComponents(ancestor, physicalRoot.physical);
  }

  if (!config.allowSecrets && (isSensitivePath(absolute) || isSensitivePath(realAncestor))) {
    throw new Error('Sensitive credential path is blocked. Set MCP_ALLOW_SECRETS=1 only in a controlled environment.');
  }

  if (options.mustExist) {
    const metadata = await fs.lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`Symbolic-link targets are blocked: ${absolute}`);
    const realTarget = await fs.realpath(absolute);
    if (config.mode !== 'full' && !matchPhysicalRoot(realTarget, roots)) throw new Error(`Path resolves outside MCP_ALLOWED_ROOTS: ${absolute}`);
    if (!config.allowSecrets && isSensitivePath(realTarget)) {
      throw new Error('Sensitive credential path is blocked. Set MCP_ALLOW_SECRETS=1 only in a controlled environment.');
    }
  } else if (options.write) {
    const parent = path.dirname(absolute);
    const existingParent = await nearestExistingAncestor(parent);
    const realParent = await fs.realpath(existingParent);
    if (config.mode !== 'full' && !matchPhysicalRoot(realParent, roots)) throw new Error(`Write parent resolves outside MCP_ALLOWED_ROOTS: ${absolute}`);
  }
}

export async function resolveAllowedPath(input: string, options: { mustExist?: boolean; write?: boolean } = {}): Promise<string> {
  const expanded = input.replace(/^~(?=\/|$)/, config.home);
  const absolute = path.resolve(expanded);
  if (config.mode === 'observe' && options.write) throw new Error('Write access is disabled in observe mode');
  await assertPhysicalPolicy(absolute, options);
  return absolute;
}

export async function revalidateAllowedPath(absolute: string, options: { mustExist?: boolean; write?: boolean } = {}): Promise<string> {
  return resolveAllowedPath(absolute, options);
}

export function assertWorkspaceCwd(cwd: string): void {
  const absolute = path.resolve(cwd);
  if (config.mode === 'full') return;
  if (!config.allowedRoots.some(root => within(absolute, path.resolve(root)))) throw new Error(`Command cwd is outside MCP_ALLOWED_ROOTS: ${absolute}`);
}
