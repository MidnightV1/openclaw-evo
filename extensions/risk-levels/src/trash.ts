/**
 * Trash / Recycle Bin
 *
 * Intercepts file deletions at Level 4+ and moves files to a dated
 * trash directory instead of permanently deleting them.
 *
 * Storage: `.openclaw/trash/{YYYY-MM-DD}/{original-basename}`
 * Manifest: `.openclaw/trash/manifest.json`
 * Auto-cleanup: configurable retention (default 7 days, via unref'd setInterval)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TrashEntry = {
  originalPath: string;
  trashPath: string;
  trashedAt: number;
  /** ISO date string for easy grouping */
  date: string;
};

type TrashManifest = {
  version: 1;
  entries: TrashEntry[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_RETENTION_DAYS = 7;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ---------------------------------------------------------------------------
// Trash Manager
// ---------------------------------------------------------------------------

export type TrashManagerOptions = {
  trashDir?: string;
  retentionDays?: number;
};

export class TrashManager {
  private trashDir: string;
  private manifestPath: string;
  private manifest: TrashManifest;
  private retentionDays: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(stateDir: string, options?: TrashManagerOptions) {
    this.trashDir = options?.trashDir ?? path.join(stateDir, "trash");
    this.retentionDays = options?.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.manifestPath = path.join(this.trashDir, "manifest.json");

    if (!existsSync(this.trashDir)) {
      mkdirSync(this.trashDir, { recursive: true });
    }

    this.manifest = this.loadManifest();
    this.startCleanupTimer();
  }

  private loadManifest(): TrashManifest {
    try {
      if (existsSync(this.manifestPath)) {
        const raw = readFileSync(this.manifestPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed?.version === 1) {
          return parsed as TrashManifest;
        }
      }
    } catch {
      // Corrupted — start fresh
    }
    return { version: 1, entries: [] };
  }

  private saveManifest(): void {
    try {
      writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2), "utf-8");
    } catch {
      // Silently ignore
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Move a file to trash instead of deleting it.
   * Returns the trash path on success, null on failure.
   */
  moveToTrash(originalPath: string): string | null {
    if (!existsSync(originalPath)) {
      return null;
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const dateDir = path.join(this.trashDir, dateStr);

    if (!existsSync(dateDir)) {
      mkdirSync(dateDir, { recursive: true });
    }

    // Ensure unique name within date dir
    const basename = path.basename(originalPath);
    let trashPath = path.join(dateDir, basename);
    let counter = 0;
    while (existsSync(trashPath)) {
      counter++;
      const ext = path.extname(basename);
      const name = path.basename(basename, ext);
      trashPath = path.join(dateDir, `${name}.${counter}${ext}`);
    }

    try {
      renameSync(originalPath, trashPath);
    } catch {
      // Cross-device move or permission error — fall back to copy+delete
      // In a real implementation we'd use fs.copyFileSync + fs.unlinkSync
      // For now, return null to let the original delete proceed
      return null;
    }

    const entry: TrashEntry = {
      originalPath: path.resolve(originalPath),
      trashPath,
      trashedAt: now.getTime(),
      date: dateStr,
    };
    this.manifest.entries.push(entry);
    this.saveManifest();

    return trashPath;
  }

  /**
   * Restore a file from trash to its original location.
   */
  restore(trashPath: string): boolean {
    const entry = this.manifest.entries.find((e) => e.trashPath === trashPath);
    if (!entry || !existsSync(trashPath)) {
      return false;
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(entry.originalPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    try {
      renameSync(trashPath, entry.originalPath);
    } catch {
      return false;
    }

    this.manifest.entries = this.manifest.entries.filter((e) => e.trashPath !== trashPath);
    this.saveManifest();
    return true;
  }

  /**
   * Clean up trash entries older than the configured retention period.
   */
  cleanup(): number {
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const toRemove = this.manifest.entries.filter((e) => e.trashedAt < cutoff);

    if (toRemove.length === 0) return 0;

    let removed = 0;
    for (const entry of toRemove) {
      try {
        if (existsSync(entry.trashPath)) {
          const stat = statSync(entry.trashPath);
          if (stat.isDirectory()) {
            rmSync(entry.trashPath, { recursive: true, force: true });
          } else {
            rmSync(entry.trashPath, { force: true });
          }
        }
        removed++;
      } catch {
        // Skip files we can't delete
      }
    }

    // Remove expired entries from manifest
    this.manifest.entries = this.manifest.entries.filter((e) => e.trashedAt >= cutoff);

    // Clean up empty date directories
    try {
      const dirs = readdirSync(this.trashDir, { withFileTypes: true });
      for (const dirent of dirs) {
        if (!dirent.isDirectory() || dirent.name === "." || dirent.name === "..") continue;
        const dirPath = path.join(this.trashDir, dirent.name);
        try {
          const contents = readdirSync(dirPath);
          if (contents.length === 0) {
            rmSync(dirPath, { recursive: true });
          }
        } catch {
          // Skip
        }
      }
    } catch {
      // Skip
    }

    this.saveManifest();
    return removed;
  }

  /**
   * List all entries in trash.
   */
  list(): readonly TrashEntry[] {
    return this.manifest.entries;
  }

  /**
   * Stop the cleanup timer (for graceful shutdown).
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
