/**
 * OpenClaw Observability Plugin
 *
 * Provides:
 * - Full LLM call logging with agent attribution
 * - Token usage tracking and cost estimation
 * - Two-layer storage: stats (permanent) + raw (7-day retention)
 * - Raw data cleanup via periodic sweep
 */

import fs from "node:fs";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createCallLogger } from "./src/logger.js";
import { loadPricingOverrides, type PricingConfig } from "./src/pricing.js";

type ObservabilityConfig = {
  rawRetentionDays?: number;
  statsRetentionDays?: number;
  pricingConfigPath?: string;
  statsDir?: string;
  rawDir?: string;
};

function resolveAgentIdFromSessionKey(sessionKey?: string): {
  agentId?: string;
  parentAgentId?: string;
  isSubagent: boolean;
} {
  if (!sessionKey) {
    return { isSubagent: false };
  }
  const isSubagent = sessionKey.includes("subagent:");
  // Session key format: agent:{agentId}:subagent:{uuid} or agent:{agentId}:chat:{id}
  const match = sessionKey.match(/^(?:agent:)?([^:]+)/);
  const agentId = match?.[1];
  // For subagents, the parent is in the requester session key (not directly available here)
  return { agentId, isSubagent };
}

export default function register(api: OpenClawPluginApi) {
  const pluginConfig = (api.config?.plugins?.observability ?? {}) as ObservabilityConfig;
  const rawRetentionDays = pluginConfig.rawRetentionDays ?? 7;

  // Resolve paths — use configured values if provided, otherwise defaults.
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "~", ".openclaw");
  const statsDir = pluginConfig.statsDir || path.join(stateDir, "observability", "stats");
  const rawDir = pluginConfig.rawDir || path.join(stateDir, "observability", "raw");

  // Load custom pricing if configured
  if (pluginConfig.pricingConfigPath) {
    try {
      const raw = fs.readFileSync(pluginConfig.pricingConfigPath, "utf-8");
      const overrides = JSON.parse(raw) as PricingConfig;
      loadPricingOverrides(overrides);
    } catch {
      // Fall back to default pricing
    }
  }

  const logger = createCallLogger({ statsDir, rawDir, rawRetentionDays });

  // Log resolved paths so they are discoverable by agents/users.
  api.logger.info(
    `[observability] resolvedPaths: statsDir=${statsDir}, rawDir=${rawDir}`,
  );

  // Hook: LLM Input — record request start
  api.on("llm_input", (event, ctx) => {
    const { agentId } = resolveAgentIdFromSessionKey(ctx.sessionKey);
    logger.recordInput({
      runId: event.runId,
      sessionId: event.sessionId,
      sessionKey: ctx.sessionKey,
      provider: event.provider,
      model: event.model,
      systemPrompt: event.systemPrompt,
      prompt: event.prompt,
      historyMessages: event.historyMessages,
      agentId,
    });
  });

  // Hook: LLM Output — record response + compute cost
  api.on("llm_output", (event, ctx) => {
    logger.recordOutput({
      runId: event.runId,
      sessionId: event.sessionId,
      provider: event.provider,
      model: event.model,
      assistantTexts: event.assistantTexts,
      lastAssistant: event.lastAssistant,
      usage: event.usage,
    });
  });

  // Periodic raw log cleanup (every 6 hours)
  const cleanupInterval = setInterval(() => {
    logger.cleanupRawLogs();
  }, 6 * 60 * 60 * 1000);
  cleanupInterval.unref?.();

  // Initial cleanup on load
  logger.cleanupRawLogs();
}
