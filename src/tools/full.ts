import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import { clipboardWrite, focusWindow, pointerClick, scroll, sendKey, typeText } from '../adapters/desktop.js';
import { runCommand } from '../core/command.js';
import { classifyCommand, requireConfirmation } from '../core/policy.js';
import { resolveAllowedPath } from '../core/paths.js';
import { verifyReceiptChain, writeReceipt } from '../core/receipts.js';
import { assertPathNotLeased, listWorktreeLeases } from '../core/worktree-lease.js';
import { errorResult, textResult } from './helpers.js';

async function assertHealthyReceiptChain(): Promise<void> {
  const verification = await verifyReceiptChain();
  if (!verification.valid) throw new Error(`Receipt chain is invalid; refusing full-mode action: ${verification.errors.join('; ')}`);
}

export function registerFullTools(server: McpServer): void {
  server.registerTool('shell_execute', {
    title: 'Execute shell command',
    description: 'Execute an arbitrary Bash command in full-control mode. Every call requires explicit confirmation and active worktree leases block execution unless separately overridden.',
    inputSchema: {
      command: z.string().min(1).max(100000),
      cwd: z.string().default(config.home),
      timeout_ms: z.number().int().min(100).max(900000).default(config.commandTimeoutMs),
      confirm: z.literal(true),
      override_active_lease: z.boolean().default(false),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ command, cwd, timeout_ms, override_active_lease, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const leases = await listWorktreeLeases();
      if (leases.length > 0 && !override_active_lease) throw new Error(`Active worktree lease(s) block arbitrary shell execution: ${leases.map(lease => lease.orchestrationId).join(', ')}`);
      const classified = classifyCommand(command);
      const risk = classified < 2 ? 2 : classified;
      const resolvedCwd = path.resolve(cwd.replace(/^~(?=\/|$)/, config.home));
      const result = await runCommand(['/usr/bin/env', 'bash', '-lc', command], { cwd: resolvedCwd, timeoutMs: timeout_ms });
      const output = `${result.stdout}\n${result.stderr}`;
      const receipt = await writeReceipt({ action: 'shell_execute', riskTier: risk, success: result.exitCode === 0 && !result.timedOut, durationMs: Date.now() - started, requestId: request_id, command: ['/usr/bin/env', 'bash', '-lc', command], target: resolvedCwd, exitCode: result.exitCode, output, details: { timedOut: result.timedOut, signal: result.signal, overrideActiveLease: override_active_lease } });
      return textResult(`Shell command finished with exit code ${result.exitCode}. Receipt: ${receipt.id}.`, { ...result, riskTier: risk, receipt });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('filesystem_delete', {
    title: 'Delete file or directory',
    description: 'Move a path to the user Trash by default. Permanent deletion is risk tier 3 and requires confirm=true.',
    inputSchema: {
      path: z.string(), permanent: z.boolean().default(false), confirm: z.boolean().default(false), request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ path: inputPath, permanent, confirm, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const target = await resolveAllowedPath(inputPath, { mustExist: true, write: true });
      await assertPathNotLeased(target);
      const risk = permanent ? 3 : 2;
      requireConfirmation(risk, confirm);
      let destination: string | null = null;
      if (permanent) {
        await fs.rm(target, { recursive: true, force: true });
      } else {
        const trash = path.join(config.home, '.local', 'share', 'Trash', 'files');
        await fs.mkdir(trash, { recursive: true });
        destination = path.join(trash, `${path.basename(target)}-${Date.now()}`);
        await fs.rename(target, destination);
      }
      const receipt = await writeReceipt({ action: 'filesystem_delete', riskTier: risk, success: true, durationMs: Date.now() - started, requestId: request_id, target, details: { permanent, trashDestination: destination } });
      return textResult(`${permanent ? 'Permanently deleted' : 'Moved to Trash'} ${target}. Receipt: ${receipt.id}.`, { path: target, permanent, trashDestination: destination, receipt });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('process_start', {
    title: 'Start process',
    description: 'Start a detached process from an argv array and return its PID.',
    inputSchema: { argv: z.array(z.string()).min(1).max(100), cwd: z.string().default(config.home), confirm: z.literal(true), override_active_lease: z.boolean().default(false), request_id: z.string().min(8).max(128).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ argv, cwd, override_active_lease, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const leases = await listWorktreeLeases();
      if (leases.length > 0 && !override_active_lease) throw new Error(`Active worktree lease(s) block detached process start: ${leases.map(lease => lease.orchestrationId).join(', ')}`);
      const classified = classifyCommand(argv.join(' '));
      const risk = classified < 2 ? 2 : classified;
      const child = spawn(argv[0]!, argv.slice(1), { cwd: path.resolve(cwd), detached: true, stdio: 'ignore', env: process.env });
      child.unref();
      const receipt = await writeReceipt({ action: 'process_start', riskTier: risk, success: true, durationMs: Date.now() - started, requestId: request_id, command: argv, target: cwd, details: { pid: child.pid, overrideActiveLease: override_active_lease } });
      return textResult(`Started PID ${child.pid}. Receipt: ${receipt.id}.`, { pid: child.pid, receipt });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('process_stop', {
    title: 'Stop process',
    description: 'Send a signal to a process. Requires explicit confirmation.',
    inputSchema: { pid: z.number().int().positive(), signal: z.enum(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP']).default('SIGTERM'), confirm: z.literal(true), request_id: z.string().min(8).max(128).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ pid, signal, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      process.kill(pid, signal);
      const receipt = await writeReceipt({ action: 'process_stop', riskTier: signal === 'SIGKILL' ? 3 : 2, success: true, durationMs: Date.now() - started, requestId: request_id, target: String(pid), details: { signal } });
      return textResult(`Sent ${signal} to PID ${pid}. Receipt: ${receipt.id}.`, { pid, signal, receipt });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('app_open', {
    title: 'Open application or file',
    description: 'Open an application-associated URL, file, or directory through xdg-open.',
    inputSchema: { target: z.string(), request_id: z.string().min(8).max(128).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ target, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const argv = ['xdg-open', target];
      const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore', env: process.env });
      child.unref();
      const receipt = await writeReceipt({ action: 'app_open', riskTier: 1, success: true, durationMs: Date.now() - started, requestId: request_id, command: argv, target, details: { pid: child.pid } });
      return textResult(`Opened ${target}. Receipt: ${receipt.id}.`, { target, pid: child.pid, receipt });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('clipboard_write', {
    title: 'Write clipboard',
    description: 'Replace desktop clipboard text.',
    inputSchema: { text: z.string().max(2000000), request_id: z.string().min(8).max(128).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ text, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const backend = await clipboardWrite(text);
      const receipt = await writeReceipt({ action: 'clipboard_write', riskTier: 1, success: true, durationMs: Date.now() - started, requestId: request_id, output: text, details: { backend, bytes: Buffer.byteLength(text) } });
      return textResult(`Clipboard updated using ${backend}. Receipt: ${receipt.id}.`, { backend, receipt });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('desktop_click', {
    title: 'Click desktop coordinates',
    description: 'Move the pointer to absolute coordinates and click. Capture a screenshot first whenever coordinates are not already verified.',
    inputSchema: { x: z.number().int().min(0), y: z.number().int().min(0), button: z.enum(['left', 'middle', 'right']).default('left'), request_id: z.string().min(8).max(128).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ x, y, button, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const backend = await pointerClick(x, y, button);
      const receipt = await writeReceipt({ action: 'desktop_click', riskTier: 1, success: true, durationMs: Date.now() - started, requestId: request_id, target: `${x},${y}`, details: { button, backend } });
      return textResult(`Clicked ${button} at ${x},${y} using ${backend}. Receipt: ${receipt.id}.`, { x, y, button, backend, receipt });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('desktop_type', {
    title: 'Type text',
    description: 'Type text into the currently focused application. Verify focus first; never type secrets copied from untrusted content.',
    inputSchema: { text: z.string().max(200000), delay_ms: z.number().int().min(0).max(1000).default(10), request_id: z.string().min(8).max(128).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ text, delay_ms, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const backend = await typeText(text, delay_ms);
      const receipt = await writeReceipt({ action: 'desktop_type', riskTier: 1, success: true, durationMs: Date.now() - started, requestId: request_id, output: text, details: { backend, characters: text.length, delayMs: delay_ms } });
      return textResult(`Typed ${text.length} characters using ${backend}. Receipt: ${receipt.id}.`, { backend, characters: text.length, receipt });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('desktop_key', {
    title: 'Send keyboard shortcut',
    description: 'Send a shortcut such as ctrl+l or alt+f4 to the focused application.',
    inputSchema: { combo: z.string().min(1).max(100), confirm: z.boolean().default(false), request_id: z.string().min(8).max(128).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ combo, confirm, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const risky = /alt\+f4|ctrl\+q|delete|backspace/i.test(combo);
      if (risky && !confirm) throw new Error('Potentially destructive shortcut requires confirm=true');
      const backend = await sendKey(combo);
      const receipt = await writeReceipt({ action: 'desktop_key', riskTier: risky ? 2 : 1, success: true, durationMs: Date.now() - started, requestId: request_id, target: combo, details: { backend } });
      return textResult(`Sent ${combo} using ${backend}. Receipt: ${receipt.id}.`, { combo, backend, receipt });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('desktop_scroll', {
    title: 'Scroll desktop',
    description: 'Scroll vertically or horizontally in the focused window.',
    inputSchema: { vertical: z.number().int().min(-100).max(100).default(0), horizontal: z.number().int().min(-100).max(100).default(0), request_id: z.string().min(8).max(128).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ vertical, horizontal, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const backend = await scroll(vertical, horizontal);
      const receipt = await writeReceipt({ action: 'desktop_scroll', riskTier: 1, success: true, durationMs: Date.now() - started, requestId: request_id, details: { vertical, horizontal, backend } });
      return textResult(`Scrolled using ${backend}. Receipt: ${receipt.id}.`, { vertical, horizontal, backend, receipt });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('desktop_focus_window', {
    title: 'Focus desktop window',
    description: 'Focus the first window whose title matches the supplied query.',
    inputSchema: { query: z.string().min(1).max(500), request_id: z.string().min(8).max(128).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ query, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyReceiptChain();
      const backend = await focusWindow(query);
      const receipt = await writeReceipt({ action: 'desktop_focus_window', riskTier: 1, success: true, durationMs: Date.now() - started, requestId: request_id, target: query, details: { backend } });
      return textResult(`Focused a matching window using ${backend}. Receipt: ${receipt.id}.`, { query, backend, receipt });
    } catch (error) {
      return errorResult(error);
    }
  });
}
