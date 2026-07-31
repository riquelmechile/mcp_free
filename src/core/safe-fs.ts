import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { revalidateAllowedPath } from './paths.js';

function descriptorPath(handle: FileHandle): string {
  return `/proc/self/fd/${handle.fd}`;
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
      if (component === '' || component === '.' || component === '..' || component.includes('/')) {
        throw new Error(`Unsafe directory component: ${component}`);
      }
      const child = `${descriptorPath(handle)}/${component}`;
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
    const basename = path.basename(target);
    if (basename === '' || basename === '.' || basename === '..' || basename.includes('/')) throw new Error('Unsafe file basename');
    const anchored = `${descriptorPath(parent)}/${basename}`;
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

export async function renameAnchoredPath(source: string, destination: string): Promise<void> {
  const sourceParent = await openVerifiedDirectory(path.dirname(source), true);
  const destinationParent = await ensureAnchoredDirectory(path.dirname(destination));
  try {
    const sourceName = path.basename(source);
    const destinationName = path.basename(destination);
    const sourceAnchored = `${descriptorPath(sourceParent)}/${sourceName}`;
    const destinationAnchored = `${descriptorPath(destinationParent)}/${destinationName}`;
    const sourceMetadata = await fs.lstat(sourceAnchored);
    if (sourceMetadata.isSymbolicLink()) throw new Error('Moving symbolic links is blocked');
    if (sourceMetadata.isFile() && sourceMetadata.nlink !== 1) throw new Error('Moving files with multiple hard links is blocked');
    await revalidateAllowedPath(await fs.realpath(sourceAnchored), { mustExist: true, write: true });
    await fs.rename(sourceAnchored, destinationAnchored);
  } finally {
    await Promise.all([sourceParent.close(), destinationParent.close()]);
  }
}
