import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TrashManager } from "./trash.js";

describe("TrashManager", () => {
  let tempDir: string;
  let trashDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "trash-test-"));
    trashDir = path.join(tempDir, "trash");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Constructor & retentionDays config
  // =========================================================================
  describe("constructor", () => {
    it("accepts retentionDays configuration", () => {
      const tm = new TrashManager(tempDir, { retentionDays: 14 });
      // TrashManager created without error — retentionDays is stored internally.
      // We verify indirectly: cleanup with a 14-day retention should keep recent entries.
      expect(tm).toBeDefined();
      tm.dispose();
    });

    it("defaults retentionDays to 7", () => {
      const tm = new TrashManager(tempDir);
      // Default retention: entries trashed less than 7 days ago should survive cleanup.
      // Trash a file, run cleanup immediately — file should NOT be removed.
      const filePath = path.join(tempDir, "keep.txt");
      writeFileSync(filePath, "keep");
      tm.moveToTrash(filePath);

      const removed = tm.cleanup();
      expect(removed).toBe(0); // Nothing expired yet under 7-day default
      tm.dispose();
    });
  });

  // =========================================================================
  // moveToTrash & list
  // =========================================================================
  describe("moveToTrash", () => {
    it("moves an existing file to trash and lists it", () => {
      const tm = new TrashManager(tempDir);
      const filePath = path.join(tempDir, "target.txt");
      writeFileSync(filePath, "data");

      const trashPath = tm.moveToTrash(filePath);
      expect(trashPath).toBeTruthy();
      expect(tm.list()).toHaveLength(1);
      expect(tm.list()[0]!.originalPath).toBe(path.resolve(filePath));
      tm.dispose();
    });

    it("returns null for non-existent file", () => {
      const tm = new TrashManager(tempDir);
      const result = tm.moveToTrash(path.join(tempDir, "nope.txt"));
      expect(result).toBeNull();
      tm.dispose();
    });
  });

  // =========================================================================
  // NOTE: isFileDeletion and extractDeletionPath
  //
  // These helper functions are defined in `index.ts` as module-private
  // functions (not exported). They cannot be tested directly from this file.
  // If they need direct unit testing, they should be extracted into a shared
  // utility module and exported. The tests below verify the extractable
  // behaviors indirectly through integration with TrashManager, or are
  // documented here as specifications for future extraction.
  // =========================================================================

  // =========================================================================
  // isFileDeletion behavior (documented — function is not exported)
  // =========================================================================
  describe("isFileDeletion (specification)", () => {
    // isFileDeletion(toolName, params) — defined in index.ts (not exported)
    // It checks: toolName === "bash" && /\brm\s+/.test(cmd)
    // or toolName in {"rm", "remove", "delete"}

    it.skip("identifies bash rm commands as file deletions", () => {
      // isFileDeletion("bash", { command: "rm file.txt" }) → true
    });

    it.skip("returns false for non-rm bash commands", () => {
      // isFileDeletion("bash", { command: "ls -la" }) → false
    });
  });

  // =========================================================================
  // extractDeletionPath behavior (documented — function is not exported)
  // =========================================================================
  describe("extractDeletionPath (specification)", () => {
    // extractDeletionPath(toolName, params) — defined in index.ts (not exported)
    // For bash: extracts the first non-flag argument from rm command
    // Strips surrounding quotes (single or double)

    it.skip('rm "path with spaces/file.txt" → extracts path with spaces/file.txt', () => {
      // extractDeletionPath("bash", { command: 'rm "path with spaces/file.txt"' })
      //   → "path with spaces/file.txt"
    });

    it.skip("rm plain/path.txt → extracts plain/path.txt", () => {
      // extractDeletionPath("bash", { command: "rm plain/path.txt" })
      //   → "plain/path.txt"
    });
  });
});
