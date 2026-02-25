import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApprovalStore } from "./approval-store.js";

describe("ApprovalStore", () => {
  let tempDir: string;
  let store: ApprovalStore;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "risk-levels-test-"));
    store = new ApprovalStore(tempDir);
  });

  afterEach(() => {
    store.flush();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("record + consecutiveApprovals", () => {
    it("counts consecutive approvals for same tool+hash", () => {
      const hash = store.computeHash("bash", { command: "npm install" });

      store.record({ toolName: "bash", paramsHash: hash, riskLevel: 2, approved: true, timestamp: 1 });
      store.record({ toolName: "bash", paramsHash: hash, riskLevel: 2, approved: true, timestamp: 2 });
      store.record({ toolName: "bash", paramsHash: hash, riskLevel: 2, approved: true, timestamp: 3 });

      expect(store.consecutiveApprovals("bash", hash)).toBe(3);
    });

    it("breaks chain on denial", () => {
      const hash = store.computeHash("bash", { command: "npm install" });

      store.record({ toolName: "bash", paramsHash: hash, riskLevel: 2, approved: true, timestamp: 1 });
      store.record({ toolName: "bash", paramsHash: hash, riskLevel: 2, approved: true, timestamp: 2 });
      store.record({ toolName: "bash", paramsHash: hash, riskLevel: 2, approved: false, timestamp: 3 });
      store.record({ toolName: "bash", paramsHash: hash, riskLevel: 2, approved: true, timestamp: 4 });

      expect(store.consecutiveApprovals("bash", hash)).toBe(1);
    });

    it("returns 0 for unknown tool", () => {
      expect(store.consecutiveApprovals("unknown", "abc")).toBe(0);
    });
  });

  describe("allow-always", () => {
    it("adds and checks allow-always entries", () => {
      const hash = store.computeHash("edit", { filePath: "config.ts" });

      expect(store.isAllowAlways("edit", hash)).toBe(false);
      store.addAllowAlways("edit", hash);
      expect(store.isAllowAlways("edit", hash)).toBe(true);
    });

    it("removes allow-always entries", () => {
      const hash = store.computeHash("edit", { filePath: "config.ts" });

      store.addAllowAlways("edit", hash);
      expect(store.isAllowAlways("edit", hash)).toBe(true);

      const removed = store.removeAllowAlways("edit", hash);
      expect(removed).toBe(true);
      expect(store.isAllowAlways("edit", hash)).toBe(false);
    });

    it("is idempotent", () => {
      const hash = "test-hash";
      store.addAllowAlways("edit", hash);
      store.addAllowAlways("edit", hash);

      expect(store.getAllowAlwaysList()).toHaveLength(1);
    });
  });

  describe("persistence", () => {
    it("survives reload", () => {
      const hash = store.computeHash("bash", { command: "npm install" });
      store.record({ toolName: "bash", paramsHash: hash, riskLevel: 2, approved: true, timestamp: 1 });
      store.addAllowAlways("edit", "test-hash");
      store.flush();

      // Create new store from same dir
      const store2 = new ApprovalStore(tempDir);
      expect(store2.consecutiveApprovals("bash", hash)).toBe(1);
      expect(store2.isAllowAlways("edit", "test-hash")).toBe(true);
    });
  });

  describe("computeHash", () => {
    it("produces consistent hashes for same input", () => {
      const h1 = store.computeHash("bash", { command: "npm install" });
      const h2 = store.computeHash("bash", { command: "npm install" });
      expect(h1).toBe(h2);
    });

    it("bash commands hash by first token", () => {
      const h1 = store.computeHash("bash", { command: "npm install express" });
      const h2 = store.computeHash("bash", { command: "npm install lodash" });
      expect(h1).toBe(h2); // Same first token "npm"
    });

    it("non-bash tools hash by param keys", () => {
      const h1 = store.computeHash("edit", { filePath: "a.ts", content: "x" });
      const h2 = store.computeHash("edit", { filePath: "b.ts", content: "y" });
      expect(h1).toBe(h2); // Same keys: content, filePath
    });
  });

  // =========================================================================
  // Dual token hash (R4 fix)
  // =========================================================================
  describe("dual token hash", () => {
    it("npm install and npm unpublish → different hash", () => {
      const h1 = store.computeHash("bash", { command: "npm install" });
      const h2 = store.computeHash("bash", { command: "npm unpublish" });
      expect(h1).not.toBe(h2);
    });

    it("npm install express and npm install lodash → same hash (same first two tokens)", () => {
      const h1 = store.computeHash("bash", { command: "npm install express" });
      const h2 = store.computeHash("bash", { command: "npm install lodash" });
      expect(h1).toBe(h2);
    });

    it("git commit and git push → different hash", () => {
      const h1 = store.computeHash("bash", { command: "git commit" });
      const h2 = store.computeHash("bash", { command: "git push" });
      expect(h1).not.toBe(h2);
    });

    it("single token command ls → hash based on ls", () => {
      const h1 = store.computeHash("bash", { command: "ls" });
      const h2 = store.computeHash("bash", { command: "ls" });
      expect(h1).toBe(h2);
      // Ensure it differs from another single-token command
      const h3 = store.computeHash("bash", { command: "pwd" });
      expect(h1).not.toBe(h3);
    });
  });

  // =========================================================================
  // Progressive trust (isTrusted / recordApproval / recordDenial)
  // =========================================================================
  describe("progressive trust", () => {
    const THRESHOLD = 5;

    it("isTrusted returns false when under threshold", () => {
      const hash = store.computeHash("bash", { command: "npm install" });

      for (let i = 0; i < THRESHOLD - 1; i++) {
        store.recordApproval("bash", hash, 2);
      }

      expect(store.isTrusted("bash", hash, THRESHOLD)).toBe(false);
    });

    it("isTrusted returns true after exactly N consecutive approvals", () => {
      const hash = store.computeHash("bash", { command: "npm install" });

      for (let i = 0; i < THRESHOLD; i++) {
        store.recordApproval("bash", hash, 2);
      }

      expect(store.isTrusted("bash", hash, THRESHOLD)).toBe(true);
    });

    it("isTrusted returns true when exceeding threshold", () => {
      const hash = store.computeHash("bash", { command: "npm install" });

      for (let i = 0; i < THRESHOLD + 3; i++) {
        store.recordApproval("bash", hash, 2);
      }

      expect(store.isTrusted("bash", hash, THRESHOLD)).toBe(true);
    });

    it("denial breaks trust — isTrusted returns false after denial", () => {
      const hash = store.computeHash("bash", { command: "npm install" });

      // Build trust
      for (let i = 0; i < THRESHOLD; i++) {
        store.recordApproval("bash", hash, 2);
      }
      expect(store.isTrusted("bash", hash, THRESHOLD)).toBe(true);

      // Denial breaks the chain
      store.recordDenial("bash", hash, 2);
      expect(store.isTrusted("bash", hash, THRESHOLD)).toBe(false);
    });

    it("trust can be rebuilt after denial", () => {
      const hash = store.computeHash("bash", { command: "npm install" });

      // Build trust
      for (let i = 0; i < THRESHOLD; i++) {
        store.recordApproval("bash", hash, 2);
      }
      expect(store.isTrusted("bash", hash, THRESHOLD)).toBe(true);

      // Denial breaks trust
      store.recordDenial("bash", hash, 2);
      expect(store.isTrusted("bash", hash, THRESHOLD)).toBe(false);

      // Rebuild trust from scratch
      for (let i = 0; i < THRESHOLD; i++) {
        store.recordApproval("bash", hash, 2);
      }
      expect(store.isTrusted("bash", hash, THRESHOLD)).toBe(true);
    });

    it("recordApproval and recordDenial populate history correctly", () => {
      const hash = store.computeHash("bash", { command: "git status" });

      store.recordApproval("bash", hash, 2, "user-1");
      store.recordApproval("bash", hash, 2, "user-1");
      store.recordDenial("bash", hash, 2, "user-1");

      const history = store.getRecentHistory(10);
      expect(history).toHaveLength(3);
      expect(history[0]!.approved).toBe(true);
      expect(history[1]!.approved).toBe(true);
      expect(history[2]!.approved).toBe(false);
      // All entries should have the userId
      expect(history[0]!.userId).toBe("user-1");
    });

    it("full degradation flow: L2 tool earns trust, loses it, rebuilds", () => {
      const hash = store.computeHash("bash", { command: "npm test" });

      // Phase 1: not yet trusted
      expect(store.isTrusted("bash", hash, THRESHOLD)).toBe(false);
      expect(store.consecutiveApprovals("bash", hash)).toBe(0);

      // Phase 2: accumulate approvals
      for (let i = 1; i <= THRESHOLD; i++) {
        store.recordApproval("bash", hash, 2);
        expect(store.consecutiveApprovals("bash", hash)).toBe(i);
      }
      expect(store.isTrusted("bash", hash, THRESHOLD)).toBe(true);

      // Phase 3: one more approval — still trusted
      store.recordApproval("bash", hash, 2);
      expect(store.isTrusted("bash", hash, THRESHOLD)).toBe(true);

      // Phase 4: denial breaks chain
      store.recordDenial("bash", hash, 2);
      expect(store.consecutiveApprovals("bash", hash)).toBe(0);
      expect(store.isTrusted("bash", hash, THRESHOLD)).toBe(false);

      // Phase 5: partial rebuild — not yet trusted
      for (let i = 0; i < THRESHOLD - 1; i++) {
        store.recordApproval("bash", hash, 2);
      }
      expect(store.isTrusted("bash", hash, THRESHOLD)).toBe(false);

      // Phase 6: one more → trusted again
      store.recordApproval("bash", hash, 2);
      expect(store.isTrusted("bash", hash, THRESHOLD)).toBe(true);
    });

    it("trust is per tool+pattern — different patterns are independent", () => {
      const hashInstall = store.computeHash("bash", { command: "npm install" });
      const hashTest = store.computeHash("bash", { command: "npm test" });

      // Build trust for npm install
      for (let i = 0; i < THRESHOLD; i++) {
        store.recordApproval("bash", hashInstall, 2);
      }

      // npm install is trusted, npm test is not
      expect(store.isTrusted("bash", hashInstall, THRESHOLD)).toBe(true);
      expect(store.isTrusted("bash", hashTest, THRESHOLD)).toBe(false);
    });

    it("L3 tools also build progressive trust", () => {
      const hash = store.computeHash("edit", { filePath: "src/index.ts" });

      for (let i = 0; i < THRESHOLD; i++) {
        store.recordApproval("edit", hash, 3);
      }

      expect(store.isTrusted("edit", hash, THRESHOLD)).toBe(true);
    });
  });
});
