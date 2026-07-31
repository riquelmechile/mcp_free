import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { classifyFileAction, requireConfirmation } from '../core/policy.js';
import { revalidateAllowedPath, resolveAllowedPath } from '../core/paths.js';
import { verifyReceiptChain, writeReceipt } from '../core/receipts.js';
import { assertPathNotLeased } from '../core/worktree-lease.js';
import { errorResult, textResult } from './helpers.js';

async function assertHealthyReceiptChain(): Promise<void> {
  const verification = await verifyReceiptChain();
  if (!verification.valid) throw new Error(`Receipt chain is invalid; refusing workspace write: ${verification.errors.join('; ')}`);
}

async function assertOpenedPathMatches(target: string, fd: number): Promise<void> {
  const [opened, expected] = await Promise.all([
    fs.realpath(`/proc/self/fd/${fd}`),
    fs.realpath(target)
  ]);
  if (opened !== expected) throw new Error(`Opened file no longer matches validated path: ${target}`);
  await revalidateAllowedPath(target, { mustExist: true, write: true });
}

export async function writeFileNoFollow(target: string, content: string, overwrite: boolean): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
    | (overwrite ? 0 : constants.O_EXCL);
  const handle = await fs.open(target, flags, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('filesystem_write requires a regular file');
    await assertOpenedPathMatches(target, handle.fd);
    if (overwrite) await handle.truncate(0);
    const buffer = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
      if (bytesWritten <= 0) throw new Error(`Failed to write bytes to ${target}`);
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function patchFileNoFollow(target: string, expected: string, replacement: string): Promise<{ original: string; updated: string }> {
  const handle = await fs.open(target, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('filesystem_patch requires a regular file');
    await assertOpenedPathMatches(target, handle.fd);
    const original = await handle.readFile('utf8');
    const matches = original.split(expected).length - 1;
    if (matches !== 1) throw new Error(`Expected text must occur exactly once; found ${matches} matches`);
    const updated = original.replace(expected, replacement);
    await revalidateAllowedPath(target, { mustExist: true, write: true });
    await handle.truncate(0);
    const buffer = Buffer.from(updated, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
      if (bytesWritten <= 0) throw new Error(`Failed to write patched bytes to ${target}`);
      offset += bytesWritten;
    }
    await handle.sync();
    return { original, updated };
  } finally {
    await handle.close();
  }
}

export async function renameAnchored(from: string, to: string): Promise<void> {
  const [fromParent, toParent] = await Promise.all([
    fs.realpath(path.dirname(from)),
    fs.realpath(path.dirname(to))
  ]);
  const [fromHandle, toHandle] = await Promise.all([
    fs.open(fromParent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
    fs.open(toParent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  ]);
  try {
    await Promise.all([
      revalidateAllowedPath(from, { mustExist: true, write: true }),
      revalidateAllowedPath(to, { write: true })
    ]);
    const source = `/proc/self/fd/${fromHandle.fd}/${path.basename(from)}`;
    const destination = `/proc/self/fd/${toHandle.fd}/${path.basename(to)}`;
    await fs.rename(source, destination);
  } finally {
    await Promise.all([fromHandle.close(), toHandle.close()]);
  }
}

export function registerWorkspaceTools(server: McpServer): void {
  server.registerTool('filesystem_write', {
    title: 'Write file',
    description: 'Create or replace one UTF-8 file inside a physical allowed root. Symbolic-link traversal and paths protected by an active development orchestration are rejected.',
    inputSchema: {
      path: z.string(),
      content: z.string(),
      overwrite: z.boolean().default(false),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ path: inputPath, content, overwrite, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const target = await resolveAllowedPath(inputPath, { write: true });
      await assertPathNotLeased(target);
      const risk = classifyFileAction('write', target);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await revalidateAllowedPath(target, { write: true });
      await writeFileNoFollow(target, content, overwrite);
      const receipt = await writeReceipt({
        action: 'filesystem_write',
        riskTier: risk,
        success: true,
        durationMs: Date.now() - started,
        requestId: request_id,
        target,
        output: content,
        details: { bytesWritten: Buffer.byteLength(content), overwrite, noFollow: true }
      });
      return textResult(`Wrote ${Buffer.byteLength(content)} bytes to ${target}. Receipt: ${receipt.id}.`, { path: target, bytesWritten: Buffer.byteLength(content), receipt });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('filesystem_patch', {
    title: 'Patch file',
    description: 'Replace one exact text occurrence in a regular UTF-8 file. Refuses ambiguous matches, symlinks, and active worktree leases.',
    inputSchema: {
      path: z.string(),
      expected: z.string().min(1),
      replacement: z.string(),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ path: inputPath, expected, replacement, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const target = await resolveAllowedPath(inputPath, { mustExist: true, write: true });
      await assertPathNotLeased(target);
      const { original, updated } = await patchFileNoFollow(target, expected, replacement);
      const receipt = await writeReceipt({
        action: 'filesystem_patch',
        riskTier: 1,
        success: true,
        durationMs: Date.now() - started,
        requestId: request_id,
        target,
        output: updated,
        details: { beforeBytes: Buffer.byteLength(original), afterBytes: Buffer.byteLength(updated), noFollow: true }
      });
      return textResult(`Patched ${target}. Receipt: ${receipt.id}.`, { path: target, receipt });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('filesystem_move', {
    title: 'Move file or directory',
    description: 'Move a non-symlink file or directory between physical allowed paths. Active development worktree leases are respected.',
    inputSchema: {
      source: z.string(),
      destination: z.string(),
      replace: z.boolean().default(false),
      confirm: z.boolean().default(false),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ source, destination, replace, confirm, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const from = await resolveAllowedPath(source, { mustExist: true, write: true });
      const to = await resolveAllowedPath(destination, { write: true });
      await Promise.all([assertPathNotLeased(from), assertPathNotLeased(to)]);
      let exists = false;
      try {
        await fs.lstat(to);
        await revalidateAllowedPath(to, { mustExist: true, write: true });
        exists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const risk = exists ? 2 : 1;
      requireConfirmation(risk, confirm);
      if (exists && !replace) throw new Error('Destination exists; set replace=true after approval');
      await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      await renameAnchored(from, to);
      const receipt = await writeReceipt({
        action: 'filesystem_move',
        riskTier: risk,
        success: true,
        durationMs: Date.now() - started,
        requestId: request_id,
        target: `${from} -> ${to}`,
        details: { replace }
      });
      return textResult(`Moved ${from} to ${to}. Receipt: ${receipt.id}.`, { source: from, destination: to, receipt });
    } catch (error) {
      return errorResult(error);
    }
  });
}
