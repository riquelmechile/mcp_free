import crypto from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { revalidateAllowedPath } from './paths.js';

function descriptorPath(handle: FileHandle): string {
  return `/proc/self/fd/${handle.fd}`;
}

function anchoredChild(parent: FileHandle, name: string): string {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`Unsafe anchored path component: ${name}`);
  }
  return `${descriptorPath(parent)}/${name}`;
}

export interface AnchoredFileIdentity {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
}

function identityFromStat(metadata: Awaited<ReturnType<FileHandle['stat']>>): AnchoredFileIdentity {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs
  };
}

function sameIdentity(left: AnchoredFileIdentity, right: AnchoredFileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

async function writeAll(handle: FileHandle, content: string): Promise<void> {
  const buffer = Buffer.from(content, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
    if (bytesWritten <= 0) throw new Error('Failed to write an anchored temporary file');
    offset += bytesWritten;
  }
  await handle.sync();
}

export async function openedPhysicalPath(handle: FileHandle): Promise<string> {
  return fs.realpath(descriptorPath(handle));
}

export async function assertOpenedDescriptorAllowed(
  handle: FileHandle,
  options: { expectedPath?: string; write?: boolean; directory?: boolean } = {}
): Promise<string> {
  const metadata = await handle.stat();
  if (options.directory === true && !metadata.isDirectory()) throw new Error('Expected an opened directory');
  if (options.directory !== true && !metadata.isFile()) throw new Error('Expected an opened regular file');
  if (metadata.isFile() && metadata.nlink !== 1) {
    throw new Error('Files with multiple hard links are blocked because their other names may escape the allowed root');
  }
  const opened = await openedPhysicalPath(handle);
  if (options.expectedPath) {
    const expected = await fs.realpath(options.expectedPath);
    if (opened !== expected) throw new Error(`Opened descriptor no longer matches validated path: ${options.expectedPath}`);
  }
  await revalidateAllowedPath(opened, { mustExist: true, write: options.write === true });
  return opened;
}

export async function openVerifiedDirectory(directory: string, write = false): Promise<FileHandle> {
  await revalidateAllowedPath(directory, { mustExist: true, write });
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await assertOpenedDescriptorAllowed(handle, { expectedPath: directory, write, directory: true });
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function nearestExistingDirectory(directory: string): Promise<{ ancestor: string; missing: string[] }> {
  let cursor = directory;
  const missing: string[] = [];
  while (true) {
    try {
      const metadata = await fs.lstat(cursor);
      if (metadata.isSymbolicLink()) throw new Error(`Symbolic-link directory traversal is blocked: ${cursor}`);
      if (!metadata.isDirectory()) throw new Error(`Path component is not a directory: ${cursor}`);
      return { ancestor: cursor, missing };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`No existing directory ancestor found for ${directory}`);
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function ensureAnchoredDirectory(directory: string): Promise<FileHandle> {
  const { ancestor, missing } = await nearestExistingDirectory(directory);
  let handle = await openVerifiedDirectory(ancestor, true);
  try {
    for (const component of missing) {
      const child = anchoredChild(handle, component);
      try {
        await fs.mkdir(child, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const next = await fs.open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        await assertOpenedDescriptorAllowed(next, { write: true, directory: true });
      } catch (error) {
        await next.close();
        throw error;
      }
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function openAnchoredFile(
  target: string,
  flags: number,
  options: { mode?: number; createParents?: boolean; write?: boolean } = {}
): Promise<{ file: FileHandle; parent: FileHandle; physicalPath: string }> {
  const parentDirectory = path.dirname(target);
  const parent = options.createParents === true
    ? await ensureAnchoredDirectory(parentDirectory)
    : await openVerifiedDirectory(parentDirectory, options.write === true);
  try {
    const anchored = anchoredChild(parent, path.basename(target));
    const file = await fs.open(anchored, flags | constants.O_NOFOLLOW, options.mode ?? 0o600);
    try {
      const physicalPath = await assertOpenedDescriptorAllowed(file, { write: options.write === true });
      return { file, parent, physicalPath };
    } catch (error) {
      await file.close();
      throw error;
    }
  } catch (error) {
    await parent.close();
    throw error;
  }
}

export async function readAnchoredTextFile(target: string, writePolicy = false): Promise<{
  content: string;
  identity: AnchoredFileIdentity;
}> {
  const opened = await openAnchoredFile(target, constants.O_RDONLY, { write: writePolicy });
  try {
    const metadata = await opened.file.stat();
    return { content: await opened.file.readFile('utf8'), identity: identityFromStat(metadata) };
  } finally {
    await Promise.all([opened.file.close(), opened.parent.close()]);
  }
}

export async function writeAnchoredTextAtomic(
  target: string,
  content: string,
  options: {
    overwrite: boolean;
    createParents?: boolean;
    expectedIdentity?: AnchoredFileIdentity;
    mode?: number;
  }
): Promise<void> {
  const parent = options.createParents === true
    ? await ensureAnchoredDirectory(path.dirname(target))
    : await openVerifiedDirectory(path.dirname(target), true);
  const targetName = path.basename(target);
  const targetAnchored = anchoredChild(parent, targetName);
  const temporaryName = `.mcp-free-${process.pid}-${crypto.randomUUID()}.tmp`;
  const temporaryAnchored = anchoredChild(parent, temporaryName);
  let temporaryExists = false;
  try {
    let existingMode = options.mode ?? 0o600;
    try {
      const existing = await fs.open(targetAnchored, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await assertOpenedDescriptorAllowed(existing, { write: true });
        const metadata = await existing.stat();
        const identity = identityFromStat(metadata);
        if (options.expectedIdentity && !sameIdentity(identity, options.expectedIdentity)) {
          throw new Error('Target changed after it was read; refusing an unsafe atomic replacement');
        }
        existingMode = metadata.mode & 0o777;
      } finally {
        await existing.close();
      }
      if (!options.overwrite) throw new Error('Destination exists and overwrite=false');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (options.expectedIdentity) throw new Error('Target disappeared after it was read; refusing an unsafe atomic replacement');
    }

    const temporary = await fs.open(
      temporaryAnchored,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      existingMode
    );
    temporaryExists = true;
    try {
      await writeAll(temporary, content);
    } finally {
      await temporary.close();
    }

    if (options.expectedIdentity) {
      const current = await fs.open(targetAnchored, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await assertOpenedDescriptorAllowed(current, { write: true });
        const identity = identityFromStat(await current.stat());
        if (!sameIdentity(identity, options.expectedIdentity)) {
          throw new Error('Target changed while preparing the atomic replacement');
        }
      } finally {
        await current.close();
      }
    }

    if (options.overwrite) {
      await fs.rename(temporaryAnchored, targetAnchored);
      temporaryExists = false;
    } else {
      await fs.link(temporaryAnchored, targetAnchored);
      await fs.unlink(temporaryAnchored);
      temporaryExists = false;
    }
    await parent.sync();
  } finally {
    if (temporaryExists) {
      try { await fs.unlink(temporaryAnchored); } catch { /* Best-effort cleanup after a failed replacement. */ }
    }
    await parent.close();
  }
}

export async function renameAnchoredPath(source: string, destination: string): Promise<void> {
  const sourceParent = await openVerifiedDirectory(path.dirname(source), true);
  const destinationParent = await ensureAnchoredDirectory(path.dirname(destination));
  try {
    const sourceName = path.basename(source);
    const destinationName = path.basename(destination);
    const sourceAnchored = anchoredChild(sourceParent, sourceName);
    const destinationAnchored = anchoredChild(destinationParent, destinationName);
    const sourceMetadata = await fs.lstat(sourceAnchored);
    if (sourceMetadata.isSymbolicLink()) throw new Error('Moving symbolic links is blocked');
    if (sourceMetadata.isFile() && sourceMetadata.nlink !== 1) throw new Error('Moving files with multiple hard links is blocked');
    await revalidateAllowedPath(await fs.realpath(sourceAnchored), { mustExist: true, write: true });
    await fs.rename(sourceAnchored, destinationAnchored);
    await Promise.all([sourceParent.sync(), destinationParent.sync()]);
  } finally {
    await Promise.all([sourceParent.close(), destinationParent.close()]);
  }
}
