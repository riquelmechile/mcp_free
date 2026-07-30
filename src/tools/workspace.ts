import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import { runCommand } from '../core/command.js';
import { classifyFileAction, requireConfirmation } from '../core/policy.js';
import { assertWorkspaceCwd, resolveAllowedPath } from '../core/paths.js';
import { writeReceipt } from '../core/receipts.js';
import { errorResult, textResult } from './helpers.js';

const WORKSPACE_COMMANDS = new Set([
  'git', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'tsx', 'tsc', 'python', 'python3', 'pytest',
  'go', 'cargo', 'rustc', 'make', 'cmake', 'ninja', 'rg', 'fd', 'find', 'ls', 'cat', 'sed',
  'grep', 'head', 'tail', 'wc', 'jq', 'curl'
]);

const CODING_AGENT_EXECUTABLES = new Set(['opencode', 'codex', 'claude', 'gemini']);

export function registerWorkspaceTools(server: McpServer): void {
  server.registerTool('filesystem_write', {
    title: 'Write file',
    description: 'Create or replace a UTF-8 file inside an allowed root. Produces an execution receipt bound to the written bytes.',
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
      const target = await resolveAllowedPath(inputPath, { write: true });
      const risk = classifyFileAction('write', target);
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (!overwrite) {
        try { await fs.access(target); throw new Error('File exists; set overwrite=true to replace it'); } catch (error) {
          if (error instanceof Error && error.message.startsWith('File exists')) throw error;
        }
      }
      await fs.writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
      const receipt = await writeReceipt({ action: 'filesystem_write', riskTier: risk, success: true, durationMs: Date.now() - started, requestId: request_id, target, output: content, details: { bytesWritten: Buffer.byteLength(content), overwrite } });
      return textResult(`Wrote ${Buffer.byteLength(content)} bytes to ${target}. Receipt: ${receipt.id}.`, { path: target, bytesWritten: Buffer.byteLength(content), receipt });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('filesystem_patch', {
    title: 'Patch file',
    description: 'Replace one exact text occurrence in a UTF-8 file. Refuses ambiguous matches and produces an execution receipt.',
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
      const target = await resolveAllowedPath(inputPath, { mustExist: true, write: true });
      const original = await fs.readFile(target, 'utf8');
      const matches = original.split(expected).length - 1;
      if (matches !== 1) throw new Error(`Expected text must occur exactly once; found ${matches} matches`);
      const updated = original.replace(expected, replacement);
      await fs.writeFile(target, updated, 'utf8');
      const receipt = await writeReceipt({ action: 'filesystem_patch', riskTier: 1, success: true, durationMs: Date.now() - started, requestId: request_id, target, output: updated, details: { beforeBytes: Buffer.byteLength(original), afterBytes: Buffer.byteLength(updated) } });
      return textResult(`Patched ${target}. Receipt: ${receipt.id}.`, { path: target, receipt });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('filesystem_move', {
    title: 'Move file or directory',
    description: 'Move a file or directory between allowed paths. Requires confirmation when replacing an existing destination.',
    inputSchema: {
      source: z.string(), destination: z.string(), replace: z.boolean().default(false), confirm: z.boolean().default(false), request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ source, destination, replace, confirm, request_id }) => {
    const started = Date.now();
    try {
      const from = await resolveAllowedPath(source, { mustExist: true, write: true });
      const to = await resolveAllowedPath(destination, { write: true });
      let exists = false;
      try { await fs.access(to); exists = true; } catch { exists = false; }
      const risk = exists ? 2 : 1;
      requireConfirmation(risk, confirm);
      if (exists && !replace) throw new Error('Destination exists; set replace=true after approval');
      if (exists) await fs.rm(to, { recursive: true, force: true });
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
      const receipt = await writeReceipt({ action: 'filesystem_move', riskTier: risk, success: true, durationMs: Date.now() - started, requestId: request_id, target: `${from} -> ${to}`, details: { replace } });
      return textResult(`Moved ${from} to ${to}. Receipt: ${receipt.id}.`, { source: from, destination: to, receipt });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('workspace_execute', {
    title: 'Run workspace command',
    description: 'Execute an argv array without a shell inside an allowed project root. ChatGPT remains the sole reasoning model; external coding agents are blocked.',
    inputSchema: {
      argv: z.array(z.string()).min(1).max(100),
      cwd: z.string(),
      timeout_ms: z.number().int().min(100).max(900000).default(config.commandTimeoutMs),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ argv, cwd, timeout_ms, request_id }) => {
    const started = Date.now();
    try {
      const executable = path.basename(argv[0]!);
      if (CODING_AGENT_EXECUTABLES.has(executable)) {
        throw new Error(`${executable} is blocked because ChatGPT must perform the reasoning through the native development orchestration tools instead of launching another model.`);
      }
      if (!WORKSPACE_COMMANDS.has(executable)) throw new Error(`Executable is not allowed in workspace mode: ${executable}`);
      const resolvedCwd = await resolveAllowedPath(cwd, { mustExist: true });
      assertWorkspaceCwd(resolvedCwd);
      const result = await runCommand(argv, { cwd: resolvedCwd, timeoutMs: timeout_ms });
      const output = `${result.stdout}\n${result.stderr}`;
      const receipt = await writeReceipt({ action: 'workspace_execute', riskTier: 1, success: result.exitCode === 0 && !result.timedOut, durationMs: Date.now() - started, requestId: request_id, command: argv, target: resolvedCwd, exitCode: result.exitCode, output, details: { timedOut: result.timedOut, signal: result.signal } });
      return textResult(`Command finished with exit code ${result.exitCode}. Receipt: ${receipt.id}.`, { ...result, receipt });
    } catch (error) {
      return errorResult(error);
    }
  });
}
