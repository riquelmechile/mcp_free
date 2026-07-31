import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import {
  abortOrchestration,
  applyOrchestrationPatch,
  cleanupOrchestrations,
  createOrchestration,
  detectVerificationCommands,
  finalizeOrchestration,
  inspectProjectDevelopment,
  listOrchestrations,
  loadOrchestration,
  recordLaneReport,
  validateVerificationCommand,
  verifyOrchestration
} from '../core/development.js';
import {
  assertAllLanesCompleted,
  cancelLaneWorkers,
  enqueueParallelInspection,
  getCoordinatorState,
  getLaneWorker,
  materializeLaneInspection,
  requireLaneCompleted,
  resumeLaneWorkers,
  summarizeCoordinator,
  waitForCoordinatorChange
} from '../core/lane-coordinator.js';
import { assertWorkspaceCwd, resolveAllowedPath } from '../core/paths.js';
import { requireConfirmation } from '../core/policy.js';
import { verifyReceiptChain, writeReceipt } from '../core/receipts.js';
import { assertVerifiedWorktreeUnchanged, readVerifiedWorktreeFingerprint } from '../core/worktree-fingerprint.js';
import { errorResult, textResult } from './helpers.js';

async function assertHealthyAuditChain(): Promise<void> {
  const verification = await verifyReceiptChain();
  if (!verification.valid) throw new Error(`Receipt chain is invalid; refusing to mutate orchestration state: ${verification.errors.join('; ')}`);
}

export function registerDevelopmentTools(server: McpServer, options: { allowExecute: boolean }): void {
  server.registerTool('development_status', {
    title: 'Inspect ChatGPT-native development readiness',
    description: 'Inspect a Git project and return local context, existing changes, verification commands, and the hardened persistent orchestration contract.',
    inputSchema: { cwd: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ cwd }) => {
    try {
      const resolvedCwd = await resolveAllowedPath(cwd, { mustExist: true });
      assertWorkspaceCwd(resolvedCwd);
      const state = await inspectProjectDevelopment(resolvedCwd);
      return textResult(`ChatGPT-native orchestration is ready in ${state.root}. Arbitrary workspace execution is disabled.`, state as unknown as Record<string, unknown>);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_orchestration_list', {
    title: 'List development orchestrations',
    description: 'List recent persisted orchestrations so ChatGPT can recover an orchestration ID after reconnecting or changing conversations.',
    inputSchema: { limit: z.number().int().min(1).max(200).default(50) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ limit }) => {
    try {
      const states = await listOrchestrations(limit);
      return textResult(`Found ${states.length} persisted orchestration(s).`, {
        orchestrations: states.map(state => ({
          id: state.id,
          root: state.root,
          objective: state.objective,
          status: state.status,
          updatedAt: state.updatedAt,
          laneCount: state.lanes.length
        }))
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_orchestration_status', {
    title: 'Read persistent development orchestration state',
    description: 'Read central state plus a verified coordinator snapshot. Reconciliation may persist an interrupted terminal state after a service restart.',
    inputSchema: { orchestration_id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ orchestration_id }) => {
    try {
      const coordinator = await getCoordinatorState(orchestration_id);
      const orchestration = await loadOrchestration(orchestration_id);
      const summary = summarizeCoordinator(coordinator);
      return textResult(`Orchestration ${orchestration.id} is ${orchestration.status}; coordinator is ${summary.status} at revision ${summary.revision}.`, {
        orchestration,
        coordinator: summary
      } as unknown as Record<string, unknown>);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_orchestration_wait', {
    title: 'Wait for the next lane coordinator change',
    description: 'Long-poll for at most 30 seconds. Worker process groups continue independently and terminal evidence is verified against the receipt chain.',
    inputSchema: {
      orchestration_id: z.string(),
      after_revision: z.number().int().min(0).default(0),
      wait_ms: z.number().int().min(0).max(30_000).default(15_000)
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ orchestration_id, after_revision, wait_ms }) => {
    try {
      const coordinator = await waitForCoordinatorChange(orchestration_id, after_revision, wait_ms);
      const summary = summarizeCoordinator(coordinator);
      return textResult(`Lane coordinator revision is ${summary.revision}; status is ${summary.status}.`, summary as unknown as Record<string, unknown>);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_lane_result', {
    title: 'Read one evidence-bound lane result',
    description: 'Read persisted progress and outputs. Terminal lanes are accepted only when their evidence hash matches a hash-chained terminal receipt.',
    inputSchema: {
      orchestration_id: z.string(),
      lane_id: z.string(),
      command_index: z.number().int().min(0).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ orchestration_id, lane_id, command_index }) => {
    try {
      const lane = await getLaneWorker(orchestration_id, lane_id);
      if (command_index !== undefined) {
        const result = lane.results[command_index];
        if (!result) throw new Error(`No result exists at command_index ${command_index}; available results: ${lane.results.length}`);
        return textResult(`Lane ${lane_id} command ${command_index + 1}/${lane.totalCommands} is available.`, {
          laneId: lane.laneId,
          status: lane.status,
          commandIndex: command_index,
          evidenceSha256: lane.evidenceSha256 ?? null,
          terminalReceiptId: lane.terminalReceiptId ?? null,
          result
        } as unknown as Record<string, unknown>);
      }
      return textResult(`Lane ${lane_id} is ${lane.status} with ${lane.results.length}/${lane.totalCommands} command result(s).`, lane as unknown as Record<string, unknown>);
    } catch (error) {
      return errorResult(error);
    }
  });

  if (!options.allowExecute) return;

  server.registerTool('development_orchestration_start', {
    title: 'Start ChatGPT development orchestration',
    description: 'Freeze the Git baseline and create one to three logical lanes. No external model or generic workspace command runner is launched.',
    inputSchema: {
      cwd: z.string(),
      objective: z.string().min(10).max(30_000),
      lane_count: z.number().int().min(1).max(3).default(3),
      use_sdd: z.boolean().default(false),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ cwd, objective, lane_count, use_sdd, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyAuditChain();
      const resolvedCwd = await resolveAllowedPath(cwd, { mustExist: true });
      assertWorkspaceCwd(resolvedCwd);
      const state = await createOrchestration({ cwd: resolvedCwd, objective, laneCount: lane_count, useSdd: use_sdd });
      const receipt = await writeReceipt({
        action: 'development_orchestration_start',
        riskTier: 1,
        success: true,
        durationMs: Date.now() - started,
        requestId: request_id,
        target: state.root,
        output: JSON.stringify(state),
        details: { orchestrationId: state.id, laneCount: state.lanes.length, useSdd: use_sdd, reasoningModel: 'ChatGPT', externalModels: false }
      });
      return textResult(`Started ${state.id} with ${state.lanes.length} logical lane(s). Receipt: ${receipt.id}.`, { ...state, receipt } as unknown as Record<string, unknown>);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_parallel_inspect', {
    title: 'Queue up to three persistent lane workers',
    description: 'Validate and enqueue bounded read-only commands, then return immediately. Each terminal worker produces a hash-chained evidence receipt.',
    inputSchema: {
      orchestration_id: z.string(),
      lanes: z.array(z.object({
        lane_id: z.string(),
        commands: z.array(z.array(z.string()).min(1).max(100)).min(1).max(8)
      })).min(1).max(3),
      timeout_ms: z.number().int().min(100).max(300_000).default(120_000),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ orchestration_id, lanes, timeout_ms, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyAuditChain();
      const coordinator = await enqueueParallelInspection(
        orchestration_id,
        lanes.map(lane => ({ laneId: lane.lane_id, commands: lane.commands })),
        timeout_ms
      );
      const summary = summarizeCoordinator(coordinator);
      const receipt = await writeReceipt({
        action: 'development_parallel_inspect',
        riskTier: 0,
        success: true,
        durationMs: Date.now() - started,
        requestId: request_id,
        target: coordinator.root,
        output: JSON.stringify(summary),
        details: {
          orchestrationId: coordinator.orchestrationId,
          queuedLaneCount: lanes.length,
          revision: summary.revision,
          persistentCoordinator: true,
          maximumConcurrentWorkers: 3,
          externalModels: false
        }
      });
      return textResult(`Queued ${lanes.length} lane worker(s); the coordinator continues after this response. Receipt: ${receipt.id}.`, {
        coordinator: summary,
        receipt
      } as unknown as Record<string, unknown>);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_orchestration_resume', {
    title: 'Resume failed or interrupted lanes',
    description: 'Requeue the previous bounded commands for failed, interrupted, or cancelled lanes. Completed lanes cannot be rerun inside the same orchestration.',
    inputSchema: {
      orchestration_id: z.string(),
      lane_ids: z.array(z.string()).min(1).max(3),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ orchestration_id, lane_ids, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyAuditChain();
      const coordinator = await resumeLaneWorkers(orchestration_id, lane_ids);
      const summary = summarizeCoordinator(coordinator);
      const receipt = await writeReceipt({
        action: 'development_orchestration_resume',
        riskTier: 1,
        success: true,
        durationMs: Date.now() - started,
        requestId: request_id,
        target: coordinator.root,
        output: JSON.stringify(summary),
        details: { orchestrationId: orchestration_id, laneIds: lane_ids, revision: summary.revision }
      });
      return textResult(`Resumed ${lane_ids.length} lane(s). Receipt: ${receipt.id}.`, { coordinator: summary, receipt } as unknown as Record<string, unknown>);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_orchestration_cancel', {
    title: 'Cancel lane workers or abort an orchestration',
    description: 'Cancel queued/running lane process groups. Set abort_orchestration=true to close the central orchestration and release its worktree lease.',
    inputSchema: {
      orchestration_id: z.string(),
      lane_ids: z.array(z.string()).max(3).default([]),
      abort_orchestration: z.boolean().default(false),
      reason: z.string().min(3).max(2_000).default('Cancelled by user'),
      confirm: z.literal(true),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ orchestration_id, lane_ids, abort_orchestration, reason, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyAuditChain();
      const coordinator = await cancelLaneWorkers(orchestration_id, lane_ids.length > 0 ? lane_ids : undefined);
      const orchestration = abort_orchestration ? await abortOrchestration(orchestration_id, reason) : await loadOrchestration(orchestration_id);
      const summary = summarizeCoordinator(coordinator);
      const receipt = await writeReceipt({
        action: 'development_orchestration_cancel',
        riskTier: 1,
        success: true,
        durationMs: Date.now() - started,
        requestId: request_id,
        target: orchestration.root,
        output: JSON.stringify({ orchestration, summary }),
        details: { orchestrationId: orchestration_id, laneIds: lane_ids, abortOrchestration: abort_orchestration, reason }
      });
      return textResult(`${abort_orchestration ? 'Aborted orchestration and cancelled' : 'Cancelled'} lane workers. Receipt: ${receipt.id}.`, {
        orchestration,
        coordinator: summary,
        receipt
      } as unknown as Record<string, unknown>);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_orchestration_cleanup', {
    title: 'Clean completed orchestration state',
    description: 'Delete local state files for completed or aborted orchestrations older than the requested age. Hash-chained receipts are retained.',
    inputSchema: {
      older_than_days: z.number().int().min(1).max(3650).default(30),
      confirm: z.literal(true),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ older_than_days, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyAuditChain();
      const removed = await cleanupOrchestrations(older_than_days * 24 * 60 * 60 * 1_000);
      const receipt = await writeReceipt({
        action: 'development_orchestration_cleanup',
        riskTier: 2,
        success: true,
        durationMs: Date.now() - started,
        requestId: request_id,
        output: JSON.stringify(removed),
        details: { olderThanDays: older_than_days, removed }
      });
      return textResult(`Removed ${removed.length} completed/aborted orchestration state director${removed.length === 1 ? 'y' : 'ies'}. Receipt: ${receipt.id}.`, { removed, receipt });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_lane_report', {
    title: 'Record one completed logical lane report',
    description: 'Persist ChatGPT’s synthesis only after terminal worker evidence and its receipt have been verified.',
    inputSchema: {
      orchestration_id: z.string(),
      lane_id: z.string(),
      summary: z.string().min(10).max(20_000),
      findings: z.array(z.string().min(1).max(5_000)).max(50).default([]),
      recommendations: z.array(z.string().min(1).max(5_000)).max(50).default([]),
      evidence: z.array(z.string().min(1).max(2_000)).max(100).default([]),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ orchestration_id, lane_id, summary, findings, recommendations, evidence, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyAuditChain();
      const worker = await requireLaneCompleted(orchestration_id, lane_id);
      await materializeLaneInspection(orchestration_id, lane_id);
      const state = await recordLaneReport(orchestration_id, { laneId: lane_id, summary, findings, recommendations, evidence });
      const lane = state.lanes.find(candidate => candidate.id === lane_id);
      const receipt = await writeReceipt({
        action: 'development_lane_report',
        riskTier: 0,
        success: true,
        durationMs: Date.now() - started,
        requestId: request_id,
        target: state.root,
        output: JSON.stringify(lane),
        details: {
          orchestrationId: state.id,
          laneId: lane_id,
          role: lane?.role,
          workerAttempt: worker.attempt,
          workerResultCount: worker.results.length,
          workerCompletedAt: worker.completedAt,
          evidenceSha256: worker.evidenceSha256,
          terminalReceiptId: worker.terminalReceiptId
        }
      });
      return textResult(`Recorded evidence-bound ${lane_id}. Receipt: ${receipt.id}.`, { lane, receipt } as unknown as Record<string, unknown>);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_apply_patch', {
    title: 'Apply ChatGPT-synthesized development patch',
    description: 'Acquire a persistent worktree lease and apply one bounded Git patch after every lane completed and reported.',
    inputSchema: {
      orchestration_id: z.string(),
      patch: z.string().min(10).max(2_000_000),
      allow_touch_dirty: z.boolean().default(false),
      confirm: z.boolean().default(false),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ orchestration_id, patch, allow_touch_dirty, confirm, request_id }) => {
    const started = Date.now();
    try {
      requireConfirmation(2, confirm);
      await assertHealthyAuditChain();
      await assertAllLanesCompleted(orchestration_id);
      const result = await applyOrchestrationPatch(orchestration_id, patch, allow_touch_dirty);
      const receipt = await writeReceipt({
        action: 'development_apply_patch',
        riskTier: 2,
        success: result.apply.exitCode === 0 && !result.apply.timedOut,
        durationMs: Date.now() - started,
        requestId: request_id,
        target: result.state.root,
        command: ['git', 'apply', '[patch]'],
        exitCode: result.apply.exitCode,
        output: patch,
        details: {
          orchestrationId: result.state.id,
          patchSha256: result.state.patchSha256,
          patchPaths: result.state.patchPaths,
          allowTouchDirty: allow_touch_dirty,
          worktreeLease: true,
          before: result.before,
          after: result.after
        }
      });
      return textResult(`Applied patch under worktree lease. Receipt: ${receipt.id}.`, { ...result, receipt } as unknown as Record<string, unknown>);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_verify', {
    title: 'Independently verify leased development changes',
    description: 'Run bounded checks while holding the worktree lease. Pre/post byte fingerprints must match, preventing internal or external changes during verification.',
    inputSchema: {
      orchestration_id: z.string(),
      verification: z.enum(['auto', 'custom', 'none']).default('auto'),
      verify_argv: z.array(z.array(z.string()).min(1).max(100)).max(8).default([]),
      timeout_ms: z.number().int().min(1_000).max(config.developmentTimeoutMs).default(Math.min(900_000, config.developmentTimeoutMs)),
      confirm: z.boolean().default(false),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ orchestration_id, verification, verify_argv, timeout_ms, confirm, request_id }) => {
    const started = Date.now();
    try {
      requireConfirmation(2, confirm);
      await assertHealthyAuditChain();
      const before = await loadOrchestration(orchestration_id);
      let commands: string[][];
      if (verification === 'custom') {
        if (verify_argv.length === 0) throw new Error('verification=custom requires verify_argv');
        commands = verify_argv;
      } else if (verification === 'auto') commands = await detectVerificationCommands(before.root);
      else commands = [];
      commands.forEach(validateVerificationCommand);
      const state = await verifyOrchestration(orchestration_id, commands, timeout_ms);
      const verificationRecord = state.verification;
      const worktreeFingerprint = verificationRecord?.success ? await readVerifiedWorktreeFingerprint(state.id) : null;
      const receipt = await writeReceipt({
        action: 'development_verify',
        riskTier: 2,
        success: verificationRecord?.success === true,
        durationMs: Date.now() - started,
        requestId: request_id,
        target: state.root,
        output: JSON.stringify({ verificationRecord, worktreeFingerprint }),
        details: {
          orchestrationId: state.id,
          verificationMode: verification,
          commands,
          status: state.status,
          worktreeStable: verificationRecord?.worktreeStable ?? false,
          worktreeFingerprint: worktreeFingerprint?.fingerprint ?? null
        }
      });
      return textResult(
        verificationRecord?.success
          ? `Verification passed on stable leased bytes. Receipt: ${receipt.id}.`
          : `Verification failed or the worktree changed during checks. Receipt: ${receipt.id}.`,
        { orchestration: state, worktreeFingerprint, receipt } as unknown as Record<string, unknown>
      );
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_finalize', {
    title: 'Finalize verified ChatGPT development orchestration',
    description: 'Recheck the verified fingerprint, finalize state, and release the persistent worktree lease.',
    inputSchema: {
      orchestration_id: z.string(),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ orchestration_id, request_id }) => {
    const started = Date.now();
    try {
      await assertHealthyAuditChain();
      await assertAllLanesCompleted(orchestration_id);
      const before = await loadOrchestration(orchestration_id);
      const worktreeFingerprint = await assertVerifiedWorktreeUnchanged(before);
      const state = await finalizeOrchestration(orchestration_id);
      const receipt = await writeReceipt({
        action: 'development_finalize',
        riskTier: 1,
        success: true,
        durationMs: Date.now() - started,
        requestId: request_id,
        target: state.root,
        output: JSON.stringify({ state, worktreeFingerprint }),
        details: {
          orchestrationId: state.id,
          patchSha256: state.patchSha256,
          lanes: state.lanes.map(lane => ({
            id: lane.id,
            role: lane.role,
            inspected: Boolean(lane.inspection),
            evidenceBound: Boolean(lane.inspectionSha256),
            reported: Boolean(lane.report)
          })),
          verificationSuccess: state.verification?.success === true,
          verifiedWorktreeFingerprint: worktreeFingerprint.fingerprint,
          worktreeLeaseReleased: true,
          reasoningModel: 'ChatGPT',
          externalModels: false
        }
      });
      return textResult(`Finalized ${state.id}, released its worktree lease, and wrote governing receipt ${receipt.id}.`, {
        orchestration: state,
        worktreeFingerprint,
        receipt
      } as unknown as Record<string, unknown>);
    } catch (error) {
      return errorResult(error);
    }
  });
}
