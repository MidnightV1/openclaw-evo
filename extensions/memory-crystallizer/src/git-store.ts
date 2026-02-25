/**
 * Git-versioned storage for crystallized memories.
 *
 * Each crystallization creates a commit in a local git repo,
 * enabling users to track cognitive growth via `git log`.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function ensureGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const gitDir = path.join(dir, ".git");
  if (fs.existsSync(gitDir)) {
    return;
  }
  try {
    execSync("git init", { cwd: dir, stdio: "ignore" });
    // Configure for automated commits
    execSync('git config user.name "OpenClaw Crystallizer"', { cwd: dir, stdio: "ignore" });
    execSync('git config user.email "crystallizer@openclaw.local"', { cwd: dir, stdio: "ignore" });
  } catch {
    // Git not available — fall back to plain file storage
  }
}

export function commitFile(params: {
  repoDir: string;
  filePath: string;
  commitMessage: string;
}): boolean {
  const { repoDir, filePath, commitMessage } = params;
  const relativePath = path.relative(repoDir, filePath);
  try {
    execSync(`git add "${relativePath}"`, { cwd: repoDir, stdio: "ignore" });
    execSync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, {
      cwd: repoDir,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false; // Git not available or nothing to commit
  }
}

