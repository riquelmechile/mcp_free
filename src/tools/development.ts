import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import type { CommandResult } from '../types.js';
import { runCommand } from '../core/command.js';
import {
  buildAgentInvocation,
  buildDevelopmentPrompt,
  captureGitSnapshot,
  chooseDevelopmentAgent,
  detectVerificationCommands,
  inspectGentleProject,
  refreshGentleProject,
  type DevelopmentAgentPreference
} from '../core/development.js';
import { assertWorkspaceCwd, resolveAllowedPath } from '../core/paths.js';
import { requireConfirmation } from '../core/policy.js';
import { writeReceipt } from '../core/receipts.js';
import { errorResult, textResult } from './helpers.js';

const VERIFY_EXECUTABLES = new Set([
  'git', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'tsx', 'tsc', 'python', 'python3', 'pytest',
  'go', 'cargo', 'rustc', 'make', 'cmake', 'ninja'
]);

function validateVerificationCommands(commands: string[][]): void {
  for (const argv of commands) {
    if (argv.length === 0) throw new Error('Verification command must not be empty');
    const executable = path.basename(argv[0]!);
    if (!VERIFY_EXECUTABLES.has(executable)) throw new Error(`Verification executable is not allowed: ${executable}`);
  }
}

export function registerDevelopmentTools(server: McpServer, options: { allowExecute: boolean }): void {
  server.registerTool('development_status', {
    title: 'Inspect Gentle AI development readiness',
    description: 'Inspect a Git project, Gentle AI health/review mode, skill registry, and supported non-interactive coding agents before delegating development.',
    inputSchema: { cwd: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ cwd }) => {
    try {
      const resolvedCwd = await resolveAllowedPath(cwd, { mustExist: true });
      assertWorkspaceCwd(resolvedCwd);
      const state = await inspectGentleProject(resolvedCwd);
      return textResult(
        state.recommendedAgent
          ? `Gentle development is ready with ${state.recommendedAgent} in ${state.cwd}.`
          : 'No Gentle-configured non-interactive development agent is ready.',
        state as unknown as Record<string, unknown>
      );
    } catch (error) {
      return errorResult(error);
    }
  });

  if (!options.allowExecute) return;

  server.registerTool('development_execute', {
    title: 'Develop with Gentle AI orchestration',
    description: 'Prepare a Git project with Gentle AI, delegate the task to a configured coding agent, then independently inspect Git and run bounded verification commands. This is the preferred path for development instead of generic workspace_execute.',
    inputSchema: {
      cwd: z.string(),
      task: z.string().min(10).max(30_000),
      agent: z.enum(['auto', 'opencode', 'codex', 'claude', 'gemini']).default('auto'),
      use_sdd: z.boolean().default(false),
      refresh_skills: z.boolean().default(true),
      auto_approve_agent: z.boolean().default(false),
      verification: z.enum(['auto', 'custom', 'none']).default('auto'),
      verify_argv: z.array(z.array(z.string()).min(1).max(100)).max(8).default([]),
      timeout_ms: z.number().int().min(10_000).max(config.developmentTimeoutMs).default(config.developmentTimeoutMs),
      confirm: z.boolean().default(false),
      request_id: z.string().min(8).max(128).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ cwd, task, agent, use_sdd, refresh_skills, auto_approve_agent, verification, verify_argv, timeout_ms, confirm, request_id }) => {
    const started = Date.now();
    try {
      requireConfirmation(2, confirm);
      if (auto_approve_agent && config.mode !== 'full') {
        throw new Error('auto_approve_agent=true requires MCP_MODE=full because it bypasses interactive agent permission prompts.');
      }

      const resolvedCwd = await resolveAllowedPath(cwd, { mustExist: true });
      assertWorkspaceCwd(resolvedCwd);
      const beforeState = await inspectGentleProject(resolvedCwd);
      if (!beforeState.gentleAi.installed) throw new Error('gentle-ai is required for development_execute');
      if (beforeState.gentleAi.doctorExitCode !== 0) {
        throw new Error(`gentle-ai doctor is not healthy: ${beforeState.gentleAi.doctorOutput ?? 'no output'}`);
      }
      const selected = chooseDevelopmentAgent(beforeState.agents, agent as DevelopmentAgentPreference);

      const refreshResult = refresh_skills ? await refreshGentleProject(beforeState.cwd) : null;
      const baselineGit = refreshResult ? await captureGitSnapshot(beforeState.cwd) : beforeState.git;
      let commands: string[][];
      if (verification === 'custom') {
        if (verify_argv.length === 0) throw new Error('verification=custom requires verify_argv');
        commands = verify_argv;
      } else if (verification === 'auto') {
        commands = await detectVerificationCommands(beforeState.cwd);
      } else {
        commands = [];
      }
      validateVerificationCommands(commands);

      const prompt = buildDevelopmentPrompt({
        task,
        cwd: beforeState.cwd,
        useSdd: use_sdd,
        baselineStatus: baselineGit.status,
        verificationCommands: commands
      });
      const invocation = buildAgentInvocation({ agent: selected, prompt, cwd: beforeState.cwd, autoApprove: auto_approve_agent });
      const agentResult = await runCommand(invocation, {
        cwd: beforeState.cwd,
        timeoutMs: timeout_ms,
        maxTimeoutMs: config.developmentTimeoutMs,
        env: { MCP_FREE_DEVELOPMENT_RUN: '1', GENTLE_AI_NON_INTERACTIVE: '1' }
      });

      const afterGit = await captureGitSnapshot(beforeState.cwd);
      const [diffCheck, nameStatus] = await Promise.all([
        runCommand(['git', 'diff', '--check'], { cwd: beforeState.cwd, timeoutMs: 60_000 }),
        runCommand(['git', 'status', '--short'], { cwd: beforeState.cwd, timeoutMs: 30_000 })
      ]);
      const verificationResults: CommandResult[] = [];
      for (const argv of commands) {
        verificationResults.push(await runCommand(argv, {
          cwd: beforeState.cwd,
          timeoutMs: Math.min(timeout_ms, 15 * 60_000),
          maxTimeoutMs: config.developmentTimeoutMs
        }));
      }

      const gitIdentityUnchanged = afterGit.head === baselineGit.head && afterGit.branch === baselineGit.branch;
      const successful = agentResult.exitCode === 0
        && !agentResult.timedOut
        && gitIdentityUnchanged
        && diffCheck.exitCode === 0
        && verificationResults.every(result => result.exitCode === 0 && !result.timedOut);
      const evidence = JSON.stringify({
        agent: selected.id,
        task,
        invocation: invocation.slice(0, -1).concat('[prompt-sha-hidden]'),
        before: baselineGit,
        after: afterGit,
        agentExitCode: agentResult.exitCode,
        agentTimedOut: agentResult.timedOut,
        agentOutput: `${agentResult.stdout}\n${agentResult.stderr}`,
        diffCheck,
        verificationResults
      });
      const receipt = await writeReceipt({
        action: 'development_execute',
        riskTier: 2,
        success: successful,
        durationMs: Date.now() - started,
        requestId: request_id,
        target: beforeState.cwd,
        command: invocation.slice(0, -1).concat('[development-prompt]'),
        exitCode: agentResult.exitCode,
        output: evidence,
        details: {
          agent: selected.id,
          useSdd: use_sdd,
          autoApproveAgent: auto_approve_agent,
          refreshedSkillRegistry: refreshResult !== null,
          verificationMode: verification,
          verificationCommands: commands,
          changedPaths: nameStatus.stdout.split('\n').filter(Boolean).length,
          diffCheckPassed: diffCheck.exitCode === 0,
          gitIdentityUnchanged
        }
      });

      return textResult(
        successful
          ? `Gentle development completed with ${selected.id}; independent checks passed. Receipt: ${receipt.id}.`
          : `Gentle development finished but one or more checks failed. Receipt: ${receipt.id}.`,
        {
          project: beforeState.cwd,
          agent: selected,
          beforeGit: baselineGit,
          afterGit,
          agentResult,
          diffCheck,
          changedPaths: nameStatus.stdout,
          verificationResults,
          receipt
        }
      );
    } catch (error) {
      return errorResult(error);
    }
  });
}
