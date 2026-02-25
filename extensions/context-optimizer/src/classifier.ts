/**
 * Tool result classifier: conclusion vs exploration.
 *
 * Conclusions are kept intact — they contain information the agent needs.
 * Explorations are compressed — their process details are noise.
 */

export type Classification = "conclusion" | "exploration";

export type ClassifyResult = {
  type: Classification;
  /** Why this classification was chosen */
  reason: string;
};

/** Tools whose successful output is almost always a conclusion */
const CONCLUSION_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "write",
  "edit",
  "notebookedit",
]);

/** Tools whose error output is exploratory (debug noise) */
const EXPLORATION_ON_ERROR_TOOLS = new Set([
  "bash",
  "process",
  "exec",
]);

export function classifyToolResult(params: {
  toolName?: string;
  isError: boolean;
  contentText: string;
  /** Previous tool call (for retry detection) */
  prevToolName?: string;
  prevToolParams?: string;
  currentToolParams?: string;
}): ClassifyResult {
  const tool = (params.toolName ?? "").toLowerCase();

  // Rule 1: Consecutive identical tool calls → exploration (retry)
  if (
    params.prevToolName &&
    params.prevToolName === params.toolName &&
    params.prevToolParams &&
    params.prevToolParams === params.currentToolParams
  ) {
    return { type: "exploration", reason: "retry_duplicate" };
  }

  // Rule 2: Conclusion tools with no error → conclusion
  if (CONCLUSION_TOOLS.has(tool) && !params.isError) {
    return { type: "conclusion", reason: "success_read_write" };
  }

  // Rule 3: Bash/exec with error → exploration (debug output)
  if (EXPLORATION_ON_ERROR_TOOLS.has(tool) && params.isError) {
    return { type: "exploration", reason: "exec_error" };
  }

  // Rule 4: Any tool with very large output → exploration (likely verbose dump)
  if (params.contentText.length > 50_000) {
    return { type: "exploration", reason: "oversized_output" };
  }

  // Default: keep as conclusion (conservative — don't lose useful data)
  return { type: "conclusion", reason: "default" };
}
