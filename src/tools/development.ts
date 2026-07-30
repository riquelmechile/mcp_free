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
  runParallelInspection,
  validateVerificationCommand,
  verifyOrchestration
} from '../core/development.js';
import { assertWorkspaceCwd, resolveAllowedPath } from '../core/paths.js';
import { requireConfirmation } from '../core/policy.js';
import { writeReceipt } from '../core/receipts.js';
import { errorResult, textResult } from './helpers.js';

export function registerDevelopmentTools(server: McpServer, options: { allowExecute: boolean }): void {
  server.registerTool('development_status', {
    title: 'Inspect ChatGPT-native development readiness',
    description: 'Inspect a Git project and return the local context, existing changes, verification commands, and the three-lane orchestration contract. ChatGPT is the sole reasoning model; this tool never launches another AI.',
    inputSchema: { cwd: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ cwd }) => {
    try {
      const resolvedCwd = await resolveAllowedPath(cwd, { mustExist: true });
      assertWorkspaceCwd(resolvedCwd);
      const state = await inspectProjectDevelopment(resolvedCwd);
      return textResult(
        `ChatGPT-native orchestration is ready in ${state.root}. Up to three logical lanes can inspect concurrently without launching external models.`,
        state as unknown as Record<string, unknown>
      );
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_orchestration_status', {
    title: 'Read development orchestration state',
    description: 'Read one orchestration, its Git baseline, logical lanes, reports, patch state, and independent verification evidence.',
    inputSchema: { orchestration_id: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ orchestration_id }) => {
    try {
      const state = await loadOrchestration(orchestration_id);
      return textResult(`Orchestration ${state.id} is ${state.status}.`, state as unknown as Record<string, unknown>);
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
    title: 'Inspect up to three development lanes in parallel',
    description: 'Run read-only local inspection commands for one to three logical lanes concurrently. The lanes are not AI models: ChatGPT defines their briefs, interprets their evidence, and synthesizes the result.',
    inputSchema: {
      orchestration_id: z.string(),
      lanes: z.array(z.object({
        lane_id: z.string(),
        commands: z.array(z.array(z.string()).min(1).max(100)).min(1).max(8)
      })).min(1).max(3),
      timeout_ms: z.number().int().min(100).max(300_000).default(120_000),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ orchestration_id, lanes, timeout_ms, request_id }) => {
    const started = Date.now();
    try {
      const state = await runParallelInspection(
        orchestration_id,
        lanes.map(lane => ({ laneId: lane.lane_id, commands: lane.commands })),
        timeout_ms
      );
      const receipt = await writeReceipt({
        action: 'development_parallel_inspect',
        riskTier: 0,
        success: true,
        durationMs: Date.now() - started,
        requestId: request_id,
        target: state.root,
        output: JSON.stringify(state.lanes.map(lane => ({ id: lane.id, role: lane.role, inspection: lane.inspection }))),
        details: { orchestrationId: state.id, parallelLaneCount: lanes.length, externalModels: false }
      });
      return textResult(
        `Completed ${lanes.length} local inspection lane(s) concurrently for ${state.id}. Receipt: ${receipt.id}.`,
        { orchestration: state, receipt } as unknown as Record<string, unknown>
      );
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_lane_report', {
    title: 'Record one logical lane report',
    description: 'Persist ChatGPT’s synthesis for one lane. Call this separately for explorer, designer, and reviewer so their conclusions remain distinct before central synthesis.',
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
        details: { orchestrationId: state.id, laneId: lane_id, role: lane?.role }
      });
      return textResult(`Recorded ${lane_id} for ${state.id}. Receipt: ${receipt.id}.`, { lane, receipt } as unknown as Record<string, unknown>);
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_apply_patch', {
    title: 'Apply ChatGPT-synthesized development patch',
    description: 'Apply one unified Git patch synthesized by ChatGPT after all logical lanes have reported. Refuses concurrent worktree changes and protects pre-existing dirty files unless explicitly approved.',
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
    description: 'Run git diff --check and bounded project verification after a patch. Test/build scripts can execute repository code, so explicit approval is required.',
    inputSchema: {
      orchestration_id: z.string(),
      verification: z.enum(['auto', 'custom', 'none']).default('auto'),
      verify_argv: z.array(z.array(z.string()).min(1).max(100)).max(8).default([]),
      timeout_ms: z.number().int().min(1_000).max(config.developmentTimeoutMs).default(900_000),
      confirm: z.boolean().default(false),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ orchestration_id, verification, verify_argv, timeout_ms, confirm, request_id }) => {
    const started = Date.now();
    try {
      requireConfirmation(2, confirm);
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
      const receipt = await writeReceipt({
        action: 'development_verify',
        riskTier: 2,
        success: verificationRecord?.success === true,
        durationMs: Date.now() - started,
        requestId: request_id,
        target: state.root,
        output: JSON.stringify(verificationRecord),
        details: { orchestrationId: state.id, verificationMode: verification, commands, status: state.status }
      });
      return textResult(
        verificationRecord?.success
          ? `Independent verification passed for ${state.id}. Receipt: ${receipt.id}.`
          : `Independent verification failed for ${state.id}. Receipt: ${receipt.id}.`,
        { orchestration: state, receipt } as unknown as Record<string, unknown>
      );
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool('development_finalize', {
    title: 'Finalize verified ChatGPT development orchestration',
    description: 'Finalize only after every logical lane has reported and independent verification has passed. Produces the governing completion receipt.',
    inputSchema: {
      orchestration_id: z.string(),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ orchestration_id, request_id }) => {
    const started = Date.now();
    try {
      const state = await finalizeOrchestration(orchestration_id);
      const receipt = await writeReceipt({
        action: 'development_finalize',
        riskTier: 1,
        success: true,
        durationMs: Date.now() - started,
        requestId: request_id,
        target: state.root,
        output: JSON.stringify(state),
        details: {
          orchestrationId: state.id,
          patchSha256: state.patchSha256,
          lanes: state.lanes.map(lane => ({ id: lane.id, role: lane.role, reported: Boolean(lane.report) })),
          verificationSuccess: state.verification?.success === true,
          reasoningModel: 'ChatGPT',
          externalModels: false
        }
      });
      return textResult(`Finalized ${state.id}. Governing receipt: ${receipt.id}.`, { orchestration: state, receipt } as unknown as Record<string, unknown>);
    } catch (error) {
      return errorResult(error);
    }
  });
}
