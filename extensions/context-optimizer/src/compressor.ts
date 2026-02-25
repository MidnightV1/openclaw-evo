/**
 * Tool result compressor.
 *
 * For exploration-classified results:
 * - Strip `details` field entirely
 * - Truncate content text to a summary
 * - Preserve error messages (first N chars)
 * - Add compression metadata
 */

type ContentBlock = { type: string; text?: string; [key: string]: unknown };

type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  isError: boolean;
  content?: ContentBlock[];
  details?: unknown;
  timestamp?: number;
  [key: string]: unknown;
};

export type CompressionStats = {
  originalChars: number;
  compressedChars: number;
  reason: string;
};

/**
 * Extract text content from a tool result message.
 */
export function extractContentText(message: ToolResultMessage): string {
  if (!message.content || !Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("\n");
}

/**
 * Compress an exploration tool result.
 * Returns the modified message and compression stats.
 */
export function compressExploration(
  message: ToolResultMessage,
  opts: { maxSummaryChars: number; reason: string },
): { message: ToolResultMessage; stats: CompressionStats } {
  const originalText = extractContentText(message);
  const originalChars = originalText.length + estimateDetailsSize(message.details);

  // Strip details entirely
  const { details: _stripped, ...rest } = message;

  // Build summary
  let summary: string;
  if (message.isError) {
    // For errors: keep first and last lines (error message + context)
    summary = summarizeError(originalText, opts.maxSummaryChars);
  } else {
    // For non-error exploration: keep head + tail
    summary = summarizeHeadTail(originalText, opts.maxSummaryChars);
  }

  const compressedMessage: ToolResultMessage = {
    ...rest,
    content: [
      {
        type: "text",
        text: summary,
      },
    ],
  };

  return {
    message: compressedMessage,
    stats: {
      originalChars,
      compressedChars: summary.length,
      reason: opts.reason,
    },
  };
}

function summarizeError(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const lines = text.split("\n");
  // Keep first line (usually the error message) and last few lines (stack trace tail)
  const head = lines[0] ?? "";
  const tailBudget = maxChars - head.length - 30; // 30 for separator
  if (tailBudget <= 0) {
    return head.slice(0, maxChars);
  }
  const tailLines: string[] = [];
  let tailLen = 0;
  for (let i = lines.length - 1; i > 0; i--) {
    const line = lines[i]!;
    if (tailLen + line.length + 1 > tailBudget) {
      break;
    }
    tailLines.unshift(line);
    tailLen += line.length + 1;
  }
  const omitted = lines.length - 1 - tailLines.length;
  return `${head}\n[... ${omitted} lines omitted ...]\n${tailLines.join("\n")}`;
}

function summarizeHeadTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const headBudget = Math.floor(maxChars * 0.6);
  const tailBudget = maxChars - headBudget - 40; // separator
  const head = text.slice(0, headBudget);
  const tail = tailBudget > 0 ? text.slice(-tailBudget) : "";
  const omitted = text.length - headBudget - tailBudget;
  return `${head}\n[... ${omitted} chars omitted ...]\n${tail}`;
}

function estimateDetailsSize(details: unknown): number {
  if (!details) {
    return 0;
  }
  try {
    return JSON.stringify(details).length;
  } catch {
    return 0;
  }
}
