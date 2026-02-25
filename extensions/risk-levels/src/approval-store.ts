/**
 * Approval History Store (JSON file-backed)
 *
 * Persists approval decisions to enable progressive trust:
 * - Level 2 tools auto-approve after N consecutive approvals
 * - Level 3 tools support allow-always via persistent whitelist
 *
 * Storage: `.openclaw/risk-levels/approvals.json`
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { RiskLevel } from "./assess.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalEntry = {
  toolName: string;
  paramsHash: string;
  riskLevel: RiskLevel;
  approved: boolean;
  timestamp: number;
  userId?: string;
};

export type AllowAlwaysEntry = {
  toolName: string;
  patternHash: string;
  addedAt: number;
  userId?: string;
};

type StoreData = {
  version: 1;
  history: ApprovalEntry[];
  allowAlways: AllowAlwaysEntry[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashParams(toolName: string, params: Record<string, unknown>): string {
  // Hash tool name + sorted param keys (ignore values for pattern matching)
  const keys = Object.keys(params).sort().join(",");
  const input = `${toolName}:${keys}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function hashCommand(toolName: string, command: string): string {
  // For bash, hash the first two tokens to distinguish subcommands
  // e.g., "npm install" vs "npm unpublish", "git status" vs "git push"
  const tokens = command.trim().split(/\s+/);
  const key = tokens.slice(0, 2).join(" ");
  const input = `${toolName}:${key}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const MAX_HISTORY_SIZE = 500;

export class ApprovalStore {
  private data: StoreData;
  private filePath: string;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(stateDir: string) {
    const dir = path.join(stateDir, "risk-levels");
    this.filePath = path.join(dir, "approvals.json");

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.data = this.load();

    // Ensure pending data is written on process exit (sync-only in "exit" handler)
    process.on("exit", () => {
      this.flush();
    });
  }

  private load(): StoreData {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === 1) {
          return parsed as StoreData;
        }
      }
    } catch {
      // Corrupted file — start fresh
    }
    return { version: 1, history: [], allowAlways: [] };
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flush();
      this.flushTimer = null;
    }, 2000);
    this.flushTimer.unref?.();
  }

  flush(): void {
    if (!this.dirty) return;
    try {
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
      this.dirty = false;
    } catch {
      // Silently ignore write failures (e.g., readonly fs)
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Compute a pattern hash for a tool call.
   * Bash commands use command-prefix hashing; other tools use param-key hashing.
   */
  computeHash(toolName: string, params: Record<string, unknown>): string {
    if (toolName === "bash" && typeof params.command === "string") {
      return hashCommand(toolName, params.command);
    }
    return hashParams(toolName, params);
  }

  /**
   * Record an approval decision.
   */
  record(entry: ApprovalEntry): void {
    this.data.history.push(entry);
    // Trim history to prevent unbounded growth
    if (this.data.history.length > MAX_HISTORY_SIZE) {
      this.data.history = this.data.history.slice(-MAX_HISTORY_SIZE);
    }
    this.scheduleSave();
  }

  /**
   * Count consecutive approvals for a tool+pattern, newest first.
   * Stops counting at the first denial or different pattern.
   */
  consecutiveApprovals(toolName: string, paramsHash: string): number {
    let count = 0;
    // Walk history backwards
    for (let i = this.data.history.length - 1; i >= 0; i--) {
      const entry = this.data.history[i]!;
      if (entry.toolName !== toolName || entry.paramsHash !== paramsHash) {
        continue; // Skip entries for different tools/patterns
      }
      if (!entry.approved) {
        break; // Chain broken by a denial
      }
      count++;
    }
    return count;
  }

  /**
   * Check if a tool+pattern is in the allow-always list.
   */
  isAllowAlways(toolName: string, patternHash: string): boolean {
    return this.data.allowAlways.some(
      (e) => e.toolName === toolName && e.patternHash === patternHash,
    );
  }

  /**
   * Add a tool+pattern to the allow-always list.
   */
  addAllowAlways(toolName: string, patternHash: string, userId?: string): void {
    if (this.isAllowAlways(toolName, patternHash)) return;
    this.data.allowAlways.push({
      toolName,
      patternHash,
      addedAt: Date.now(),
      userId,
    });
    this.scheduleSave();
  }

  /**
   * Check if a tool+pattern has earned progressive trust through consecutive approvals.
   * Used by before_tool_call to skip approval prompts for L2 (and optionally L3) tools
   * that have been approved enough times in a row.
   */
  isTrusted(toolName: string, paramsHash: string, threshold: number): boolean {
    return this.consecutiveApprovals(toolName, paramsHash) >= threshold;
  }

  /**
   * Record a successful approval (convenience wrapper for the progressive trust flow).
   * Called by after_tool_call when a tool executes without error, meaning the user
   * approved it (or it was auto-approved). This feeds the consecutive approval counter.
   */
  recordApproval(toolName: string, paramsHash: string, riskLevel: RiskLevel, userId?: string): void {
    this.record({
      toolName,
      paramsHash,
      riskLevel,
      approved: true,
      timestamp: Date.now(),
      userId,
    });
  }

  /**
   * Record a denial (tool errored or was blocked).
   * Breaks the consecutive approval chain for this tool+pattern.
   */
  recordDenial(toolName: string, paramsHash: string, riskLevel: RiskLevel, userId?: string): void {
    this.record({
      toolName,
      paramsHash,
      riskLevel,
      approved: false,
      timestamp: Date.now(),
      userId,
    });
  }

  /**
   * Remove a tool+pattern from the allow-always list.
   */
  removeAllowAlways(toolName: string, patternHash: string): boolean {
    const before = this.data.allowAlways.length;
    this.data.allowAlways = this.data.allowAlways.filter(
      (e) => !(e.toolName === toolName && e.patternHash === patternHash),
    );
    if (this.data.allowAlways.length !== before) {
      this.scheduleSave();
      return true;
    }
    return false;
  }

  /**
   * Get all allow-always entries (for diagnostics).
   */
  getAllowAlwaysList(): readonly AllowAlwaysEntry[] {
    return this.data.allowAlways;
  }

  /**
   * Get recent approval history (for diagnostics).
   */
  getRecentHistory(limit = 20): readonly ApprovalEntry[] {
    return this.data.history.slice(-limit);
  }

  /**
   * Clear all data (for testing).
   */
  clear(): void {
    this.data = { version: 1, history: [], allowAlways: [] };
    this.scheduleSave();
  }
}
