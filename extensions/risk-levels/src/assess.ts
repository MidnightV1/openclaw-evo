/**
 * Risk Assessment Engine
 *
 * Evaluates tool calls against risk level rules (0-5) based on tool name,
 * parameters, and contextual patterns (e.g., destructive bash commands).
 */

export type RiskLevel = 0 | 1 | 2 | 3 | 4 | 5;

export type RiskAssessment = {
  level: RiskLevel;
  reason: string;
  rules: string;
};

// ---------------------------------------------------------------------------
// Rule descriptions per level
// ---------------------------------------------------------------------------

const LEVEL_RULES: Record<RiskLevel, string> = {
  0: "Silent execution. No user interruption.",
  1: "Silent execution + audit log entry.",
  2: "Confirm first N times (default 5). Auto-approve after consecutive approvals of same pattern.",
  3: "Confirm every time. User may select allow-always for this tool+pattern.",
  4: "Confirm every time. allow-always NOT available. Each invocation requires explicit approval.",
  5: "Two-phase confirmation. First prompt describes action; second warns irreversibility.",
};

// ---------------------------------------------------------------------------
// Static tool-level mapping (non-bash tools)
// ---------------------------------------------------------------------------

/** Tools that are purely read-only with zero side effects. */
const LEVEL_0_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "search",
  "list_files",
  "web_search",
  "web_fetch",
  "task",
  "task_output",
]);

/** Tools with low, easily-reversible side effects. */
const LEVEL_1_PATTERNS: Array<{ match: (name: string, params: Record<string, unknown>) => boolean; reason: string }> = [
  {
    match: (name, params) => name === "write" && !params._existingFile,
    reason: "write (new file) — easily reversible",
  },
  {
    match: (name) => name === "mkdir",
    reason: "mkdir — trivially reversible",
  },
];

/** Level 3 — meaningful changes to existing state */
const LEVEL_3_PATTERNS: Array<{ match: (name: string, params: Record<string, unknown>) => boolean; reason: string }> = [
  {
    match: (name) => name === "edit",
    reason: "edit (existing file) — changes working state",
  },
  {
    match: (name, params) => name === "write" && params._existingFile === true,
    reason: "write (overwrite existing) — changes working state",
  },
  {
    match: (name) => name === "notebook_edit",
    reason: "notebook_edit — modifies existing notebook",
  },
];

// ---------------------------------------------------------------------------
// Bash command risk classification
// ---------------------------------------------------------------------------

/** Level 5: catastrophic / irreversible patterns */
const BASH_LEVEL_5_PATTERNS: RegExp[] = [
  /\brm\s+(-\w*r\w*f|-\w*f\w*r)\b/i,          // rm -rf / rm -fr
  /\brm\s+.*(-r\s+-f|-f\s+-r)\b/i,             // rm -r -f / rm -f -r (separated short opts)
  /\brm\s+.*--recursive\b.*--force\b/i,         // rm --recursive --force (any order)
  /\brm\s+.*--force\b.*--recursive\b/i,         // rm --force --recursive (any order)
  /\brm\s+-rf\s+[/~]/i,                          // rm -rf / or rm -rf ~
  /\bgit\s+push\s+.*--force\b/i,                 // git push --force
  /\bgit\s+push\s+-f\b/i,                        // git push -f
  /\bgit\s+reset\s+--hard\b/i,                   // git reset --hard
  /\bgit\s+clean\s+-\w*f/i,                      // git clean -f / -fd / -fx
  /\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX)\b/i,    // SQL DROP
  /\bTRUNCATE\s+TABLE\b/i,                        // SQL TRUNCATE
  /\bDELETE\s+FROM\s+\S+\s*(;|$)/i,              // DELETE FROM table; (no WHERE)
  /\bformat\s+[a-zA-Z]:/i,                        // format C:
  /\bmkfs\b/i,                                     // mkfs
  /\bfdisk\b/i,                                    // fdisk
  /\bdd\s+if=/i,                                   // dd
  /\b>\s*\/dev\/sd[a-z]/i,                         // write directly to block device
  /\bchmod\s+-R\s+777\s+\//i,                     // chmod -R 777 /
];

/** Level 4: destructive but scoped patterns */
const BASH_LEVEL_4_PATTERNS: RegExp[] = [
  /\brm\s+/i,                                     // rm (any form not caught by L5)
  /\bgit\s+push\b/i,                              // git push (non-force)
  /\bgit\s+branch\s+-[dD]\b/i,                    // git branch -d/-D
  /\bkill\b/i,                                     // kill
  /\bpkill\b/i,                                    // pkill
  /\bkillall\b/i,                                  // killall
  /\bshutdown\b/i,                                 // shutdown
  /\breboot\b/i,                                   // reboot
  /\bsystemctl\s+(stop|restart|disable)\b/i,      // systemctl stop/restart/disable
  /\bdocker\s+(rm|rmi|stop|kill)\b/i,             // docker destructive
  /\bnpm\s+unpublish\b/i,                          // npm unpublish
  /\bcurl\s+.*\|\s*(bash|sh)\b/i,                 // curl | bash (pipe to shell)
  /\bwget\s+.*\|\s*(bash|sh)\b/i,                 // wget | bash
];

/** Level 3: state-changing (non-destructive) */
const BASH_LEVEL_3_PATTERNS: RegExp[] = [
  /\bgit\s+commit\b/i,
  /\bgit\s+add\b/i,
  /\bgit\s+checkout\b/i,
  /\bgit\s+merge\b/i,
  /\bgit\s+rebase\b/i,
  /\bgit\s+stash\b/i,
  /\bgit\s+cherry-pick\b/i,
  /\bgit\s+tag\b/i,
  /^\s*mv\s+/i,                                  // mv — moves/renames files
  /\bsed\s+.*-i\b/i,                             // sed -i — in-place file edit
  /\bxargs\s+/i,                                  // xargs — can amplify any command
];

/** Level 2: common non-destructive commands */
const BASH_LEVEL_2_SAFE_PREFIXES: RegExp[] = [
  /^\s*(ls|dir|pwd|echo|cat|head|tail|wc|sort|uniq|diff|find|which|where|type|file)\b/i,
  /^\s*(npm\s+(install|i|ci|run|test|start|build|list|ls|outdated|audit))\b/i,
  /^\s*(npx|pnpm\s+(install|i|add|run|test|build|list|ls))\b/i,
  /^\s*(yarn\s+(install|add|run|test|build|list))\b/i,
  /^\s*(pip\s+(install|list|show|freeze|check))\b/i,
  /^\s*(pip3\s+(install|list|show|freeze|check))\b/i,
  /^\s*(python|python3|node|deno|bun|ruby|go|cargo|rustc|gcc|g\+\+|make|cmake)\b/i,
  /^\s*(docker\s+(ps|images|logs|inspect|stats|info|version))\b/i,
  /^\s*(docker\s+compose\s+(up|build|logs|ps))\b/i,
  /^\s*(cargo\s+(build|test|check|clippy|fmt|run|doc))\b/i,
  /^\s*(go\s+(build|test|vet|fmt|run|mod))\b/i,
  /^\s*(git\s+(status|log|diff|show|branch|remote|fetch|pull|blame|reflog))\b/i,
  /^\s*(curl|wget|ssh|scp|rsync)\b/i,
  /^\s*(cd|mkdir|touch|cp|ln)\b/i,
  /^\s*(grep|rg|ag|awk|sed|tr|cut|paste|tee)\b/i,
  /^\s*(env|printenv|set|export)\b/i,
  /^\s*(date|cal|uptime|df|du|free|top|htop|ps|lsof|netstat|ss)\b/i,
  /^\s*(tsc|eslint|prettier|vitest|jest|mocha|pytest)\b/i,
];

// ---------------------------------------------------------------------------
// Core assessment logic
// ---------------------------------------------------------------------------

function normalizeTool(name: string): string {
  return name.replace(/[^a-zA-Z0-9_*]/g, "_").toLowerCase();
}

function matchesLevel0(toolName: string): boolean {
  for (const pattern of LEVEL_0_TOOLS) {
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (toolName.startsWith(prefix)) return true;
    } else if (toolName === pattern) {
      return true;
    }
  }
  return false;
}

function assessBashCommand(command: string): RiskAssessment {
  const trimmed = command.trim();
  if (!trimmed) {
    return { level: 0, reason: "empty bash command", rules: LEVEL_RULES[0] };
  }

  // Split compound commands (&&, ||, ;) and assess each part separately.
  // Also split pipes (|) — e.g., `cat file | xargs rm` has independent risk.
  // Use negative lookahead to avoid splitting on || when looking for |.
  const subcommands = trimmed.split(/\s*(?:&&|\|\||;|\|(?!\|))\s*/);
  if (subcommands.length > 1) {
    let maxAssessment: RiskAssessment = { level: 0, reason: "", rules: "" };
    for (const sub of subcommands) {
      const part = sub.trim();
      if (!part) continue;
      const assessment = assessSingleBashCommand(part);
      if (assessment.level > maxAssessment.level) {
        maxAssessment = assessment;
      }
    }
    maxAssessment.reason = `Compound command, highest risk from: ${maxAssessment.reason}`;
    return maxAssessment;
  }

  return assessSingleBashCommand(trimmed);
}

function assessSingleBashCommand(command: string): RiskAssessment {
  const trimmed = command.trim();
  if (!trimmed) {
    return { level: 0, reason: "empty bash command", rules: LEVEL_RULES[0] };
  }

  // Check Level 5 first (most dangerous)
  for (const pattern of BASH_LEVEL_5_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        level: 5,
        reason: `catastrophic command pattern: ${pattern.source}`,
        rules: LEVEL_RULES[5],
      };
    }
  }

  // Level 4
  for (const pattern of BASH_LEVEL_4_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        level: 4,
        reason: `destructive command pattern: ${pattern.source}`,
        rules: LEVEL_RULES[4],
      };
    }
  }

  // Level 3 (state-changing, non-destructive)
  for (const pattern of BASH_LEVEL_3_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        level: 3,
        reason: `state-changing command: ${pattern.source}`,
        rules: LEVEL_RULES[3],
      };
    }
  }

  // Level 2 (safe patterns)
  for (const pattern of BASH_LEVEL_2_SAFE_PREFIXES) {
    if (pattern.test(trimmed)) {
      return {
        level: 2,
        reason: "non-destructive bash command",
        rules: LEVEL_RULES[2],
      };
    }
  }

  // Default for unrecognized bash commands: Level 2 (cautious but not blocking)
  return {
    level: 2,
    reason: "unrecognized bash command — defaulting to medium-low risk",
    rules: LEVEL_RULES[2],
  };
}

/**
 * Assess the risk level of a tool call.
 *
 * @param toolName - Normalized tool name (e.g., "bash", "edit", "read")
 * @param params - Tool call parameters
 * @param context - Optional context with file path or command details
 */
export function assessRisk(
  toolName: string,
  params: Record<string, unknown>,
  context?: { filePath?: string; command?: string },
): RiskAssessment {
  const normalized = normalizeTool(toolName);

  // --- Level 0: read-only tools ---
  if (matchesLevel0(normalized)) {
    return { level: 0, reason: `${normalized} is read-only`, rules: LEVEL_RULES[0] };
  }

  // --- MCP tools: default to Level 1 (log but don't block) ---
  // Known safe MCP tools can be explicitly added to LEVEL_0_TOOLS above.
  if (normalized.startsWith("mcp__")) {
    return { level: 1, reason: `MCP tool (${toolName})`, rules: LEVEL_RULES[1] };
  }

  // --- Bash: content-aware analysis ---
  if (normalized === "bash") {
    const command = (params.command as string) ?? context?.command ?? "";
    return assessBashCommand(command);
  }

  // --- Level 1 patterns ---
  for (const pattern of LEVEL_1_PATTERNS) {
    if (pattern.match(normalized, params)) {
      return { level: 1, reason: pattern.reason, rules: LEVEL_RULES[1] };
    }
  }

  // --- Level 3 patterns ---
  for (const pattern of LEVEL_3_PATTERNS) {
    if (pattern.match(normalized, params)) {
      return { level: 3, reason: pattern.reason, rules: LEVEL_RULES[3] };
    }
  }

  // --- Default: unrecognized tool → Level 2 ---
  return {
    level: 2,
    reason: `unrecognized tool "${normalized}" — defaulting to medium-low risk`,
    rules: LEVEL_RULES[2],
  };
}

export { LEVEL_RULES };
