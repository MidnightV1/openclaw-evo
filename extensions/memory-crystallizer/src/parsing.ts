/**
 * Pure functions for signal extraction, XML parsing, and path resolution.
 * Extracted from worker.ts for testability — no side effects, no I/O.
 */

import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileOutput = { path: string; content: string };

export type FileRoute = {
  path: string;
  purpose: string;
};

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

/** Strip leading `/` from Windows file:// URL-derived paths (e.g. `/D:/path` → `D:/path`) */
export function normalizeWinPath(p: string, platform = process.platform): string {
  if (platform === "win32" && /^\/[A-Za-z]:/.test(p)) {
    return p.slice(1);
  }
  return p;
}

/**
 * Match an LLM-output file path to the closest configured route.
 * Returns the config route's authoritative path, or undefined if no match.
 *
 * Matching strategy: exact match first, then basename fallback.
 */
export function resolveRoutePath(llmPath: string, routes: FileRoute[]): string | undefined {
  const normalized = llmPath.replace(/^\/+/, "").replace(/\\/g, "/");
  // Exact match against config routes
  for (const route of routes) {
    if (route.path === normalized || route.path === llmPath) return route.path;
  }
  // Basename fallback
  const llmBase = path.basename(normalized).toLowerCase();
  for (const route of routes) {
    if (path.basename(route.path).toLowerCase() === llmBase) return route.path;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Signal extraction
// ---------------------------------------------------------------------------

/** Extract plain text from message content (string or content-block array). */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: string; text: string } =>
          b && typeof b === "object" && b.type === "text" && typeof b.text === "string",
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/**
 * Build signal pairs from a conversation message array.
 * Each pair: user message + preceding assistant context (truncated).
 * Only user messages count as signals.
 */
export function buildSignalPairs(messages: unknown[]): { pairs: string; userCount: number } {
  const parts: string[] = [];
  let prevAssistant = "";
  let userCount = 0;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as { role?: string; content?: unknown };

    if (m.role === "assistant") {
      prevAssistant = extractText(m.content).slice(0, 600);
    } else if (m.role === "user") {
      const text = extractText(m.content);
      if (!text || text.trim().length === 0) continue;
      userCount++;
      if (prevAssistant) {
        parts.push(`[Context]: ${prevAssistant}\n[User]: ${text}`);
      } else {
        parts.push(`[User]: ${text}`);
      }
      prevAssistant = "";
    }
  }
  return { pairs: parts.join("\n\n---\n\n"), userCount };
}

// ---------------------------------------------------------------------------
// XML parsing
// ---------------------------------------------------------------------------

/** Parse Stage 1 XML output: `<portrait action="unchanged|updated">...</portrait>` */
export function parseStage1Result(raw: string): { action: "unchanged" | "updated"; content?: string } {
  // Check for unchanged
  if (raw.includes('action="unchanged"')) {
    return { action: "unchanged" };
  }

  // Extract updated content
  const match = raw.match(/<portrait\s+action="updated">([\s\S]*?)<\/portrait>/);
  if (match) {
    return { action: "updated", content: match[1].trim() };
  }

  // Fallback: if no valid XML, treat entire output as portrait content
  // (model may have skipped XML wrapper)
  const stripped = raw.replace(/<\/?portrait[^>]*>/g, "").trim();
  if (stripped.length > 100) {
    return { action: "updated", content: stripped };
  }

  return { action: "unchanged" };
}

/** Parse Stage 2 XML output: `<files><file path="...">...</file></files>` */
export function parseStage2Result(raw: string): FileOutput[] {
  const results: FileOutput[] = [];
  const pattern = /<file\s+path="([^"]+)">([\s\S]*?)<\/file>/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const content = match[2].trim();
    if (content) {
      results.push({ path: match[1], content });
    }
  }
  return results;
}
