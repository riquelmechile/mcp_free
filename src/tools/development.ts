import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import {
  applyOrchestrationPatch,
  createOrchestration,
  detectVerificationCommands,
  finalizeOrchestration,
  inspectProjectDevelopment,
  loadOrchestration,
  recordLaneReport,
  validateVerificationCommand,
  verifyOrchestration
} from '../core/development.js';
import {
  assertAllLanesCompleted,
  enqueueParallelInspection,
  getCoordinatorState,
  getLaneWorker,
  materializeLaneInspection,
  requireLaneCompleted,
  summarizeCoordinator,
  waitForCoordinatorChange
} from '../core/lane-coordinator.js';
import { assertWorkspaceCwd, resolveAllowedPath } from '../core/paths.js';
import { requireConfirmation } from '../core/policy.js';
import { verifyReceiptChain, writeReceipt } from '../core/receipts.js';
import { assertVerifiedWorktreeUnchanged, recordVerifiedWorktree } from '../core/worktree-fingerprint.js';
import { errorResult, textResult } from './helpers.js';

async function assertHealthyAuditChain(): Promise<void> {
  const verification = await verifyReceiptChain();
  if (!verification.valid) throw new Error(`Receipt chain is invalid; refusing to mutate orchestration state: ${verification.errors.join('; ')}`);
}

export function registerDevelopmentTools(server: McpServer, options: { allowExecute: boolean }): void {
  server.registerTool('development_status', {
    title: 'Inspect ChatGPT-native development readiness',
    description: 'Inspect a Git project and return local context, existing changes, verification commands, and the persistent three-lane orchestration contract. ChatGPT is the sole reasoning model; this tool never launches another AI.',
    inputSchema: { cwd: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ cwd }) => {
    try {
      const resolvedCwd = await resolveAllowedPath(cwd, { mustExist: true });
      assertWorkspaceCwd(resolvedCwd);
      const state = await inspectProjectDevelopment(resolvedCwd);
      return textResult(
        `ChatGPT-native orchestration is ready in ${state.root}. The MCP coordinator can keep up to three local lane workers running after the dispatch call returns.`,
        state as unknown as Record<string, unknown>
      );
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_orchestration_status', {
    title: 'Read persistent development orchestration state',
    description: 'Read the central orchestration plus a compact coordinator snapshot. This call returns immediately while queued or running lane workers continue in the MCP service.',
    inputSchema: { orchestration_id: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ orchestration_id }) => {
    try {
      const [orchestration, coordinator] = await Promise.all([
        loadOrchestration(orchestration_id),
        getCoordinatorState(orchestration_id)
      ]);
      const summary = summarizeCoordinator(coordinator);
      return textResult(
        `Orchestration ${orchestration.id} is ${orchestration.status}; lane coordinator is ${summary.status} at revision ${summary.revision}.`,
        { orchestration, coordinator: summary } as unknown as Record<string, unknown>
      );
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_orchestration_wait', {
    title: 'Wait for the next lane coordinator change',
    description: 'Long-poll for at most 30 seconds until a lane starts, advances, completes, fails, or is interrupted. Background lane workers continue independently of this request.',
    inputSchema: {
      orchestration_id: z.string(),
      after_revision: z.number().int().min(0).default(0),
      wait_ms: z.number().int().min(0).max(30_000).default(15_000)
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ orchestration_id, after_revision, wait_ms }) => {
    try {
      const coordinator = await waitForCoordinatorChange(orchestration_id, after_revision, wait_ms);
      const summary = summarizeCoordinator(coordinator);
      return textResult(
        `Lane coordinator revision is ${summary.revision}; status is ${summary.status}.`,
        summary as unknown as Record<string, unknown>
      );
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_lane_result', {
    title: 'Read one lane worker result',
    description: 'Read persisted commands, progress, outputs, and errors for one logical lane while other lanes may still be running.',
    inputSchema: {
      orchestration_id: z.string(),
      lane_id: z.string(),
      command_index: z.number().int().min(0).optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ orchestration_id, lane_id, command_index }) => {
    try {
      const lane = await getLaneWorker(orchestration_id, lane_id);
      if (command_index !== undefined) {
        const result = lane.results[command_index];
        if (!result) throw new Error(`No result exists at command_index ${command_index}; available results: ${lane.results.length}`);
        return textResult(
          `Lane ${lane_id} command ${command_index + 1}/${lane.totalCommands} is available.`,
          { laneId: lane.laneId, status: lane.status, commandIndex: command_index, result } as unknown as Record<string, unknown>
        );
      }
      return textResult(
        `Lane ${lane_id} is ${lane.status} with ${lane.results.length}/${lane.totalCommands} command result(s).`,
        lane as unknown as Record<string, unknown>
      );
    } catch (error) {
      return errorResult(error);
    }
  });

  if (!options.allowExecute) return;

  server.registerTool('development_orchestration_start', {
    title: 'Start ChatGPT development orchestration',
    description: 'Freeze the Git baseline and create one to three logical lanes for ChatGPT. This stores orchestration metadata only and launches no model or coding agent.',
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
      return textResult(
        `Started ${state.id} with ${state.lanes.length} ChatGPT-controlled logical lane(s). Receipt: ${receipt.id}.`,
        { ...state, receipt } as unknown as Record<string, unknown>
      );
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_parallel_inspect', {
    title: 'Queue up to three persistent lane workers',
    description: 'Validate and enqueue read-only local inspection commands for one to three lanes, then return immediately. A resident MCP coordinator runs at most three workers concurrently and persists progress after every command.',
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
      return textResult(
        `Queued ${lanes.length} lane worker(s) for ${coordinator.orchestrationId}; the MCP coordinator continues after this call returns. Revision: ${summary.revision}. Receipt: ${receipt.id}.`,
        { coordinator: summary, receipt } as unknown as Record<string, unknown>
      );
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_lane_report', {
    title: 'Record one completed logical lane report',
    description: 'Persist ChatGPT’s synthesis for one completed lane while other workers may continue. The lane must have completed successfully; failed or interrupted lanes must be requeued first.',
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
          workerCompletedAt: worker.completedAt
        }
      });
      return textResult(`Recorded completed ${lane_id} for ${state.id}. Other lane workers may still be running. Receipt: ${receipt.id}.`, { lane, receipt } as unknown as Record<string, unknown>);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_apply_patch', {
    title: 'Apply ChatGPT-synthesized development patch',
    description: 'Apply one unified Git patch synthesized by ChatGPT only after every persistent lane worker completed and every logical lane was reported. Refuses concurrent worktree changes and unsafe patch targets.',
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
          before: result.before,
          after: result.after
        }
      });
      return textResult(
        `Applied ChatGPT-synthesized patch to ${result.state.root}. Receipt: ${receipt.id}.`,
        { ...result, receipt } as unknown as Record<string, unknown>
      );
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_verify', {
    title: 'Independently verify ChatGPT development changes',
    description: 'Run git diff --check and bounded project verification after a patch. Test/build scripts can execute repository code, so explicit approval is required. Successful verification is bound to exact worktree and index bytes.',
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
      } else if (verification === 'auto') {
        commands = await detectVerificationCommands(before.root);
      } else {
        commands = [];
      }
      commands.forEach(validateVerificationCommand);
      const state = await verifyOrchestration(orchestration_id, commands, timeout_ms);
      const verificationRecord = state.verification;
      const worktreeFingerprint = verificationRecord?.success ? await recordVerifiedWorktree(state) : null;
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
          worktreeFingerprint: worktreeFingerprint?.fingerprint ?? null
        }
      });
      return textResult(
        verificationRecord?.success
          ? `Independent verification passed and was bound to exact worktree bytes for ${state.id}. Receipt: ${receipt.id}.`
          : `Independent verification failed for ${state.id}. Receipt: ${receipt.id}.`,
        { orchestration: state, worktreeFingerprint, receipt } as unknown as Record<string, unknown>
      );
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_finalize', {
    title: 'Finalize verified ChatGPT development orchestration',
    description: 'Finalize only after every persistent lane worker completed, every logical lane reported, independent verification passed, and exact worktree/index bytes still match the verified fingerprint.',
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
          lanes: state.lanes.map(lane => ({ id: lane.id, role: lane.role, inspected: Boolean(lane.inspection), reported: Boolean(lane.report) })),
          verificationSuccess: state.verification?.success === true,
          verifiedWorktreeFingerprint: worktreeFingerprint.fingerprint,
          reasoningModel: 'ChatGPT',
          persistentLaneCoordinator: true,
          externalModels: false
        }
      });
      return textResult(`Finalized ${state.id}. Governing receipt: ${receipt.id}.`, { orchestration: state, worktreeFingerprint, receipt } as unknown as Record<string, unknown>);
    } catch (error) {
      return errorResult(error);
    }
  });
}
