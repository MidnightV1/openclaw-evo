/**
 * Risk Levels Plugin — Progressive Authorization
 *
 * Replaces binary allow/deny with a 0-5 risk scale.
 * Each level has distinct behavior rules:
 *   0: silent pass-through
 *   1: silent + log
 *   2: confirm first N times, then auto-approve
 *   3: confirm every time, allow-always available
 *   4: confirm every time, no allow-always
 *   5: double confirmation, never skip
 *
 * Hooks:
 *   - before_tool_call: assess risk and enforce approval rules
 *   - before_prompt_build: inject risk-level context into agent prompt
 *   - after_tool_call: record outcomes for progressive trust
 *
 * Non-invasive: works entirely through the plugin hook system.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { assessRisk } from "./src/assess.js";
import { ApprovalStore } from "./src/approval-store.js";
import { TrashManager } from "./src/trash.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type RiskLevelsConfig = {
  enabled?: boolean;
  /** Number of consecutive approvals before Level 2 auto-approves (default: 5) */
  autoApproveThreshold?: number;
  /** Enable trash/recycle bin for Level 4+ deletions (default: true) */
  trashEnabled?: boolean;
  /** Trash retention in days (default: 7) */
  trashRetentionDays?: number;
  /** Enable risk context injection into agent prompt (default: true) */
  promptInjection?: boolean;
};

// ---------------------------------------------------------------------------
// Plugin Entry
// ---------------------------------------------------------------------------

export default function register(api: OpenClawPluginApi) {
  const pluginConfig = (api.config?.plugins?.["risk-levels"] ?? {}) as RiskLevelsConfig;
  const enabled = pluginConfig.enabled !== false;

  if (!enabled) {
    api.logger.info("risk-levels: plugin disabled via config");
    return;
  }

  const autoApproveThreshold = pluginConfig.autoApproveThreshold ?? 5;
  const trashEnabled = pluginConfig.trashEnabled !== false;
  const promptInjection = pluginConfig.promptInjection !== false;

  // Resolve state directory: use OPENCLAW_STATE_DIR env or fallback to ~/.openclaw
  const stateDir =
    process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "~", ".openclaw");
  const store = new ApprovalStore(stateDir);
  const trash = trashEnabled
    ? new TrashManager(stateDir, { retentionDays: pluginConfig.trashRetentionDays ?? 7 })
    : null;

  // Stats for observability
  let totalAssessed = 0;
  let blockedCount = 0;
  let autoApprovedCount = 0;
  let trashInterceptions = 0;

  // =========================================================================
  // Hook: before_tool_call
  // =========================================================================

  api.on(
    "before_tool_call",
    (event, ctx) => {
      const { toolName, params } = event;
      totalAssessed++;

      const assessment = assessRisk(toolName, params);
      const paramsHash = store.computeHash(toolName, params);

      // --- Level 0: silent pass-through ---
      if (assessment.level === 0) {
        return { params };
      }

      // --- Level 1: silent + log ---
      if (assessment.level === 1) {
        api.logger.info(
          `risk-levels: L1 ${toolName} — ${assessment.reason}`,
        );
        return { params };
      }

      // --- Level 2: auto-approve after N consecutive approvals ---
      if (assessment.level === 2) {
        if (store.isTrusted(toolName, paramsHash, autoApproveThreshold)) {
          autoApprovedCount++;
          api.logger.info(
            `risk-levels: L2 auto-approved ${toolName} (trusted, ${store.consecutiveApprovals(toolName, paramsHash)} consecutive approvals)`,
          );
          return { params };
        }
        // Not yet trusted — pass through to existing approval flow.
        // The after_tool_call hook will record the outcome to build trust.
        return { params };
      }

      // --- Level 3: check allow-always, then check progressive trust ---
      if (assessment.level === 3) {
        if (store.isAllowAlways(toolName, paramsHash)) {
          autoApprovedCount++;
          api.logger.info(
            `risk-levels: L3 allow-always ${toolName}`,
          );
          return { params };
        }
        // Also check progressive trust: if L3 tool has been approved enough
        // times consecutively, treat it like a trusted L2 (skip approval).
        if (store.isTrusted(toolName, paramsHash, autoApproveThreshold)) {
          autoApprovedCount++;
          api.logger.info(
            `risk-levels: L3 auto-approved ${toolName} (progressive trust, ${store.consecutiveApprovals(toolName, paramsHash)} consecutive approvals)`,
          );
          return { params };
        }
        // Delegate to existing approval flow.
        // The after_tool_call hook will record the outcome to build trust.
        return { params };
      }

      // --- Level 4: always confirm, no allow-always ---
      if (assessment.level === 4) {
        // Intercept file deletions → trash
        if (trash && isFileDeletion(toolName, params)) {
          const filePath = extractDeletionPath(toolName, params);
          if (filePath) {
            const trashPath = trash.moveToTrash(filePath);
            if (trashPath) {
              trashInterceptions++;
              api.logger.info(
                `risk-levels: L4 file moved to trash: ${filePath} → ${trashPath}`,
              );
              // Block the original deletion, return success-like message
              return {
                block: true,
                blockReason:
                  `[Risk Level 4] File moved to trash instead of deleting: ${filePath}\n` +
                  `Trash path: ${trashPath}\n` +
                  `Files in trash are auto-cleaned after ${pluginConfig.trashRetentionDays ?? 7} days.`,
              };
            }
          }
        }
        // Level 4 should NOT offer allow-always — pass params unmodified
        return { params };
      }

      // --- Level 5: block and require explicit double confirmation ---
      if (assessment.level === 5) {
        blockedCount++;
        return {
          block: true,
          blockReason:
            `[Risk Level 5 — CRITICAL] This action requires explicit double confirmation.\n` +
            `Tool: ${toolName}\n` +
            `Reason: ${assessment.reason}\n` +
            `Rules: ${assessment.rules}\n\n` +
            `The agent cannot auto-approve Level 5 operations. ` +
            `Please use the approval UI to explicitly confirm this action.`,
        };
      }

      // Fallback: pass through without modification
      return { params };
    },
    { priority: 100 }, // High priority: run before other hooks
  );

  // =========================================================================
  // Hook: after_tool_call — record outcomes
  // =========================================================================

  api.on(
    "after_tool_call",
    (event, ctx) => {
      const { toolName, params, error } = event;
      const paramsHash = store.computeHash(toolName, params);
      // Re-assess risk (pure function, no side effects) instead of reading from params
      const assessment = assessRisk(toolName, params);

      // Only record for Level 2+ (Level 0-1 don't need approval tracking)
      if (assessment.level >= 2) {
        if (!error) {
          // Tool executed successfully → user approved it (or it was auto-approved).
          // This feeds the consecutive approval counter for progressive trust.
          store.recordApproval(toolName, paramsHash, assessment.level, ctx.agentId);
        } else {
          // Tool errored → record as denial to break the consecutive chain.
          store.recordDenial(toolName, paramsHash, assessment.level, ctx.agentId);
        }
      }

      // Handle allow-always decisions from the approval system
      if (assessment.level === 3 && params._riskAllowAlways === true) {
        store.addAllowAlways(toolName, paramsHash, ctx.agentId);
        api.logger.info(
          `risk-levels: added allow-always for ${toolName} (hash: ${paramsHash})`,
        );
      }
    },
    { priority: 100 },
  );

  // =========================================================================
  // Hook: before_prompt_build — inject risk context
  // =========================================================================

  if (promptInjection) {
    let riskConfigContent: string | null = null;
    try {
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const configPath = path.join(thisDir, "risk-config.md");
      riskConfigContent = readFileSync(configPath, "utf-8");
    } catch {
      // Fallback: try resolving from the api source path
      try {
        const configPath = path.resolve(path.dirname(api.source), "risk-config.md");
        riskConfigContent = readFileSync(configPath, "utf-8");
      } catch {
        api.logger.warn("risk-levels: could not read risk-config.md for prompt injection");
      }
    }

    if (riskConfigContent) {
      api.on(
        "before_prompt_build",
        (_event, _ctx) => {
          return {
            prependContext: `<risk-level-policy>\n${riskConfigContent}\n</risk-level-policy>`,
          };
        },
        { priority: 50 },
      );
    }
  }

  // =========================================================================
  // Periodic stats logging
  // =========================================================================

  const statsInterval = setInterval(() => {
    if (totalAssessed === 0) return;
    api.logger.info(
      `risk-levels: ${totalAssessed} assessed, ${blockedCount} blocked, ` +
        `${autoApprovedCount} auto-approved, ${trashInterceptions} trash interceptions`,
    );
  }, 5 * 60 * 1000);
  statsInterval.unref?.();

  api.logger.info(
    `risk-levels: initialized (threshold=${autoApproveThreshold}, trash=${trashEnabled}, prompt=${promptInjection})`,
  );
}

// ---------------------------------------------------------------------------
// Helpers: file deletion detection
// ---------------------------------------------------------------------------

function isFileDeletion(toolName: string, params: Record<string, unknown>): boolean {
  if (toolName === "bash") {
    const cmd = (params.command as string) ?? "";
    return /\brm\s+/.test(cmd);
  }
  // Direct rm tool
  if (toolName === "rm" || toolName === "remove" || toolName === "delete") {
    return true;
  }
  return false;
}

function extractDeletionPath(toolName: string, params: Record<string, unknown>): string | null {
  if (toolName === "bash") {
    const cmd = (params.command as string) ?? "";
    // Extract the last argument from rm commands (simplified)
    const match = cmd.match(/\brm\s+(?:-\S+\s+)*(.+)/);
    if (match?.[1]) {
      // Take the first non-flag argument
      const args = match[1].trim().split(/\s+/).filter((a) => !a.startsWith("-"));
      let firstArg = args[0] ?? null;
      if (firstArg) {
        // Strip surrounding quotes (single or double)
        firstArg = firstArg.replace(/^(['"])(.*)\1$/, "$2");
      }
      return firstArg;
    }
    return null;
  }
  // Direct file path from params
  return (params.path as string) ?? (params.filePath as string) ?? null;
}
