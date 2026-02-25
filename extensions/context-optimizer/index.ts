/**
 * Context Optimizer Plugin — Phase 1: Incremental Process Compression
 *
 * Classifies each tool result as "conclusion" (useful) or "exploration" (noise),
 * then compresses exploration results before persistence to extend effective
 * context window lifetime.
 *
 * Hook: tool_result_persist (synchronous, before session write)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { classifyToolResult } from "./src/classifier.js";
import { compressExploration, extractContentText, type CompressionStats } from "./src/compressor.js";

type ContextOptimizerConfig = {
  enabled?: boolean;
  explorationSummaryMaxChars?: number;
  retryDeduplication?: boolean;
};

type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  isError: boolean;
  content?: { type: string; text?: string; [key: string]: unknown }[];
  details?: unknown;
  timestamp?: number;
  [key: string]: unknown;
};

// Per-session sliding window for retry detection
const recentCalls = new Map<
  string,
  { toolName: string; params: string; callId: string }
>();

// Compression statistics (per session, for observability)
let totalOriginalChars = 0;
let totalCompressedChars = 0;
let conclusionCount = 0;
let explorationCount = 0;

export default function register(api: OpenClawPluginApi) {
  const pluginConfig = (api.config?.plugins?.["context-optimizer"] ?? {}) as ContextOptimizerConfig;
  const enabled = pluginConfig.enabled !== false;
  const maxSummaryChars = pluginConfig.explorationSummaryMaxChars ?? 500;
  const retryDedup = pluginConfig.retryDeduplication !== false;

  if (!enabled) {
    return;
  }

  api.on(
    "tool_result_persist",
    (event, ctx) => {
      const message = event.message as ToolResultMessage;
      if (!message || message.role !== "toolResult") {
        return;
      }

      const sessionKey = ctx.sessionKey ?? "default";
      const toolName = event.toolName ?? message.toolName ?? "";
      const contentText = extractContentText(message);

      // Resolve previous call for retry detection
      const prev = recentCalls.get(sessionKey);
      const currentParams = JSON.stringify(
        (event as { params?: unknown }).params ?? toolName,
      );

      const classification = classifyToolResult({
        toolName,
        isError: message.isError,
        contentText,
        prevToolName: prev?.toolName,
        prevToolParams: prev?.params,
        currentToolParams: retryDedup ? currentParams : undefined,
      });

      // Update recent call tracker
      recentCalls.set(sessionKey, {
        toolName,
        params: currentParams,
        callId: message.toolCallId,
      });

      if (classification.type === "conclusion") {
        conclusionCount++;
        return; // Keep original message unchanged
      }

      // Compress exploration result
      explorationCount++;
      const { message: compressed, stats } = compressExploration(message, {
        maxSummaryChars: maxSummaryChars,
        reason: classification.reason,
      });

      totalOriginalChars += stats.originalChars;
      totalCompressedChars += stats.compressedChars;

      return { message: compressed };
    },
    { priority: 50 },
  );

  // Periodic stats logging (every 5 minutes)
  const statsInterval = setInterval(() => {
    if (conclusionCount + explorationCount === 0) {
      return;
    }
    const savedChars = totalOriginalChars - totalCompressedChars;
    const ratio =
      totalOriginalChars > 0
        ? ((savedChars / totalOriginalChars) * 100).toFixed(1)
        : "0";
    api.logger.info(
      `context-optimizer: ${conclusionCount} conclusions, ${explorationCount} explorations, ` +
        `saved ${savedChars.toLocaleString()} chars (${ratio}% reduction)`,
    );
  }, 5 * 60 * 1000);
  statsInterval.unref?.();
}
