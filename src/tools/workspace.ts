import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { classifyFileAction, requireConfirmation } from '../core/policy.js';
import { resolveAllowedPath } from '../core/paths.js';
import { verifyReceiptChain, writeReceipt } from '../core/receipts.js';
import { ensureAnchoredDirectory, openAnchoredFile, renameAnchoredPath } from '../core/safe-fs.js';
import { assertPathNotLeased } from '../core/worktree-lease.js';
import { errorResult, textResult } from './helpers.js';

async function assertHealthyReceiptChain(): Promise<void> {
  const verification = await verifyReceiptChain();
  if (!verification.valid) throw new Error(`Receipt chain is invalid; refusing workspace write: ${verification.errors.join('; ')}`);
}

export async function writeFileNoFollow(target: string, content: string, overwrite: boolean): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | (overwrite ? 0 : constants.O_EXCL);
  const opened = await openAnchoredFile(target, flags, { mode: 0o600, createParents: true, write: true });
  try {
    if (overwrite) await opened.file.truncate(0);
    const buffer = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await opened.file.write(buffer, offset, buffer.length - offset, offset);
      if (bytesWritten <= 0) throw new Error(`Failed to write bytes to ${target}`);
      offset += bytesWritten;
    }
    await opened.file.sync();
  } finally {
    await Promise.all([opened.file.close(), opened.parent.close()]);
  }
}

export async function patchFileNoFollow(target: string, expected: string, replacement: string): Promise<{ original: string; updated: string }> {
  const opened = await openAnchoredFile(target, constants.O_RDWR, { write: true });
  try {
    const original = await opened.file.readFile('utf8');
    const matches = original.split(expected).length - 1;
    if (matches !== 1) throw new Error(`Expected text must occur exactly once; found ${matches} matches`);
    const updated = original.replace(expected, replacement);
    await opened.file.truncate(0);
    const buffer = Buffer.from(updated, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await opened.file.write(buffer, offset, buffer.length - offset, offset);
      if (bytesWritten <= 0) throw new Error(`Failed to write patched bytes to ${target}`);
      offset += bytesWritten;
    }
    await opened.file.sync();
    return { original, updated };
  } finally {
    await Promise.all([opened.file.close(), opened.parent.close()]);
  }
}

export async function renameAnchored(from: string, to: string): Promise<void> {
  await renameAnchoredPath(from, to);
}

export function registerWorkspaceTools(server: McpServer): void {
  server.registerTool('filesystem_write', {
    title: 'Write file',
    description: 'Create or replace one UTF-8 file through descriptor-anchored, no-follow operations inside a physical allowed root.',
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
      await writeFileNoFollow(target, content, overwrite);
      const receipt = await writeReceipt({
        action: 'filesystem_write', riskTier: risk, success: true, durationMs: Date.now() - started,
        requestId: request_id, target, output: content,
        details: { bytesWritten: Buffer.byteLength(content), overwrite, descriptorAnchored: true, noFollow: true }
      });
      return textResult(`Wrote ${Buffer.byteLength(content)} bytes to ${target}. Receipt: ${receipt.id}.`, { path: target, bytesWritten: Buffer.byteLength(content), receipt });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool('filesystem_mkdir', {
    title: 'Create directory',
    description: 'Create one directory path component-by-component through verified directory descriptors.',
    inputSchema: { path: z.string(), request_id: z.string().min(8).max(128).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ path: inputPath, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const target = await resolveAllowedPath(inputPath, { write: true });
      await assertPathNotLeased(target);
      const handle = await ensureAnchoredDirectory(target);
      await handle.close();
      const receipt = await writeReceipt({ action: 'filesystem_mkdir', riskTier: 1, success: true, durationMs: Date.now() - started, requestId: request_id, target, details: { descriptorAnchored: true } });
      return textResult(`Created directory ${target}. Receipt: ${receipt.id}.`, { path: target, receipt });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool('filesystem_patch', {
    title: 'Patch file',
    description: 'Replace one exact occurrence in a regular UTF-8 file opened relative to a verified parent descriptor.',
    inputSchema: {
      path: z.string(), expected: z.string().min(1), replacement: z.string(),
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
        action: 'filesystem_patch', riskTier: 1, success: true, durationMs: Date.now() - started,
        requestId: request_id, target, output: updated,
        details: { beforeBytes: Buffer.byteLength(original), afterBytes: Buffer.byteLength(updated), descriptorAnchored: true, noFollow: true }
      });
      return textResult(`Patched ${target}. Receipt: ${receipt.id}.`, { path: target, receipt });
    } catch (error) { return errorResult(error); }
  });

  server.registerTool('filesystem_move', {
    title: 'Move file or directory',
    description: 'Move a non-symlink entry between descriptor-anchored allowed directories. Every move requires explicit confirmation.',
    inputSchema: {
      source: z.string(), destination: z.string(), replace: z.boolean().default(false),
      confirm: z.literal(true), request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ source, destination, replace, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const from = await resolveAllowedPath(source, { mustExist: true, write: true });
      const to = await resolveAllowedPath(destination, { write: true });
      await Promise.all([assertPathNotLeased(from), assertPathNotLeased(to)]);
      requireConfirmation(2, true);
      try {
        await fs.lstat(to);
        if (!replace) throw new Error('Destination exists; set replace=true after reviewing it');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await renameAnchored(from, to);
      const receipt = await writeReceipt({
        action: 'filesystem_move', riskTier: 2, success: true, durationMs: Date.now() - started,
        requestId: request_id, target: `${from} -> ${to}`, details: { replace, descriptorAnchored: true }
      });
      return textResult(`Moved ${from} to ${to}. Receipt: ${receipt.id}.`, { source: from, destination: to, receipt });
    } catch (error) { return errorResult(error); }
  });
}
