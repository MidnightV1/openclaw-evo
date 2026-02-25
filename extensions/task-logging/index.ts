/**
 * OpenClaw Task Logging Plugin
 *
 * Records the full lifecycle of task execution:
 * main task -> subtask spawns -> subtask completion -> session end summary.
 *
 * Produces one markdown file per session in {OPENCLAW_STATE_DIR}/task-logs/.
 * Only sessions that spawned at least one subagent generate a log file.
 *
 * Finalization strategy:
 * - Primary (and only reliable) path: auto-finalize when the last subtask
 *   in a group completes. This fires immediately and does not depend on
 *   session_end timing.
 * - Safety net: session_end hook catches session resets. It scans active
 *   sessions by agentId and force-finalizes any un-finalized task groups.
 *   This is best-effort because session_end ctx may not carry sessionKey.
 */

import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createTaskLogger } from "./src/task-logger.js";

type TaskLoggingConfig = {
  retentionDays?: number;
  logDir?: string;
};

// ---------------------------------------------------------------------------
// Lightweight per-1M-token pricing (self-contained — no observability import).
// Only needs to cover common models; unknown models simply get no cost.
// ---------------------------------------------------------------------------

type SimplePricing = { inputPer1M: number; outputPer1M: number };

const MODEL_PRICING: Record<string, SimplePricing> = {
  "claude-opus-4-6": { inputPer1M: 15, outputPer1M: 75 },
  "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
  "claude-haiku-4-5": { inputPer1M: 0.8, outputPer1M: 4 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "o3": { inputPer1M: 10, outputPer1M: 40 },
  "o3-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
  "o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10 },
  "gemini-2.5-flash": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gemini-3-flash": { inputPer1M: 0.15, outputPer1M: 0.6 },
};

function estimateSimpleCost(
  model: string,
  inputTokens?: number,
  outputTokens?: number,
): number | undefined {
  // Exact match first, then prefix match
  let pricing = MODEL_PRICING[model];
  if (!pricing) {
    for (const key of Object.keys(MODEL_PRICING)) {
      if (model.startsWith(key)) {
        pricing = MODEL_PRICING[key];
        break;
      }
    }
  }
  if (!pricing) return undefined;
  return (
    ((inputTokens ?? 0) / 1_000_000) * pricing.inputPer1M +
    ((outputTokens ?? 0) / 1_000_000) * pricing.outputPer1M
  );
}

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export default function register(api: OpenClawPluginApi) {
  const pluginConfig = (api.config?.plugins?.["task-logging"] ?? {}) as TaskLoggingConfig;
  const retentionDays = pluginConfig.retentionDays ?? 90;

  // Resolve logs directory — use configured value if provided, otherwise default.
  const stateDir =
    process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "~", ".openclaw");
  const logsDir = pluginConfig.logDir || path.join(stateDir, "task-logs");

  const logger = createTaskLogger({ logsDir, retentionDays });

  // Log resolved paths so they are discoverable by agents/users.
  api.logger.info(`[task-logging] resolvedPaths: logDir=${logsDir}`);

  // ---------- Hook: session_start ----------
  // No-op: we previously tried to register sessionId -> sessionKey here,
  // but session_start ctx lacks sessionKey and the synthesized key was
  // unreliable (RISK-1). Auto-finalize on subtask completion is the
  // primary path; session_end scans by agentId as a safety net.

  // ---------- Hook: subagent_spawned ----------
  // Records each successfully spawned subtask.
  api.on("subagent_spawned", (event, ctx) => {
    try {
      logger.recordSubtaskSpawn({
        requesterSessionKey: ctx.requesterSessionKey,
        childSessionKey: event.childSessionKey,
        agentId: event.agentId,
        label: event.label,
        mode: event.mode,
        runId: event.runId,
      });
    } catch {
      // Observability must never crash the host.
    }
  });

  // ---------- Hook: llm_output ----------
  // Accumulate token usage per session key so we can attach it to subtask
  // records when the subtask ends. Independent of the observability plugin.
  api.on("llm_output", (event, ctx) => {
    try {
      if (!ctx.sessionKey) return;
      const cost = estimateSimpleCost(
        event.model,
        event.usage?.input,
        event.usage?.output,
      );
      logger.accumulateTokens({
        sessionKey: ctx.sessionKey,
        inputTokens: event.usage?.input,
        outputTokens: event.usage?.output,
        totalCost: cost,
      });
    } catch {
      // Silent.
    }
  });

  // ---------- Hook: subagent_ended ----------
  // Updates subtask completion status. If all subtasks in the parent session
  // are now complete, auto-finalize (write the log) immediately.
  api.on("subagent_ended", (event, ctx) => {
    try {
      const completedSessionKey = logger.recordSubtaskEnd({
        targetSessionKey: event.targetSessionKey,
        runId: ctx.runId ?? event.runId,
        outcome: event.outcome,
        reason: event.reason,
        error: event.error,
        endedAt: event.endedAt,
      });
      // Auto-finalize when all subtasks in this group are done.
      if (completedSessionKey) {
        logger.autoFinalize(completedSessionKey);
      }
    } catch {
      // Silent.
    }
  });

  // ---------- Hook: session_end ----------
  // Safety net: when a session resets, force-finalize any un-finalized task
  // groups belonging to this agent. This is best-effort — auto-finalize on
  // subtask completion is the primary (and only reliable) path.
  api.on("session_end", (event, ctx) => {
    try {
      logger.finalizeByAgentId({
        agentId: ctx.agentId,
        messageCount: event.messageCount,
        durationMs: event.durationMs,
      });
    } catch {
      // Silent.
    }
  });

  // ---------- Periodic cleanup ----------
  const cleanupTimer = setInterval(() => {
    try {
      logger.cleanupExpiredLogs();
    } catch {
      // Silent.
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();

  // Run initial cleanup on load.
  try {
    logger.cleanupExpiredLogs();
  } catch {
    // Silent.
  }
}
