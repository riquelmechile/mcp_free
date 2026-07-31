import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const lockRoot = path.join(config.stateDir, 'orchestration-locks');
const processQueues = new Map<string, Promise<void>>();
const ownerToken = `${process.pid}-${crypto.randomBytes(12).toString('hex')}`;

function validateId(id: string): void {
  if (!/^orch_[a-f0-9]{24}$/.test(id)) throw new Error('Invalid orchestration_id');
}

function lockPath(id: string): string {
  validateId(id);
  return path.join(lockRoot, `${id}.lock`);
}

async function processIsAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function acquireFilesystemLock(id: string): Promise<() => Promise<void>> {
  const target = lockPath(id);
  const deadline = Date.now() + config.developmentTimeoutMs + 60_000;
  await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });

  while (true) {
    try {
      await fs.mkdir(target, { mode: 0o700 });
      const record = {
        schemaVersion: 1,
        orchestrationId: id,
        pid: process.pid,
        token: ownerToken,
        acquiredAt: new Date().toISOString()
      };
      await fs.writeFile(path.join(target, 'owner.json'), `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      });
      return async () => {
        try {
          const current = JSON.parse(await fs.readFile(path.join(target, 'owner.json'), 'utf8')) as Record<string, unknown>;
          if (current.token !== ownerToken || current.pid !== process.pid) {
            throw new Error(`Refusing to release orchestration lock ${id} owned by another process`);
          }
          await fs.rm(target, { recursive: true, force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const owner = JSON.parse(await fs.readFile(path.join(target, 'owner.json'), 'utf8')) as { pid?: number };
        stale = !(await processIsAlive(owner.pid ?? -1));
      } catch {
        const metadata = await fs.stat(target);
        stale = Date.now() - metadata.mtimeMs > config.developmentTimeoutMs + 60_000;
      }
      if (stale) {
        await fs.rm(target, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for orchestration lock ${id}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

export async function withOrchestrationLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
  validateId(id);
  const previous = processQueues.get(id) ?? Promise.resolve();
  let releaseQueue: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { releaseQueue = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  processQueues.set(id, queued);
  await previous.catch(() => undefined);

  let releaseFilesystem: (() => Promise<void>) | undefined;
  try {
    releaseFilesystem = await acquireFilesystemLock(id);
    return await operation();
  } finally {
    try {
      await releaseFilesystem?.();
    } finally {
      releaseQueue?.();
      if (processQueues.get(id) === queued) processQueues.delete(id);
    }
  }
}
