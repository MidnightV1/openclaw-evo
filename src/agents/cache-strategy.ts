/**
 * Phase 8 — Dynamic cache strategy types and utilities.
 *
 * Provides system prompt segmentation by volatility level and configuration
 * for history sliding window caching, enabling maximum cache hit rates across
 * different LLM providers.
 */

// ---------------------------------------------------------------------------
// System Prompt Block — the atomic unit of segmented caching
// ---------------------------------------------------------------------------

/**
 * Volatility classification for system prompt segments.
 * - "frozen":   Safety rules, tool schemas, core identity — never changes across sessions
 * - "stable":   Project context, memory, skills — stable within a session
 * - "volatile":  Runtime info, workspace notes, heartbeat — may change every turn
 */
export type SystemPromptVolatility = "frozen" | "stable" | "volatile";

/**
 * A segment of the system prompt tagged with its volatility level.
 * The cache layer uses volatility to assign appropriate cache_control directives.
 */
export type SystemPromptBlock = {
  /** The text content of this prompt segment. */
  text: string;
  /** How frequently this segment changes — drives cache_control assignment. */
  volatility: SystemPromptVolatility;
  /** Optional label for debugging / cache tracing. */
  label?: string;
};

// ---------------------------------------------------------------------------
// Cache Strategy Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration knobs for the dynamic cache strategy.
 * All fields have sensible defaults — the strategy is opt-in but zero-config.
 */
export type CacheStrategyConfig = {
  /** Enable system prompt segmentation by volatility. Default: true. */
  systemPromptSegmentation: boolean;
  /** Enable history sliding window breakpoint caching. Default: true. */
  historyWindowCaching: boolean;
  /** Slide the history cache breakpoint every N turns (main agent). Default: 5. */
  windowSlideInterval: number;
  /** Slide the history cache breakpoint every N turns (sub-agents). Default: 2. */
  subagentWindowSlideInterval: number;
  /** Minimum turns before enabling history caching at all. Default: 4. */
  minTurnsForCaching: number;
  /** Minimum turns for sub-agents before enabling history caching. Default: 2. */
  subagentMinTurnsForCaching: number;
};

/** Sensible defaults — cache strategy is active but conservative. */
export const DEFAULT_CACHE_STRATEGY: Readonly<CacheStrategyConfig> = {
  systemPromptSegmentation: true,
  historyWindowCaching: true,
  windowSlideInterval: 5,
  subagentWindowSlideInterval: 2,
  minTurnsForCaching: 4,
  subagentMinTurnsForCaching: 2,
};

/**
 * Merge partial user config with defaults.
 */
export function resolveCacheStrategyConfig(
  partial?: Partial<CacheStrategyConfig>,
): CacheStrategyConfig {
  if (!partial) {
    return { ...DEFAULT_CACHE_STRATEGY };
  }
  return { ...DEFAULT_CACHE_STRATEGY, ...partial };
}

// ---------------------------------------------------------------------------
// Utility: flatten blocks back to a single string (backward compat)
// ---------------------------------------------------------------------------

/**
 * Collapse an array of SystemPromptBlocks into a single string.
 * Used when the provider does not support content blocks (OpenAI, Gemini, etc.)
 * or when backward-compatible string output is needed.
 */
export function flattenSystemPromptBlocks(blocks: SystemPromptBlock[]): string {
  return blocks.map((block) => block.text).join("\n");
}

// ---------------------------------------------------------------------------
// History window breakpoint calculation
// ---------------------------------------------------------------------------

/**
 * Compute the message index where a cache breakpoint should be inserted.
 *
 * Strategy: work backward from the end of the history, and place the
 * breakpoint after every `slideInterval` assistant turns. This creates a
 * "stable prefix" that the provider can cache.
 *
 * The function walks the actual messages array to find the real index of the
 * N-th assistant message, since messages alternate user/assistant and may
 * include tool_use/tool_result pairs — assistant turn N does not correspond
 * to message index N.
 *
 * Returns -1 if caching should be skipped (too few turns).
 */
export function computeHistoryBreakpointIndex(params: {
  /** The actual messages array (only `role` is inspected). */
  messages: Array<{ role?: string }>;
  /** Number of assistant turns so far. */
  assistantTurnCount: number;
  /** Slide interval (turns). */
  slideInterval: number;
  /** Minimum turns required before caching. */
  minTurnsForCaching: number;
}): number {
  const { messages, assistantTurnCount, slideInterval, minTurnsForCaching } = params;
  if (assistantTurnCount < minTurnsForCaching) {
    return -1;
  }
  // Place breakpoint at the last multiple of slideInterval.
  // E.g., with slideInterval=5 and 12 assistant turns, breakpoint after turn 10.
  const breakpointTurn =
    Math.floor((assistantTurnCount - 1) / slideInterval) * slideInterval;
  if (breakpointTurn < 1) {
    return -1;
  }
  // Find the actual message index of the breakpointTurn-th assistant message.
  let assistantsSeen = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant") {
      assistantsSeen++;
      if (assistantsSeen === breakpointTurn) {
        return i;
      }
    }
  }
  return -1;
}
