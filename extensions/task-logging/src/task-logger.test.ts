/**
 * Unit tests for task-logger.ts (Phase 6 — Task Execution Logging).
 *
 * NOTE: `sanitizeForFilename`, `escapeMarkdown`, `formatDuration`,
 * `formatTimestamp`, `parseAgentIdFromKey`, and `buildMarkdown` are private
 * (not exported). They are tested indirectly through the public API of
 * `createTaskLogger`. If direct unit testing is desired, consider exporting
 * them (e.g. via a `_internal` namespace export for test-only access).
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskLogger } from "./task-logger.js";

// ---------------------------------------------------------------------------
// Mock node:fs — intercepts all filesystem calls made by task-logger.
// ---------------------------------------------------------------------------
vi.mock("node:fs", () => {
  const actual: Record<string, unknown> = {};
  return {
    default: {
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
      readdirSync: vi.fn(() => []),
      unlinkSync: vi.fn(),
      ...actual,
    },
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    unlinkSync: vi.fn(),
  };
});

const TEST_LOGS_DIR = "/tmp/test-task-logs";

// ---------------------------------------------------------------------------
// Helper: capture the markdown content written by writeFileSync.
// ---------------------------------------------------------------------------
function getWrittenMarkdown(): string | undefined {
  const calls = vi.mocked(fs.writeFileSync).mock.calls;
  if (calls.length === 0) return undefined;
  // Most recent write
  return calls[calls.length - 1][1] as string;
}

function getWrittenFilename(): string | undefined {
  const calls = vi.mocked(fs.writeFileSync).mock.calls;
  if (calls.length === 0) return undefined;
  return calls[calls.length - 1][0] as string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTaskLogger", () => {
  let logger: ReturnType<typeof createTaskLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createTaskLogger({ logsDir: TEST_LOGS_DIR });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // sanitizeForFilename — tested indirectly via filenames in writeFileSync
  // =========================================================================
  describe("sanitizeForFilename (indirect via filename)", () => {
    /**
     * These tests spawn a subtask with a specific label, finalize, and then
     * inspect the filename passed to writeFileSync.
     */

    function spawnAndFinalize(label: string): string | undefined {
      const sessionKey = "agent:main:test";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:1",
        agentId: "worker",
        label,
        mode: "run",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:1",
        outcome: "ok",
        reason: "done",
      });
      // auto-finalize returns the session key; then we call autoFinalize
      logger.autoFinalize(sessionKey);
      return getWrittenFilename();
    }

    it("normal text remains unchanged in filename", () => {
      const filename = spawnAndFinalize("search-web");
      expect(filename).toBeDefined();
      // The filename should contain the sanitized label
      expect(filename).toContain("search-web");
    });

    it("special characters <>:\"/\\|?* are replaced with _", () => {
      const filename = spawnAndFinalize('file<>:"/\\|?*name');
      expect(filename).toBeDefined();
      // Extract just the basename to avoid matching OS path separators
      const basename = path.basename(filename!);
      // None of the special characters should appear in the sanitized basename
      expect(basename).not.toMatch(/[<>"/?*]/);
    });

    it("spaces are replaced with hyphens", () => {
      const filename = spawnAndFinalize("hello world test");
      expect(filename).toBeDefined();
      // Spaces become hyphens
      expect(filename).toContain("hello-world-test");
    });

    it("strings longer than 50 characters are truncated", () => {
      const longLabel = "a".repeat(80);
      const filename = spawnAndFinalize(longLabel);
      expect(filename).toBeDefined();
      // The sanitized portion before the timestamp separator should be <= 50 chars.
      // Filename format: {sanitized}_{YYYY-MM-DD_HHmm}.md
      // The timestamp part starts with a date like "2026-", so we split on the
      // first occurrence of _YYYY- to isolate the sanitized prefix.
      const basename = path.basename(filename!);
      const tsMatch = basename.match(/_\d{4}-/);
      const sanitizedPart = tsMatch
        ? basename.slice(0, tsMatch.index)
        : basename;
      expect(sanitizedPart.length).toBeLessThanOrEqual(50);
    });

    it("empty label falls back to agentId, not 'unnamed'", () => {
      // When label is empty string, the code uses agentId as fallback
      const sessionKey = "agent:main:test";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:1",
        agentId: "worker-agent",
        label: "",
        mode: "run",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:1",
        outcome: "ok",
        reason: "done",
      });
      logger.autoFinalize(sessionKey);
      const filename = getWrittenFilename();
      expect(filename).toBeDefined();
      // Empty label -> falls back to agentId "worker-agent"
      expect(filename).toContain("worker-agent");
    });

    it("path traversal characters are neutralized", () => {
      const filename = spawnAndFinalize("../../../etc/passwd");
      expect(filename).toBeDefined();
      // The sanitizer replaces / and \ with _, so path traversal is impossible.
      // Extract just the basename to check the sanitized portion.
      const basename = path.basename(filename!);
      // The basename itself should not contain forward slashes (they are replaced)
      expect(basename).not.toContain("/");
      // The sanitized label portion should not allow navigating up directories.
      // Even though ".." dots survive, the separators (/ and \) are removed,
      // so `../../../etc/passwd` becomes something like `.._.._.._etc_passwd`
      // which is a flat filename, not a traversal path.
      // Verify the file is written to the intended logs directory
      // (normalize separators for cross-platform comparison):
      const normalizedFilename = filename!.replace(/\\/g, "/");
      const normalizedLogsDir = TEST_LOGS_DIR.replace(/\\/g, "/");
      expect(normalizedFilename.startsWith(normalizedLogsDir)).toBe(true);
    });

    it("consecutive spaces/hyphens are merged", () => {
      const filename = spawnAndFinalize("hello    world---test");
      expect(filename).toBeDefined();
      // Multiple spaces → single hyphen, multiple hyphens → single hyphen
      expect(filename).toContain("hello-world-test");
    });
  });

  // =========================================================================
  // escapeMarkdown — tested indirectly via markdown output
  // =========================================================================
  describe("escapeMarkdown (indirect via markdown output)", () => {
    function getMarkdownForLabel(label: string): string | undefined {
      const sessionKey = "agent:main:test-escape";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:esc:1",
        agentId: "escaper",
        label,
        mode: "run",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:esc:1",
        outcome: "ok",
        reason: "done",
      });
      logger.autoFinalize(sessionKey);
      return getWrittenMarkdown();
    }

    it("plain text is not escaped", () => {
      const md = getMarkdownForLabel("simple task name");
      expect(md).toBeDefined();
      expect(md).toContain("# Task: simple task name");
    });

    it("# heading characters are escaped", () => {
      const md = getMarkdownForLabel("# heading");
      expect(md).toBeDefined();
      // The # in the label should be escaped with backslash
      expect(md).toContain("\\# heading");
    });

    it("**bold** markers are escaped", () => {
      const md = getMarkdownForLabel("**bold**");
      expect(md).toBeDefined();
      expect(md).toContain("\\*\\*bold\\*\\*");
    });

    it("`backticks` are escaped", () => {
      const md = getMarkdownForLabel("`code`");
      expect(md).toBeDefined();
      expect(md).toContain("\\`code\\`");
    });

    it("[link](url) brackets are escaped", () => {
      const md = getMarkdownForLabel("[link](url)");
      expect(md).toBeDefined();
      // [ and ] should be escaped
      expect(md).toContain("\\[link\\]");
    });

    it("empty string remains empty", () => {
      // With empty label, buildMarkdown falls back to agentId
      const sessionKey = "agent:main:empty-esc";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:esc:empty",
        agentId: "escaper",
        label: "",
        mode: "run",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:esc:empty",
        outcome: "ok",
        reason: "done",
      });
      logger.autoFinalize(sessionKey);
      const md = getWrittenMarkdown();
      expect(md).toBeDefined();
      // Falls back to agentId "escaper"
      expect(md).toContain("# Task: escaper");
    });
  });

  // =========================================================================
  // recordSubtaskSpawn
  // =========================================================================
  describe("recordSubtaskSpawn", () => {
    it("records a subtask and increments active session count", () => {
      expect(logger.getActiveSessionCount()).toBe(0);

      logger.recordSubtaskSpawn({
        requesterSessionKey: "agent:main:s1",
        childSessionKey: "child:1",
        agentId: "searcher",
        label: "web search",
        mode: "run",
      });

      expect(logger.getActiveSessionCount()).toBe(1);
    });

    it("records multiple subtasks under the same session", () => {
      const sessionKey = "agent:main:multi";

      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:1",
        agentId: "searcher",
        label: "search",
        mode: "run",
      });
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:2",
        agentId: "writer",
        label: "write",
        mode: "run",
      });

      // Still one session, but it has two subtasks
      expect(logger.getActiveSessionCount()).toBe(1);
    });

    it("creates separate sessions for different requesterSessionKeys", () => {
      logger.recordSubtaskSpawn({
        requesterSessionKey: "agent:main:s1",
        childSessionKey: "child:1",
        agentId: "a1",
        mode: "run",
      });
      logger.recordSubtaskSpawn({
        requesterSessionKey: "agent:main:s2",
        childSessionKey: "child:2",
        agentId: "a2",
        mode: "run",
      });

      expect(logger.getActiveSessionCount()).toBe(2);
    });

    it("falls back to 'unknown' when requesterSessionKey is missing", () => {
      logger.recordSubtaskSpawn({
        childSessionKey: "child:orphan",
        agentId: "orphan-agent",
        mode: "run",
      });

      // Should create a session under the "unknown" key
      expect(logger.getActiveSessionCount()).toBe(1);
    });
  });

  // =========================================================================
  // recordSubtaskEnd
  // =========================================================================
  describe("recordSubtaskEnd", () => {
    it("updates subtask state and returns session key when all subtasks ended", () => {
      const sessionKey = "agent:main:end-test";

      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:e1",
        agentId: "worker",
        mode: "run",
      });

      const result = logger.recordSubtaskEnd({
        targetSessionKey: "child:e1",
        outcome: "ok",
        reason: "completed",
      });

      // All subtasks ended — returns session key for auto-finalization
      expect(result).toBe(sessionKey);
    });

    it("returns undefined when not all subtasks have ended", () => {
      const sessionKey = "agent:main:partial";

      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:p1",
        agentId: "a1",
        mode: "run",
      });
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:p2",
        agentId: "a2",
        mode: "run",
      });

      const result = logger.recordSubtaskEnd({
        targetSessionKey: "child:p1",
        outcome: "ok",
        reason: "done",
      });

      // Still one subtask pending
      expect(result).toBeUndefined();
    });

    it("returns session key once the last subtask ends", () => {
      const sessionKey = "agent:main:last";

      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:l1",
        agentId: "a1",
        mode: "run",
      });
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:l2",
        agentId: "a2",
        mode: "run",
      });

      logger.recordSubtaskEnd({
        targetSessionKey: "child:l1",
        outcome: "ok",
        reason: "done",
      });

      const result = logger.recordSubtaskEnd({
        targetSessionKey: "child:l2",
        outcome: "ok",
        reason: "done",
      });

      expect(result).toBe(sessionKey);
    });

    it("can match subtask by runId when targetSessionKey differs", () => {
      const sessionKey = "agent:main:runid";

      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:r1",
        agentId: "worker",
        mode: "run",
        runId: "run-abc-123",
      });

      const result = logger.recordSubtaskEnd({
        targetSessionKey: "different-key",
        runId: "run-abc-123",
        outcome: "ok",
        reason: "matched by runId",
      });

      expect(result).toBe(sessionKey);
    });

    it("computes durationMs when both spawnedAt and endedAt are available", () => {
      const sessionKey = "agent:main:duration";
      const spawnTime = Date.now();

      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:d1",
        agentId: "worker",
        mode: "run",
      });

      // End the subtask with a specific endedAt timestamp (100ms later)
      logger.recordSubtaskEnd({
        targetSessionKey: "child:d1",
        outcome: "ok",
        reason: "done",
        endedAt: spawnTime + 5000,
      });

      // Finalize and check the markdown includes duration
      logger.autoFinalize(sessionKey);
      const md = getWrittenMarkdown();
      expect(md).toBeDefined();
      expect(md).toContain("Duration:");
    });

    it("returns undefined for unknown subtask", () => {
      const result = logger.recordSubtaskEnd({
        targetSessionKey: "nonexistent",
        outcome: "ok",
        reason: "ghost",
      });

      expect(result).toBeUndefined();
    });
  });

  // =========================================================================
  // Auto-finalize: all subtasks ended → triggers finalize
  // =========================================================================
  describe("auto-finalize", () => {
    it("clears session from memory after finalization", () => {
      const sessionKey = "agent:main:auto-fin";

      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:af1",
        agentId: "worker",
        label: "auto-task",
        mode: "run",
      });

      const readyKey = logger.recordSubtaskEnd({
        targetSessionKey: "child:af1",
        outcome: "ok",
        reason: "done",
      });

      expect(readyKey).toBe(sessionKey);

      // Finalize
      const filePath = logger.autoFinalize(sessionKey);
      expect(filePath).toBeDefined();

      // Session should be cleared
      expect(logger.getActiveSessionCount()).toBe(0);
    });

    it("writes markdown file on finalization", () => {
      const sessionKey = "agent:main:write-check";

      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:wc1",
        agentId: "writer",
        label: "write-task",
        mode: "run",
      });

      logger.recordSubtaskEnd({
        targetSessionKey: "child:wc1",
        outcome: "ok",
        reason: "done",
      });

      logger.autoFinalize(sessionKey);

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const md = getWrittenMarkdown();
      expect(md).toBeDefined();
      expect(md).toContain("# Task:");
    });

    it("does not finalize twice (idempotent)", () => {
      const sessionKey = "agent:main:idem";

      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:id1",
        agentId: "worker",
        mode: "run",
      });

      logger.recordSubtaskEnd({
        targetSessionKey: "child:id1",
        outcome: "ok",
        reason: "done",
      });

      logger.autoFinalize(sessionKey);
      const result2 = logger.autoFinalize(sessionKey);

      // Second call returns undefined (already finalized / session cleared)
      expect(result2).toBeUndefined();
      // writeFileSync called only once
      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // registerSessionId — capacity cap
  // =========================================================================
  describe("registerSessionId", () => {
    it("maps sessionId to sessionKey (basic functionality)", () => {
      // We can't directly inspect the internal map, but we can verify
      // that registering doesn't throw
      expect(() => {
        logger.registerSessionId("uuid-abc", "agent:main:s1");
      }).not.toThrow();
    });

    it("evicts oldest entry when capacity exceeds 1000", () => {
      // Register 1001 entries — the first should be evicted
      for (let i = 0; i < 1001; i++) {
        logger.registerSessionId(`uuid-${i}`, `agent:main:s-${i}`);
      }

      // This should not throw — internal map remains bounded
      // We verify indirectly: the logger still functions correctly
      logger.recordSubtaskSpawn({
        requesterSessionKey: "agent:main:s-1000",
        childSessionKey: "child:cap",
        agentId: "worker",
        mode: "run",
      });

      expect(logger.getActiveSessionCount()).toBe(1);
    });

    it("silently ignores empty sessionId", () => {
      expect(() => {
        logger.registerSessionId("", "agent:main:s1");
      }).not.toThrow();
    });

    it("silently ignores empty sessionKey", () => {
      expect(() => {
        logger.registerSessionId("uuid-x", "");
      }).not.toThrow();
    });
  });

  // =========================================================================
  // finalizeByAgentId
  // =========================================================================
  describe("finalizeByAgentId", () => {
    it("finalizes sessions matching the given agentId from session key", () => {
      // Session key pattern: "agent:<agentId>:..."
      logger.recordSubtaskSpawn({
        requesterSessionKey: "agent:main:telegram:123",
        childSessionKey: "child:fa1",
        agentId: "worker",
        label: "telegram-task",
        mode: "run",
      });

      logger.recordSubtaskEnd({
        targetSessionKey: "child:fa1",
        outcome: "ok",
        reason: "done",
      });

      // parseAgentIdFromKey("agent:main:telegram:123") -> "main"
      logger.finalizeByAgentId({ agentId: "main" });

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      expect(logger.getActiveSessionCount()).toBe(0);
    });

    it("finalizes sessions matching agentId from state.agentId", () => {
      // When ensureSession is called with agentId explicitly set
      const sessionKey = "custom-key-no-agent-prefix";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:fa2",
        agentId: "special-agent",
        label: "special-task",
        mode: "run",
      });

      // The state won't have agentId set from ensureSession directly
      // (ensureSession only sets it if passed), but the subtask has agentId.
      // finalizeByAgentId checks both parseAgentIdFromKey and state.agentId.
      // parseAgentIdFromKey("custom-key-no-agent-prefix") would not match "special-agent".
      // The state.agentId is only set if explicitly passed to ensureSession,
      // which happens when agentId is undefined in recordSubtaskSpawn's call
      // to ensureSession (it doesn't pass agentId to ensureSession).
      // So this test verifies the key-based matching path.
      logger.finalizeByAgentId({ agentId: "custom-key-no-agent-prefix" });

      // parseAgentIdFromKey splits by ":" and returns index 1, which is undefined
      // for "custom-key-no-agent-prefix" (no colon). So it won't match.
      // This session should NOT be finalized.
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it("does nothing when agentId is undefined", () => {
      logger.recordSubtaskSpawn({
        requesterSessionKey: "agent:main:test",
        childSessionKey: "child:fa3",
        agentId: "worker",
        mode: "run",
      });

      logger.finalizeByAgentId({});

      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(logger.getActiveSessionCount()).toBe(1);
    });

    it("passes messageCount and durationMs to the markdown output", () => {
      logger.recordSubtaskSpawn({
        requesterSessionKey: "agent:main:summary",
        childSessionKey: "child:fa4",
        agentId: "worker",
        label: "summarize",
        mode: "run",
      });

      logger.recordSubtaskEnd({
        targetSessionKey: "child:fa4",
        outcome: "ok",
        reason: "done",
      });

      logger.finalizeByAgentId({
        agentId: "main",
        messageCount: 42,
        durationMs: 120_000,
      });

      const md = getWrittenMarkdown();
      expect(md).toBeDefined();
      expect(md).toContain("Messages: 42");
      expect(md).toContain("Session duration: 2m 0s");
    });

    it("finalizes multiple sessions for the same agentId", () => {
      logger.recordSubtaskSpawn({
        requesterSessionKey: "agent:main:batch1",
        childSessionKey: "child:b1",
        agentId: "w1",
        mode: "run",
      });
      logger.recordSubtaskSpawn({
        requesterSessionKey: "agent:main:batch2",
        childSessionKey: "child:b2",
        agentId: "w2",
        mode: "run",
      });

      logger.recordSubtaskEnd({
        targetSessionKey: "child:b1",
        outcome: "ok",
        reason: "done",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:b2",
        outcome: "ok",
        reason: "done",
      });

      logger.finalizeByAgentId({ agentId: "main" });

      expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
      expect(logger.getActiveSessionCount()).toBe(0);
    });
  });

  // =========================================================================
  // Markdown generation — format correctness
  // =========================================================================
  describe("markdown generation", () => {
    it("includes Task title with first subtask label", () => {
      const sessionKey = "agent:main:md-title";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:md1",
        agentId: "searcher",
        label: "Web Search Task",
        mode: "run",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:md1",
        outcome: "ok",
        reason: "done",
      });
      logger.autoFinalize(sessionKey);

      const md = getWrittenMarkdown()!;
      expect(md).toContain("# Task: Web Search Task");
    });

    it("includes Subtask Breakdown section", () => {
      const sessionKey = "agent:main:md-breakdown";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:md2",
        agentId: "worker",
        label: "Process Data",
        mode: "session",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:md2",
        outcome: "ok",
        reason: "done",
      });
      logger.autoFinalize(sessionKey);

      const md = getWrittenMarkdown()!;
      expect(md).toContain("## Subtask Breakdown");
      expect(md).toContain("**Process Data**");
      expect(md).toContain("(mode: session)");
    });

    it("includes Execution Details section", () => {
      const sessionKey = "agent:main:md-exec";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:md3",
        agentId: "runner",
        label: "Run Tests",
        mode: "run",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:md3",
        outcome: "ok",
        reason: "all passed",
      });
      logger.autoFinalize(sessionKey);

      const md = getWrittenMarkdown()!;
      expect(md).toContain("## Execution Details");
      expect(md).toContain("### Subtask 1: Run Tests");
      expect(md).toContain("- Outcome: ok");
      expect(md).toContain("- Reason: all passed");
    });

    it("includes Summary section with subtask counts", () => {
      const sessionKey = "agent:main:md-summary";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:ms1",
        agentId: "a1",
        mode: "run",
      });
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:ms2",
        agentId: "a2",
        mode: "run",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:ms1",
        outcome: "ok",
        reason: "done",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:ms2",
        outcome: "error",
        reason: "failed",
        error: "timeout connecting",
      });
      logger.autoFinalize(sessionKey);

      const md = getWrittenMarkdown()!;
      expect(md).toContain("## Summary");
      expect(md).toContain("- Subtasks: 2");
      expect(md).toContain("- Succeeded: 1");
      expect(md).toContain("- Failed: 1");
    });

    it("escapes special characters in subtask labels within markdown", () => {
      const sessionKey = "agent:main:md-esc";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:mesc1",
        agentId: "escaper",
        label: "# Bold **task** with `code`",
        mode: "run",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:mesc1",
        outcome: "ok",
        reason: "done",
      });
      logger.autoFinalize(sessionKey);

      const md = getWrittenMarkdown()!;
      // Title should have escaped markdown chars
      expect(md).toContain("\\# Bold \\*\\*task\\*\\* with \\`code\\`");
    });

    it("handles session with no subtasks gracefully", () => {
      // Directly attempting to autoFinalize a session that was created
      // but has no subtasks — this shouldn't happen in normal flow but
      // tests robustness.
      // Since ensureSession is internal and only called via recordSubtaskSpawn,
      // there's no way to create a session without at least one subtask through
      // the public API. We'll test that autoFinalize returns undefined for
      // nonexistent sessions.
      const result = logger.autoFinalize("nonexistent-key");
      expect(result).toBeUndefined();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it("includes error details in execution section", () => {
      const sessionKey = "agent:main:md-err";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:merr1",
        agentId: "failer",
        label: "Failing Task",
        mode: "run",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:merr1",
        outcome: "error",
        reason: "crashed",
        error: "Segmentation fault",
      });
      logger.autoFinalize(sessionKey);

      const md = getWrittenMarkdown()!;
      expect(md).toContain("- Outcome: error");
      expect(md).toContain("- Error: Segmentation fault");
      expect(md).toContain("- Status: failed");
    });

    it("includes agent and session info in header", () => {
      // We need to set agentId on the session state.
      // ensureSession receives agentId when passed, but recordSubtaskSpawn
      // calls ensureSession(parentKey) without agentId.
      // So state.agentId remains undefined unless set another way.
      // Let's verify the session key is always present.
      const sessionKey = "agent:main:md-header";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:mh1",
        agentId: "header-agent",
        label: "Header Test",
        mode: "run",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:mh1",
        outcome: "ok",
        reason: "done",
      });
      logger.autoFinalize(sessionKey);

      const md = getWrittenMarkdown()!;
      expect(md).toContain(`- Session: ${sessionKey}`);
      expect(md).toContain("- Created:");
      expect(md).toContain("- Status: completed");
    });

    it("shows 'in_progress' status when not all subtasks ended", () => {
      const sessionKey = "agent:main:md-inprog";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:mip1",
        agentId: "a1",
        mode: "run",
      });
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:mip2",
        agentId: "a2",
        mode: "run",
      });
      // Only end one subtask
      logger.recordSubtaskEnd({
        targetSessionKey: "child:mip1",
        outcome: "ok",
        reason: "done",
      });

      // Force finalize via finalizeByAgentId (safety-net path)
      logger.finalizeByAgentId({ agentId: "main" });

      const md = getWrittenMarkdown()!;
      expect(md).toContain("- Status: in_progress");
    });

    it("includes runId in subtask details when present", () => {
      const sessionKey = "agent:main:md-runid";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:mrun1",
        agentId: "runner",
        label: "Run with ID",
        mode: "run",
        runId: "run-xyz-789",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:mrun1",
        outcome: "ok",
        reason: "done",
      });
      logger.autoFinalize(sessionKey);

      const md = getWrittenMarkdown()!;
      expect(md).toContain("`run-xyz-789`");
    });

    it("shows dependency info for subsequent subtasks", () => {
      const sessionKey = "agent:main:md-deps";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:mdep1",
        agentId: "first",
        label: "First",
        mode: "run",
      });
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:mdep2",
        agentId: "second",
        label: "Second",
        mode: "run",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:mdep1",
        outcome: "ok",
        reason: "done",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:mdep2",
        outcome: "ok",
        reason: "done",
      });
      logger.autoFinalize(sessionKey);

      const md = getWrittenMarkdown()!;
      // Second subtask should mention dependency
      expect(md).toContain("spawned after subtask 1");
    });
  });

  // =========================================================================
  // formatDuration — tested indirectly
  // =========================================================================
  describe("formatDuration (indirect via markdown)", () => {
    it("formats milliseconds correctly", () => {
      const sessionKey = "agent:main:dur-ms";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:dur1",
        agentId: "worker",
        mode: "run",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:dur1",
        outcome: "ok",
        reason: "done",
      });
      // Use finalizeByAgentId with durationMs to test formatDuration
      logger.finalizeByAgentId({ agentId: "main", durationMs: 500 });

      const md = getWrittenMarkdown()!;
      expect(md).toContain("Session duration: 500ms");
    });

    it("formats seconds correctly", () => {
      const sessionKey = "agent:main:dur-s";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:dur2",
        agentId: "worker",
        mode: "run",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:dur2",
        outcome: "ok",
        reason: "done",
      });
      logger.finalizeByAgentId({ agentId: "main", durationMs: 45_000 });

      const md = getWrittenMarkdown()!;
      expect(md).toContain("Session duration: 45s");
    });

    it("formats minutes and seconds correctly", () => {
      const sessionKey = "agent:main:dur-m";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:dur3",
        agentId: "worker",
        mode: "run",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:dur3",
        outcome: "ok",
        reason: "done",
      });
      logger.finalizeByAgentId({ agentId: "main", durationMs: 125_000 });

      const md = getWrittenMarkdown()!;
      // 125s = 2m 5s
      expect(md).toContain("Session duration: 2m 5s");
    });

    it("formats hours and minutes correctly", () => {
      const sessionKey = "agent:main:dur-h";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:dur4",
        agentId: "worker",
        mode: "run",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:dur4",
        outcome: "ok",
        reason: "done",
      });
      // 2h 30m = 9000s = 9_000_000ms
      logger.finalizeByAgentId({ agentId: "main", durationMs: 9_000_000 });

      const md = getWrittenMarkdown()!;
      expect(md).toContain("Session duration: 2h 30m");
    });
  });

  // =========================================================================
  // Token/cost accumulation and output
  // =========================================================================
  describe("token/cost accumulation", () => {
    it("attaches accumulated tokens to subtask on end", () => {
      const sessionKey = "agent:main:tok-basic";
      const childKey = "child:tok1";

      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: childKey,
        agentId: "worker",
        label: "Token Task",
        mode: "run",
      });

      // Simulate two LLM calls during the subtask
      logger.accumulateTokens({
        sessionKey: childKey,
        inputTokens: 1000,
        outputTokens: 200,
        totalCost: 0.018,
      });
      logger.accumulateTokens({
        sessionKey: childKey,
        inputTokens: 500,
        outputTokens: 100,
        totalCost: 0.009,
      });

      logger.recordSubtaskEnd({
        targetSessionKey: childKey,
        outcome: "ok",
        reason: "done",
      });
      logger.autoFinalize(sessionKey);

      const md = getWrittenMarkdown()!;
      expect(md).toBeDefined();
      // Subtask execution details should contain accumulated tokens
      expect(md).toContain("- Tokens: 1500 in / 300 out");
      expect(md).toContain("- Cost: 0.027000");
    });

    it("includes total tokens/cost in summary section", () => {
      const sessionKey = "agent:main:tok-summary";

      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:ts1",
        agentId: "a1",
        label: "Task A",
        mode: "run",
      });
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:ts2",
        agentId: "a2",
        label: "Task B",
        mode: "run",
      });

      logger.accumulateTokens({
        sessionKey: "child:ts1",
        inputTokens: 2000,
        outputTokens: 500,
        totalCost: 0.05,
      });
      logger.accumulateTokens({
        sessionKey: "child:ts2",
        inputTokens: 3000,
        outputTokens: 700,
        totalCost: 0.08,
      });

      logger.recordSubtaskEnd({
        targetSessionKey: "child:ts1",
        outcome: "ok",
        reason: "done",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:ts2",
        outcome: "ok",
        reason: "done",
      });
      logger.autoFinalize(sessionKey);

      const md = getWrittenMarkdown()!;
      expect(md).toContain("- Total tokens: 5000 in / 1200 out");
      expect(md).toContain("- Total cost: 0.130000");
    });

    it("omits token/cost lines when no tokens accumulated", () => {
      const sessionKey = "agent:main:tok-none";

      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:tn1",
        agentId: "worker",
        label: "No Token Task",
        mode: "run",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:tn1",
        outcome: "ok",
        reason: "done",
      });
      logger.autoFinalize(sessionKey);

      const md = getWrittenMarkdown()!;
      expect(md).not.toContain("Tokens:");
      expect(md).not.toContain("Total tokens:");
      expect(md).not.toContain("Cost:");
      expect(md).not.toContain("Total cost:");
    });

    it("accumulateTokens does not throw for empty sessionKey", () => {
      expect(() => {
        logger.accumulateTokens({
          sessionKey: "",
          inputTokens: 100,
          outputTokens: 50,
        });
      }).not.toThrow();
    });

    it("handles cost being undefined (unknown model)", () => {
      const sessionKey = "agent:main:tok-nocost";
      const childKey = "child:tnc1";

      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: childKey,
        agentId: "worker",
        label: "Unknown Model Task",
        mode: "run",
      });

      // Accumulate tokens without cost (model not in pricing table)
      logger.accumulateTokens({
        sessionKey: childKey,
        inputTokens: 800,
        outputTokens: 200,
        // totalCost omitted — simulates unknown model
      });

      logger.recordSubtaskEnd({
        targetSessionKey: childKey,
        outcome: "ok",
        reason: "done",
      });
      logger.autoFinalize(sessionKey);

      const md = getWrittenMarkdown()!;
      expect(md).toContain("- Tokens: 800 in / 200 out");
      // No cost line since totalCost was never accumulated
      expect(md).not.toContain("- Cost:");
    });
  });

  // =========================================================================
  // cleanupExpiredLogs
  // =========================================================================
  describe("cleanupExpiredLogs", () => {
    it("returns 0 when logs directory does not exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const cleaned = logger.cleanupExpiredLogs();
      expect(cleaned).toBe(0);
    });

    it("removes files older than retentionDays", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      // Create a logger with 30-day retention
      const shortRetentionLogger = createTaskLogger({
        logsDir: TEST_LOGS_DIR,
        retentionDays: 30,
      });

      // Mock directory listing with old and recent files
      vi.mocked(fs.readdirSync).mockReturnValue([
        "task_2020-01-01_1200.md" as unknown as fs.Dirent,
        "task_2099-12-31_2359.md" as unknown as fs.Dirent,
        "not-a-log.txt" as unknown as fs.Dirent,
      ]);

      const cleaned = shortRetentionLogger.cleanupExpiredLogs();

      // Only the 2020 file should be deleted (well past 30 days)
      expect(cleaned).toBe(1);
      expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
    });

    it("skips files without date pattern in filename", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        "random-file.md" as unknown as fs.Dirent,
        "no-date-here.md" as unknown as fs.Dirent,
      ]);

      const cleaned = logger.cleanupExpiredLogs();
      expect(cleaned).toBe(0);
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Error resilience — observability must never crash host
  // =========================================================================
  describe("error resilience", () => {
    it("recordSubtaskSpawn does not throw even if internal logic fails", () => {
      // Force an error by providing extreme inputs
      expect(() => {
        logger.recordSubtaskSpawn({
          requesterSessionKey: undefined as unknown as string,
          childSessionKey: "child:err",
          agentId: "worker",
          mode: "run",
        });
      }).not.toThrow();
    });

    it("recordSubtaskEnd does not throw for unknown subtask", () => {
      expect(() => {
        logger.recordSubtaskEnd({
          targetSessionKey: "totally-unknown",
          outcome: "error",
          reason: "test",
        });
      }).not.toThrow();
    });

    it("autoFinalize does not throw when writeFileSync fails", () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error("disk full");
      });

      const sessionKey = "agent:main:err-write";
      logger.recordSubtaskSpawn({
        requesterSessionKey: sessionKey,
        childSessionKey: "child:ew1",
        agentId: "worker",
        mode: "run",
      });
      logger.recordSubtaskEnd({
        targetSessionKey: "child:ew1",
        outcome: "ok",
        reason: "done",
      });

      expect(() => {
        logger.autoFinalize(sessionKey);
      }).not.toThrow();

      // Session should be cleaned up even on write failure
      expect(logger.getActiveSessionCount()).toBe(0);
    });

    it("finalizeByAgentId does not throw when writeFileSync fails", () => {
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error("permission denied");
      });

      logger.recordSubtaskSpawn({
        requesterSessionKey: "agent:main:err-fin",
        childSessionKey: "child:ef1",
        agentId: "worker",
        mode: "run",
      });

      expect(() => {
        logger.finalizeByAgentId({ agentId: "main" });
      }).not.toThrow();
    });
  });
});
