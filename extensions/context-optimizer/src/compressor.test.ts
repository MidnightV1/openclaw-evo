import { describe, expect, it } from "vitest";
import { compressExploration, extractContentText } from "./compressor.js";

// Helper to build a ToolResultMessage
function makeMessage(overrides: {
  text?: string;
  isError?: boolean;
  details?: unknown;
  toolName?: string;
  content?: { type: string; text?: string; [key: string]: unknown }[];
}) {
  return {
    role: "toolResult" as const,
    toolCallId: "call-1",
    toolName: overrides.toolName ?? "bash",
    isError: overrides.isError ?? false,
    content: overrides.content ?? [{ type: "text", text: overrides.text ?? "" }],
    details: overrides.details,
  };
}

// =========================================================================
// extractContentText
// =========================================================================
describe("extractContentText", () => {
  it("extracts text from a single text block", () => {
    const msg = makeMessage({ text: "hello world" });
    expect(extractContentText(msg)).toBe("hello world");
  });

  it("joins multiple text blocks with newline", () => {
    const msg = makeMessage({
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
    });
    expect(extractContentText(msg)).toBe("line one\nline two");
  });

  it("skips non-text blocks", () => {
    const msg = makeMessage({
      content: [
        { type: "image", data: "base64..." },
        { type: "text", text: "visible" },
      ],
    });
    expect(extractContentText(msg)).toBe("visible");
  });

  it("returns empty string for undefined content", () => {
    const msg = { role: "toolResult" as const, toolCallId: "c", isError: false };
    expect(extractContentText(msg as any)).toBe("");
  });

  it("returns empty string for empty content array", () => {
    const msg = makeMessage({ content: [] });
    expect(extractContentText(msg)).toBe("");
  });

  it("skips text blocks where text is not a string", () => {
    const msg = makeMessage({
      content: [
        { type: "text", text: 123 as any },
        { type: "text", text: "valid" },
      ],
    });
    expect(extractContentText(msg)).toBe("valid");
  });
});

// =========================================================================
// compressExploration — basic behavior
// =========================================================================
describe("compressExploration", () => {
  describe("short content (under maxSummaryChars)", () => {
    it("preserves short non-error content unchanged", () => {
      const msg = makeMessage({ text: "short output" });
      const { message, stats } = compressExploration(msg, {
        maxSummaryChars: 500,
        reason: "exec_error",
      });
      const text = extractContentText(message);
      expect(text).toBe("short output");
      expect(stats.compressedChars).toBe("short output".length);
    });

    it("preserves short error content unchanged", () => {
      const msg = makeMessage({ text: "Error: not found", isError: true });
      const { message } = compressExploration(msg, {
        maxSummaryChars: 500,
        reason: "exec_error",
      });
      expect(extractContentText(message)).toBe("Error: not found");
    });
  });

  describe("details stripping", () => {
    it("strips details field entirely", () => {
      const msg = makeMessage({
        text: "output",
        details: { verbose: true, stackFrames: ["a", "b", "c"] },
      });
      const { message } = compressExploration(msg, {
        maxSummaryChars: 500,
        reason: "oversized_output",
      });
      expect(message.details).toBeUndefined();
    });

    it("includes details size in originalChars", () => {
      const details = { key: "value" };
      const msg = makeMessage({ text: "output", details });
      const { stats } = compressExploration(msg, {
        maxSummaryChars: 500,
        reason: "test",
      });
      expect(stats.originalChars).toBe(
        "output".length + JSON.stringify(details).length,
      );
    });

    it("handles undefined details gracefully", () => {
      const msg = makeMessage({ text: "output" });
      const { stats } = compressExploration(msg, {
        maxSummaryChars: 500,
        reason: "test",
      });
      expect(stats.originalChars).toBe("output".length);
    });
  });

  describe("compression stats", () => {
    it("returns correct stats for compressed content", () => {
      const longText = "x".repeat(1000);
      const msg = makeMessage({ text: longText });
      const { stats } = compressExploration(msg, {
        maxSummaryChars: 200,
        reason: "oversized_output",
      });
      expect(stats.originalChars).toBe(1000);
      expect(stats.compressedChars).toBeLessThan(1000);
      expect(stats.reason).toBe("oversized_output");
    });

    it("reason is passed through to stats", () => {
      const msg = makeMessage({ text: "x" });
      const { stats } = compressExploration(msg, {
        maxSummaryChars: 500,
        reason: "retry_duplicate",
      });
      expect(stats.reason).toBe("retry_duplicate");
    });
  });

  describe("message structure preservation", () => {
    it("preserves role, toolCallId, toolName, isError", () => {
      const msg = makeMessage({ text: "output", toolName: "bash", isError: true });
      const { message } = compressExploration(msg, {
        maxSummaryChars: 500,
        reason: "test",
      });
      expect(message.role).toBe("toolResult");
      expect(message.toolCallId).toBe("call-1");
      expect(message.toolName).toBe("bash");
      expect(message.isError).toBe(true);
    });

    it("collapses multi-block content into single text block", () => {
      const msg = makeMessage({
        content: [
          { type: "text", text: "block one" },
          { type: "text", text: "block two" },
        ],
      });
      const { message } = compressExploration(msg, {
        maxSummaryChars: 500,
        reason: "test",
      });
      expect(message.content).toHaveLength(1);
      expect(message.content![0]!.type).toBe("text");
    });
  });
});

// =========================================================================
// compressExploration — head/tail preservation (non-error)
// =========================================================================
describe("compressExploration — head/tail summarization", () => {
  it("truncates long non-error output with head + tail", () => {
    // Build text that's clearly longer than max
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}: ${"data".repeat(10)}`);
    const longText = lines.join("\n");
    const msg = makeMessage({ text: longText });

    const { message } = compressExploration(msg, {
      maxSummaryChars: 300,
      reason: "oversized_output",
    });
    const compressed = extractContentText(message);

    expect(compressed.length).toBeLessThan(longText.length);
    // Should contain the omission marker
    expect(compressed).toContain("chars omitted");
    // Head portion should start with beginning of original text
    expect(compressed.startsWith("line 1:")).toBe(true);
  });

  it("preserves exact text when under maxSummaryChars", () => {
    const shortText = "line 1\nline 2\nline 3";
    const msg = makeMessage({ text: shortText });
    const { message } = compressExploration(msg, {
      maxSummaryChars: 500,
      reason: "test",
    });
    expect(extractContentText(message)).toBe(shortText);
  });

  it("head gets ~60% of budget, tail gets the rest", () => {
    const longText = "A".repeat(200) + "B".repeat(200) + "C".repeat(200);
    const msg = makeMessage({ text: longText });
    const maxChars = 300;

    const { message } = compressExploration(msg, {
      maxSummaryChars: maxChars,
      reason: "test",
    });
    const compressed = extractContentText(message);

    // Head budget = floor(300 * 0.6) = 180
    // The compressed text should start with 180 A's
    expect(compressed.startsWith("A".repeat(180))).toBe(true);
  });
});

// =========================================================================
// compressExploration — error summarization
// =========================================================================
describe("compressExploration — error summarization", () => {
  it("keeps first line (error message) and last lines (stack tail)", () => {
    const errorLines = [
      "Error: Cannot find module 'foobar'",
      "    at require (internal/modules.js:1)",
      "    at Object.<anonymous> (app.js:10)",
      "    at Module._compile (internal/modules.js:2)",
      "    at Module._extensions (internal/modules.js:3)",
      "    at Module.load (internal/modules.js:4)",
      "    at Function.Module._load (internal/modules.js:5)",
      "    at Module.require (internal/modules.js:6)",
      "    at require (helpers.js:1)",
      "    at Object.<anonymous> (index.js:1)",
    ];
    const errorText = errorLines.join("\n");
    const msg = makeMessage({ text: errorText, isError: true });

    const { message } = compressExploration(msg, {
      maxSummaryChars: 200,
      reason: "exec_error",
    });
    const compressed = extractContentText(message);

    // Should contain the first line (error message)
    expect(compressed).toContain("Error: Cannot find module 'foobar'");
    // Should contain the omission marker
    expect(compressed).toContain("lines omitted");
    // Should contain some tail lines
    expect(compressed).toContain("index.js:1");
  });

  it("preserves short error text unchanged", () => {
    const msg = makeMessage({ text: "Error: ENOENT", isError: true });
    const { message } = compressExploration(msg, {
      maxSummaryChars: 500,
      reason: "exec_error",
    });
    expect(extractContentText(message)).toBe("Error: ENOENT");
  });

  it("truncates to head only when first line exhausts budget", () => {
    // Single very long error line
    const longFirstLine = "Error: " + "x".repeat(300);
    const errorText = longFirstLine + "\n    at some stack frame";
    const msg = makeMessage({ text: errorText, isError: true });

    const { message } = compressExploration(msg, {
      maxSummaryChars: 100,
      reason: "exec_error",
    });
    const compressed = extractContentText(message);

    // When tailBudget <= 0, it slices the head to maxChars
    expect(compressed.length).toBe(100);
    expect(compressed.startsWith("Error: ")).toBe(true);
  });
});

// =========================================================================
// compressExploration — empty / minimal content
// =========================================================================
describe("compressExploration — edge cases", () => {
  it("handles empty content text", () => {
    const msg = makeMessage({ text: "" });
    const { message, stats } = compressExploration(msg, {
      maxSummaryChars: 500,
      reason: "test",
    });
    expect(extractContentText(message)).toBe("");
    expect(stats.compressedChars).toBe(0);
  });

  it("handles message with no content blocks", () => {
    const msg = makeMessage({ content: [] });
    const { message, stats } = compressExploration(msg, {
      maxSummaryChars: 500,
      reason: "test",
    });
    expect(extractContentText(message)).toBe("");
    expect(stats.originalChars).toBe(0);
    expect(stats.compressedChars).toBe(0);
  });

  it("handles maxSummaryChars of 0 — separator overhead may exceed original", () => {
    const msg = makeMessage({ text: "some content" });
    const { message, stats } = compressExploration(msg, {
      maxSummaryChars: 0,
      reason: "test",
    });
    const compressed = extractContentText(message);
    // With budget 0: headBudget=0, tailBudget=negative (clamped), so
    // only the "[... N chars omitted ...]" separator is emitted.
    // The separator itself has overhead, which is expected.
    expect(compressed).toContain("chars omitted");
    expect(stats.reason).toBe("test");
  });
});
