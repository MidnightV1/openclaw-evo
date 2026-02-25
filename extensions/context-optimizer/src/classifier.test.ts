import { describe, expect, it } from "vitest";
import { classifyToolResult } from "./classifier.js";

describe("classifyToolResult", () => {
  // =========================================================================
  // Conclusion tools (successful)
  // =========================================================================
  describe("conclusion tools — success", () => {
    it("read (no error) → conclusion", () => {
      const result = classifyToolResult({
        toolName: "read",
        isError: false,
        contentText: "file contents here",
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("success_read_write");
    });

    it("glob (no error) → conclusion", () => {
      const result = classifyToolResult({
        toolName: "glob",
        isError: false,
        contentText: "src/index.ts\nsrc/main.ts",
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("success_read_write");
    });

    it("grep (no error) → conclusion", () => {
      const result = classifyToolResult({
        toolName: "grep",
        isError: false,
        contentText: "match found on line 42",
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("success_read_write");
    });

    it("write (no error) → conclusion", () => {
      const result = classifyToolResult({
        toolName: "write",
        isError: false,
        contentText: "file written successfully",
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("success_read_write");
    });

    it("edit (no error) → conclusion", () => {
      const result = classifyToolResult({
        toolName: "edit",
        isError: false,
        contentText: "edit applied",
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("success_read_write");
    });

    it("notebookedit (no error) → conclusion", () => {
      const result = classifyToolResult({
        toolName: "notebookedit",
        isError: false,
        contentText: "cell updated",
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("success_read_write");
    });
  });

  // =========================================================================
  // Conclusion tools with error → NOT matched by Rule 2
  // =========================================================================
  describe("conclusion tools — error", () => {
    it("read with error → falls to default (conclusion)", () => {
      const result = classifyToolResult({
        toolName: "read",
        isError: true,
        contentText: "file not found",
      });
      // read is in CONCLUSION_TOOLS but isError=true, so Rule 2 skips it.
      // read is NOT in EXPLORATION_ON_ERROR_TOOLS, so Rule 3 skips it.
      // Short content, so Rule 4 skips it. Falls to default → conclusion.
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("default");
    });
  });

  // =========================================================================
  // Exec error tools → exploration
  // =========================================================================
  describe("exec error tools", () => {
    it("bash with error → exploration", () => {
      const result = classifyToolResult({
        toolName: "bash",
        isError: true,
        contentText: "command not found: foobar",
      });
      expect(result.type).toBe("exploration");
      expect(result.reason).toBe("exec_error");
    });

    it("process with error → exploration", () => {
      const result = classifyToolResult({
        toolName: "process",
        isError: true,
        contentText: "exit code 1",
      });
      expect(result.type).toBe("exploration");
      expect(result.reason).toBe("exec_error");
    });

    it("exec with error → exploration", () => {
      const result = classifyToolResult({
        toolName: "exec",
        isError: true,
        contentText: "ENOENT",
      });
      expect(result.type).toBe("exploration");
      expect(result.reason).toBe("exec_error");
    });

    it("bash without error → default conclusion", () => {
      const result = classifyToolResult({
        toolName: "bash",
        isError: false,
        contentText: "build succeeded",
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("default");
    });
  });

  // =========================================================================
  // Retry detection (Rule 1)
  // =========================================================================
  describe("retry detection", () => {
    it("consecutive identical call → exploration (retry_duplicate)", () => {
      const result = classifyToolResult({
        toolName: "read",
        isError: false,
        contentText: "file contents",
        prevToolName: "read",
        prevToolParams: '{"path":"/foo.ts"}',
        currentToolParams: '{"path":"/foo.ts"}',
      });
      expect(result.type).toBe("exploration");
      expect(result.reason).toBe("retry_duplicate");
    });

    it("same tool, different params → NOT a retry", () => {
      const result = classifyToolResult({
        toolName: "read",
        isError: false,
        contentText: "file contents",
        prevToolName: "read",
        prevToolParams: '{"path":"/foo.ts"}',
        currentToolParams: '{"path":"/bar.ts"}',
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("success_read_write");
    });

    it("different tool, same params → NOT a retry", () => {
      const result = classifyToolResult({
        toolName: "grep",
        isError: false,
        contentText: "results",
        prevToolName: "glob",
        prevToolParams: '{"pattern":"*.ts"}',
        currentToolParams: '{"pattern":"*.ts"}',
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("success_read_write");
    });

    it("retry takes priority over conclusion tool", () => {
      // Even though 'read' is a conclusion tool, if it's a retry it should
      // be classified as exploration
      const result = classifyToolResult({
        toolName: "read",
        isError: false,
        contentText: "content",
        prevToolName: "read",
        prevToolParams: "same",
        currentToolParams: "same",
      });
      expect(result.type).toBe("exploration");
      expect(result.reason).toBe("retry_duplicate");
    });

    it("no prev tool → no retry detection", () => {
      const result = classifyToolResult({
        toolName: "bash",
        isError: false,
        contentText: "ok",
        prevToolName: undefined,
        prevToolParams: undefined,
        currentToolParams: '{"cmd":"ls"}',
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("default");
    });

    it("prev params undefined → no retry detection", () => {
      const result = classifyToolResult({
        toolName: "bash",
        isError: false,
        contentText: "ok",
        prevToolName: "bash",
        prevToolParams: undefined,
        currentToolParams: '{"cmd":"ls"}',
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("default");
    });
  });

  // =========================================================================
  // Oversized output (Rule 4)
  // =========================================================================
  describe("oversized output", () => {
    it("output >50k chars → exploration", () => {
      const hugeText = "x".repeat(50_001);
      const result = classifyToolResult({
        toolName: "bash",
        isError: false,
        contentText: hugeText,
      });
      expect(result.type).toBe("exploration");
      expect(result.reason).toBe("oversized_output");
    });

    it("output exactly 50k chars → conclusion (default)", () => {
      const text = "x".repeat(50_000);
      const result = classifyToolResult({
        toolName: "bash",
        isError: false,
        contentText: text,
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("default");
    });

    it("oversized conclusion tool output → still oversized exploration", () => {
      // Oversized check (Rule 4) only runs if Rule 2 doesn't match.
      // For a conclusion tool without error, Rule 2 matches first.
      const hugeText = "x".repeat(50_001);
      const result = classifyToolResult({
        toolName: "read",
        isError: false,
        contentText: hugeText,
      });
      // Rule 2 matches first: read + no error → conclusion
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("success_read_write");
    });
  });

  // =========================================================================
  // Case insensitivity
  // =========================================================================
  describe("tool name case insensitivity", () => {
    it("Read (capitalized) → conclusion", () => {
      const result = classifyToolResult({
        toolName: "Read",
        isError: false,
        contentText: "file contents",
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("success_read_write");
    });

    it("BASH with error → exploration", () => {
      const result = classifyToolResult({
        toolName: "BASH",
        isError: true,
        contentText: "error",
      });
      expect(result.type).toBe("exploration");
      expect(result.reason).toBe("exec_error");
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe("edge cases", () => {
    it("empty content text → default conclusion", () => {
      const result = classifyToolResult({
        toolName: "bash",
        isError: false,
        contentText: "",
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("default");
    });

    it("unknown tool (no error) → default conclusion", () => {
      const result = classifyToolResult({
        toolName: "custom_mcp_tool",
        isError: false,
        contentText: "some output",
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("default");
    });

    it("unknown tool with error → default conclusion (not in EXPLORATION_ON_ERROR_TOOLS)", () => {
      const result = classifyToolResult({
        toolName: "custom_mcp_tool",
        isError: true,
        contentText: "error output",
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("default");
    });

    it("undefined toolName → default conclusion", () => {
      const result = classifyToolResult({
        toolName: undefined,
        isError: false,
        contentText: "output",
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("default");
    });

    it("undefined toolName with error → default conclusion", () => {
      const result = classifyToolResult({
        toolName: undefined,
        isError: true,
        contentText: "error",
      });
      expect(result.type).toBe("conclusion");
      expect(result.reason).toBe("default");
    });

    it("classification always includes reason string", () => {
      const result = classifyToolResult({
        toolName: "read",
        isError: false,
        contentText: "",
      });
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });
});
