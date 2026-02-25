/**
 * Task execution logger.
 *
 * Maintains in-memory state per parent session and generates markdown task
 * logs when all subtasks complete or when the session ends.
 *
 * Key identity:
 * - Primary key: `requesterSessionKey` from subagent hooks (routing key,
 *   e.g. "agent:main:main" or "agent:main:telegram:direct:123").
 * - session_end does not reliably provide sessionKey, so it falls back to
 *   scanning active sessions by agentId (parsed from the session key).
 *
 * Finalization:
 * - Primary (only reliable) path: auto-finalize when the last subtask in a
 *   group ends. This fires immediately via subagent_ended.
 * - Safety net: session_end scans by agentId and force-finalizes remaining
 *   task groups. Best-effort only.
 *
 * Design constraints:
 * - All operations wrapped in try-catch — observability must never crash host.
 * - Memory state cleared after finalization to prevent leaks.
 * - sessionIdToKey map has capacity cap to prevent slow memory leaks.
 * - Expired log files cleaned up periodically (default 90 days).
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubtaskRecord = {
  subtaskId: string;
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: "run" | "session";
  spawnedAt: string;
  /** Set when subagent_ended fires. */
  endedAt?: string;
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
  reason?: string;
  error?: string;
  runId?: string;
  durationMs?: number;
  /** Accumulated input tokens from LLM calls during this subtask. */
  inputTokens?: number;
  /** Accumulated output tokens from LLM calls during this subtask. */
  outputTokens?: number;
  /** Estimated total cost of LLM calls during this subtask. */
  totalCost?: number;
};

export type TaskLogState = {
  /** The requesterSessionKey — primary key for tracking. */
  sessionKey: string;
  agentId?: string;
  /** Populated if we can correlate a UUID sessionId to this key. */
  sessionId?: string;
  startTime: string;
  subtasks: SubtaskRecord[];
  status: "in_progress" | "completed" | "failed";
  /** Set to true after the log file has been written. Prevents duplicates. */
  finalized?: boolean;
};

export type TaskLoggerOptions = {
  logsDir: string;
  retentionDays?: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sanitize a string for use in a filename. */
function sanitizeForFilename(input: string): string {
  return input
    .slice(0, 50)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim() || "unnamed";
}

/** Format a timestamp string as YYYY-MM-DD_HHmm. */
function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  } catch {
    return "unknown-time";
  }
}

/** Escape markdown special characters in user-supplied text (headings, bold). */
function escapeMarkdown(text: string): string {
  return text.replace(/([#*\[\]`\\|])/g, "\\$1");
}

/** Extract the agentId segment from a requesterSessionKey (e.g. "agent:main:…" -> "main"). */
function parseAgentIdFromKey(sessionKey: string): string | undefined {
  // Keys follow the pattern "agent:<agentId>:…"
  const parts = sessionKey.split(":");
  return parts.length >= 2 ? parts[1] : undefined;
}

/** Compute human-readable duration from ms. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainSec}s`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return `${hours}h ${remainMin}m`;
}

// ---------------------------------------------------------------------------
// Token accumulation types
// ---------------------------------------------------------------------------

type TokenAccumulator = {
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
};

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export function createTaskLogger(options: TaskLoggerOptions) {
  const { logsDir, retentionDays = 90 } = options;

  /** Primary store: requesterSessionKey -> TaskLogState. */
  const sessions = new Map<string, TaskLogState>();

  /**
   * Per-session token accumulator: sessionKey -> TokenAccumulator.
   * Populated by accumulateTokens() called from the llm_output hook.
   * Entries are cleaned up when the session is finalized.
   */
  const tokenAccumulators = new Map<string, TokenAccumulator>();

  /**
   * Reverse map: sessionId (UUID) -> requesterSessionKey.
   * Populated from subagent hooks when we can infer the relationship.
   * Has a capacity cap (MAX_SESSION_ID_MAP_SIZE) to prevent memory leaks
   * from long-running processes without session resets.
   */
  const MAX_SESSION_ID_MAP_SIZE = 1000;
  const sessionIdToKey = new Map<string, string>();

  // Ensure logs directory exists.
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch {
    // Best-effort — will retry on write.
  }

  // ---------- Session identity mapping ----------

  /**
   * Register a mapping from sessionId (UUID) to a requesterSessionKey.
   * Called internally when subagent hooks provide enough info to correlate.
   * Enforces a capacity cap to prevent unbounded growth.
   */
  function registerSessionId(sessionId: string, sessionKey: string): void {
    try {
      if (!sessionId || !sessionKey) return;
      sessionIdToKey.set(sessionId, sessionKey);
      // Evict oldest entry if over capacity.
      if (sessionIdToKey.size > MAX_SESSION_ID_MAP_SIZE) {
        const oldest = sessionIdToKey.keys().next().value;
        if (oldest) sessionIdToKey.delete(oldest);
      }
    } catch {
      // Silent.
    }
  }

  // ---------- State management ----------

  function ensureSession(sessionKey: string, agentId?: string): TaskLogState {
    let state = sessions.get(sessionKey);
    if (!state) {
      state = {
        sessionKey,
        agentId,
        startTime: new Date().toISOString(),
        subtasks: [],
        status: "in_progress",
      };
      sessions.set(sessionKey, state);
    }
    if (agentId && !state.agentId) {
      state.agentId = agentId;
    }
    return state;
  }

  // ---------- Token accumulation ----------

  /**
   * Accumulate token usage for a given session key.
   * Called from the llm_output hook with per-call token counts and cost.
   * The accumulated totals are attached to subtask records on finalization.
   */
  function accumulateTokens(params: {
    sessionKey: string;
    inputTokens?: number;
    outputTokens?: number;
    totalCost?: number;
  }): void {
    try {
      if (!params.sessionKey) return;

      // Only accumulate for sessions we are tracking.
      // We check if any tracked session has a subtask with this sessionKey
      // as the childSessionKey (i.e., LLM calls from a subtask's session).
      let acc = tokenAccumulators.get(params.sessionKey);
      if (!acc) {
        acc = { inputTokens: 0, outputTokens: 0, totalCost: 0 };
        tokenAccumulators.set(params.sessionKey, acc);
      }
      acc.inputTokens += params.inputTokens ?? 0;
      acc.outputTokens += params.outputTokens ?? 0;
      acc.totalCost += params.totalCost ?? 0;
    } catch {
      // Silent — observability must not crash host.
    }
  }

  /**
   * Attach accumulated token data to a subtask record.
   * Called internally when a subtask ends.
   */
  function attachTokensToSubtask(subtask: SubtaskRecord): void {
    try {
      const acc = tokenAccumulators.get(subtask.childSessionKey);
      if (acc) {
        subtask.inputTokens = acc.inputTokens || undefined;
        subtask.outputTokens = acc.outputTokens || undefined;
        subtask.totalCost = acc.totalCost || undefined;
        tokenAccumulators.delete(subtask.childSessionKey);
      }
    } catch {
      // Silent.
    }
  }

  // ---------- Recording methods ----------

  /**
   * Called on subagent_spawned — records a new subtask spawn.
   * Uses subagent_spawned (not subagent_spawning) because it fires
   * after the spawn is confirmed and includes the runId.
   */
  function recordSubtaskSpawn(params: {
    requesterSessionKey?: string;
    childSessionKey: string;
    agentId: string;
    label?: string;
    mode: "run" | "session";
    runId?: string;
  }): void {
    try {
      const parentKey = params.requesterSessionKey || "unknown";
      const state = ensureSession(parentKey);

      state.subtasks.push({
        subtaskId: params.childSessionKey,
        childSessionKey: params.childSessionKey,
        agentId: params.agentId,
        label: params.label,
        mode: params.mode,
        spawnedAt: new Date().toISOString(),
        runId: params.runId,
      });
    } catch {
      // Silent — observability must not crash host.
    }
  }

  /**
   * Called on subagent_ended — updates subtask completion status.
   * Returns the parent session key if all subtasks are now complete
   * (signals auto-finalization opportunity).
   */
  function recordSubtaskEnd(params: {
    targetSessionKey: string;
    runId?: string;
    outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
    reason: string;
    error?: string;
    endedAt?: number;
  }): string | undefined {
    try {
      const now = new Date().toISOString();
      // Find the subtask across all tracked sessions.
      for (const [sessionKey, state] of sessions.entries()) {
        const subtask = state.subtasks.find(
          (s) =>
            s.childSessionKey === params.targetSessionKey ||
            (params.runId && s.runId === params.runId),
        );
        if (subtask) {
          subtask.endedAt = params.endedAt
            ? new Date(params.endedAt).toISOString()
            : now;
          subtask.outcome = params.outcome;
          subtask.reason = params.reason;
          subtask.error = params.error;
          // Compute duration if we have both timestamps.
          if (subtask.spawnedAt && subtask.endedAt) {
            const start = new Date(subtask.spawnedAt).getTime();
            const end = new Date(subtask.endedAt).getTime();
            if (start > 0 && end > start) {
              subtask.durationMs = end - start;
            }
          }
          // Attach accumulated token/cost data.
          attachTokensToSubtask(subtask);
          // Check if all subtasks are now complete.
          const allEnded = state.subtasks.every((s) => s.endedAt);
          if (allEnded && !state.finalized) {
            return sessionKey;
          }
          break;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  // ---------- Finalization ----------

  /**
   * Write the task log for a given session key.
   * Called when all subtasks complete (auto-finalize) or on session_end.
   */
  function writeTaskLog(
    sessionKey: string,
    extra?: { messageCount?: number; durationMs?: number },
  ): string | undefined {
    try {
      const state = sessions.get(sessionKey);
      if (!state || state.finalized) {
        return undefined;
      }

      // Determine overall status.
      const hasFailedSubtask = state.subtasks.some(
        (s) =>
          s.outcome === "error" ||
          s.outcome === "timeout" ||
          s.outcome === "killed",
      );
      const allEnded = state.subtasks.every((s) => s.endedAt);
      state.status = hasFailedSubtask
        ? "failed"
        : allEnded
          ? "completed"
          : "in_progress";

      // Build markdown content.
      const md = buildMarkdown(state, extra);

      // Derive filename.
      const firstLabel =
        state.subtasks[0]?.label ||
        state.subtasks[0]?.agentId ||
        state.sessionKey.slice(0, 8);
      const sanitized = sanitizeForFilename(firstLabel);
      const ts = formatTimestamp(state.startTime);
      const filename = `${sanitized}_${ts}.md`;

      // Write file.
      fs.mkdirSync(logsDir, { recursive: true });
      const filePath = path.join(logsDir, filename);
      fs.writeFileSync(filePath, md, "utf-8");

      // Mark finalized and clear memory.
      state.finalized = true;
      sessions.delete(sessionKey);
      // Also clean reverse map entries pointing to this key.
      for (const [sid, key] of sessionIdToKey.entries()) {
        if (key === sessionKey) {
          sessionIdToKey.delete(sid);
        }
      }
      // Clean up token accumulators for subtasks of this session.
      for (const subtask of state.subtasks) {
        tokenAccumulators.delete(subtask.childSessionKey);
      }

      return filePath;
    } catch {
      // Best-effort cleanup on error — delete state to prevent retries
      // that would also fail (e.g. disk full). No need to set finalized
      // since the entry is being deleted immediately.
      sessions.delete(sessionKey);
      return undefined;
    }
  }

  /**
   * Safety-net finalization: called from session_end.
   * Scans active sessions whose key contains the given agentId and
   * force-finalizes any that haven't been finalized yet.
   *
   * Also cleans up any sessionIdToKey entries associated with this agent
   * to prevent slow memory leaks (RISK-4).
   */
  function finalizeByAgentId(params: {
    agentId?: string;
    messageCount?: number;
    durationMs?: number;
  }): void {
    try {
      if (!params.agentId) return;
      const extra = {
        messageCount: params.messageCount,
        durationMs: params.durationMs,
      };
      // Scan sessions map for entries belonging to this agentId.
      // Collect keys first to avoid mutating the map during iteration.
      const keysToFinalize: string[] = [];
      for (const [sessionKey, state] of sessions.entries()) {
        if (state.finalized) continue;
        const keyAgentId = parseAgentIdFromKey(sessionKey);
        if (keyAgentId === params.agentId || state.agentId === params.agentId) {
          keysToFinalize.push(sessionKey);
        }
      }
      for (const key of keysToFinalize) {
        writeTaskLog(key, extra);
      }
      // Clean up sessionIdToKey entries referencing finalized keys.
      for (const [sid, key] of sessionIdToKey.entries()) {
        if (!sessions.has(key)) {
          sessionIdToKey.delete(sid);
        }
      }
    } catch {
      // Silent.
    }
  }

  /**
   * Auto-finalize: called when all subtasks in a session have ended.
   * This is the primary finalization path since session_end only fires
   * on session reset which may not happen for long-running sessions.
   */
  function autoFinalize(sessionKey: string): string | undefined {
    return writeTaskLog(sessionKey);
  }

  // ---------- Markdown generation ----------

  function buildMarkdown(
    state: TaskLogState,
    endParams?: { messageCount?: number; durationMs?: number },
  ): string {
    const lines: string[] = [];
    const taskDesc = escapeMarkdown(
      state.subtasks[0]?.label || state.subtasks[0]?.agentId || "Session task",
    );

    // Header
    lines.push(`# Task: ${taskDesc}`);
    lines.push(`- Created: ${state.startTime}`);
    if (state.agentId) {
      lines.push(`- Agent: ${state.agentId}`);
    }
    lines.push(`- Session: ${state.sessionKey}`);
    if (state.sessionId) {
      lines.push(`- Session ID: ${state.sessionId}`);
    }
    lines.push(`- Status: ${state.status}`);
    lines.push("");

    // Subtask breakdown
    if (state.subtasks.length > 0) {
      lines.push("## Subtask Breakdown");
      lines.push("");
      for (let i = 0; i < state.subtasks.length; i++) {
        const st = state.subtasks[i];
        const depStr = i > 0 ? `, spawned after subtask ${i}` : "";
        lines.push(
          `${i + 1}. **${escapeMarkdown(st.label || st.agentId)}** (mode: ${st.mode})${depStr}`,
        );
        lines.push(`   - Agent: ${st.agentId}`);
        lines.push(`   - Session: \`${st.childSessionKey}\``);
        if (st.runId) {
          lines.push(`   - Run: \`${st.runId}\``);
        }
      }
      lines.push("");

      // Execution details
      lines.push("## Execution Details");
      lines.push("");
      for (let i = 0; i < state.subtasks.length; i++) {
        const st = state.subtasks[i];
        lines.push(`### Subtask ${i + 1}: ${escapeMarkdown(st.label || st.agentId)}`);
        lines.push(`- Spawned: ${st.spawnedAt}`);
        if (st.endedAt) {
          lines.push(`- Ended: ${st.endedAt}`);
        }
        if (st.durationMs != null) {
          lines.push(`- Duration: ${formatDuration(st.durationMs)}`);
        }
        if (st.inputTokens != null || st.outputTokens != null) {
          lines.push(`- Tokens: ${st.inputTokens ?? 0} in / ${st.outputTokens ?? 0} out`);
        }
        if (st.totalCost != null) {
          lines.push(`- Cost: ${st.totalCost.toFixed(6)}`);
        }
        lines.push(`- Outcome: ${st.outcome ?? "unknown"}`);
        if (st.reason) {
          lines.push(`- Reason: ${st.reason}`);
        }
        if (st.error) {
          lines.push(`- Error: ${escapeMarkdown(st.error)}`);
        }
        lines.push("");
      }
    }

    // Summary
    lines.push("## Summary");
    if (endParams?.durationMs != null) {
      lines.push(`- Session duration: ${formatDuration(endParams.durationMs)}`);
    }
    if (endParams?.messageCount != null) {
      lines.push(`- Messages: ${endParams.messageCount}`);
    }
    lines.push(`- Subtasks: ${state.subtasks.length}`);
    const succeeded = state.subtasks.filter((s) => s.outcome === "ok").length;
    const failed = state.subtasks.filter(
      (s) =>
        s.outcome === "error" ||
        s.outcome === "timeout" ||
        s.outcome === "killed",
    ).length;
    lines.push(`- Succeeded: ${succeeded}`);
    if (failed > 0) {
      lines.push(`- Failed: ${failed}`);
    }

    // Compute total subtask time.
    const totalSubtaskMs = state.subtasks.reduce(
      (sum, s) => sum + (s.durationMs ?? 0),
      0,
    );
    if (totalSubtaskMs > 0) {
      lines.push(`- Total subtask time: ${formatDuration(totalSubtaskMs)}`);
    }

    // Compute total token usage and cost across all subtasks.
    const totalInputTokens = state.subtasks.reduce(
      (sum, s) => sum + (s.inputTokens ?? 0),
      0,
    );
    const totalOutputTokens = state.subtasks.reduce(
      (sum, s) => sum + (s.outputTokens ?? 0),
      0,
    );
    const totalCost = state.subtasks.reduce(
      (sum, s) => sum + (s.totalCost ?? 0),
      0,
    );
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      lines.push(`- Total tokens: ${totalInputTokens} in / ${totalOutputTokens} out`);
    }
    if (totalCost > 0) {
      lines.push(`- Total cost: ${totalCost.toFixed(6)}`);
    }
    lines.push("");

    return lines.join("\n");
  }

  // ---------- Cleanup ----------

  /**
   * Remove task log files older than retentionDays.
   * Called periodically via setInterval.
   */
  function cleanupExpiredLogs(): number {
    try {
      if (!fs.existsSync(logsDir)) {
        return 0;
      }
      const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      let cleaned = 0;
      const entries = fs.readdirSync(logsDir);

      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        // Extract date from filename: {name}_{YYYY-MM-DD_HHmm}.md
        const dateMatch = entry.match(/(\d{4}-\d{2}-\d{2})_\d{4}\.md$/);
        if (!dateMatch) continue;
        const fileDate = new Date(dateMatch[1] + "T00:00:00Z");
        if (Number.isNaN(fileDate.getTime())) continue;
        if (fileDate.getTime() < cutoffMs) {
          try {
            fs.unlinkSync(path.join(logsDir, entry));
            cleaned++;
          } catch {
            // Skip individual file errors.
          }
        }
      }
      return cleaned;
    } catch {
      return 0;
    }
  }

  // ---------- Diagnostic ----------

  /** Return current in-memory session count (for testing/diagnostics). */
  function getActiveSessionCount(): number {
    return sessions.size;
  }

  return {
    registerSessionId,
    recordSubtaskSpawn,
    recordSubtaskEnd,
    accumulateTokens,
    finalizeByAgentId,
    autoFinalize,
    cleanupExpiredLogs,
    getActiveSessionCount,
  };
}
