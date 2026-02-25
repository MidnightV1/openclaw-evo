import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  filterToolsByPolicy,
  isToolAllowedByPolicyName,
  resolveSpawnLevelToolPolicy,
  resolveSubagentToolPolicy,
} from "./pi-tools.policy.js";

function createStubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({}) as AgentToolResult<unknown>,
  };
}

describe("pi-tools.policy", () => {
  it("treats * in allow as allow-all", () => {
    const tools = [createStubTool("read"), createStubTool("exec")];
    const filtered = filterToolsByPolicy(tools, { allow: ["*"] });
    expect(filtered.map((tool) => tool.name)).toEqual(["read", "exec"]);
  });

  it("treats * in deny as deny-all", () => {
    const tools = [createStubTool("read"), createStubTool("exec")];
    const filtered = filterToolsByPolicy(tools, { deny: ["*"] });
    expect(filtered).toEqual([]);
  });

  it("supports wildcard allow/deny patterns", () => {
    expect(isToolAllowedByPolicyName("web_fetch", { allow: ["web_*"] })).toBe(true);
    expect(isToolAllowedByPolicyName("web_search", { deny: ["web_*"] })).toBe(false);
  });

  it("keeps apply_patch when exec is allowlisted", () => {
    expect(isToolAllowedByPolicyName("apply_patch", { allow: ["exec"] })).toBe(true);
  });
});

describe("resolveSubagentToolPolicy depth awareness", () => {
  const baseCfg = {
    agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
  } as unknown as OpenClawConfig;

  const deepCfg = {
    agents: { defaults: { subagents: { maxSpawnDepth: 3 } } },
  } as unknown as OpenClawConfig;

  const leafCfg = {
    agents: { defaults: { subagents: { maxSpawnDepth: 1 } } },
  } as unknown as OpenClawConfig;

  it("applies subagent tools.alsoAllow to re-enable default-denied tools", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: { subagents: { tools: { alsoAllow: ["sessions_send"] } } },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(isToolAllowedByPolicyName("sessions_send", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("cron", policy)).toBe(false);
  });

  it("applies subagent tools.allow to re-enable default-denied tools", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: { subagents: { tools: { allow: ["sessions_send"] } } },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(isToolAllowedByPolicyName("sessions_send", policy)).toBe(true);
  });

  it("merges subagent tools.alsoAllow into tools.allow when both are set", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: {
        subagents: { tools: { allow: ["sessions_spawn"], alsoAllow: ["sessions_send"] } },
      },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(policy.allow).toEqual(["sessions_spawn", "sessions_send"]);
  });

  it("keeps configured deny precedence over allow and alsoAllow", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: {
        subagents: {
          tools: {
            allow: ["sessions_send"],
            alsoAllow: ["sessions_send"],
            deny: ["sessions_send"],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(isToolAllowedByPolicyName("sessions_send", policy)).toBe(false);
  });

  it("does not create a restrictive allowlist when only alsoAllow is configured", () => {
    const cfg = {
      agents: { defaults: { subagents: { maxSpawnDepth: 2 } } },
      tools: { subagents: { tools: { alsoAllow: ["sessions_send"] } } },
    } as unknown as OpenClawConfig;
    const policy = resolveSubagentToolPolicy(cfg, 1);
    expect(policy.allow).toBeUndefined();
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(true);
  });

  it("depth-1 orchestrator (maxSpawnDepth=2) allows sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
  });

  it("depth-1 orchestrator (maxSpawnDepth=2) allows subagents", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(true);
  });

  it("depth-1 orchestrator (maxSpawnDepth=2) allows sessions_list", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_list", policy)).toBe(true);
  });

  it("depth-1 orchestrator (maxSpawnDepth=2) allows sessions_history", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_history", policy)).toBe(true);
  });

  it("depth-1 orchestrator still denies gateway, cron, memory", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 1);
    expect(isToolAllowedByPolicyName("gateway", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("cron", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("memory_search", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("memory_get", policy)).toBe(false);
  });

  it("depth-2 leaf denies sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 2);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
  });

  it("depth-2 orchestrator (maxSpawnDepth=3) allows sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(deepCfg, 2);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
  });

  it("depth-3 leaf (maxSpawnDepth=3) denies sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(deepCfg, 3);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
  });

  it("depth-2 leaf allows subagents (for visibility)", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 2);
    expect(isToolAllowedByPolicyName("subagents", policy)).toBe(true);
  });

  it("depth-2 leaf denies sessions_list and sessions_history", () => {
    const policy = resolveSubagentToolPolicy(baseCfg, 2);
    expect(isToolAllowedByPolicyName("sessions_list", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("sessions_history", policy)).toBe(false);
  });

  it("depth-1 leaf (maxSpawnDepth=1) denies sessions_spawn", () => {
    const policy = resolveSubagentToolPolicy(leafCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
  });

  it("depth-1 leaf (maxSpawnDepth=1) denies sessions_list", () => {
    const policy = resolveSubagentToolPolicy(leafCfg, 1);
    expect(isToolAllowedByPolicyName("sessions_list", policy)).toBe(false);
  });

  it("defaults to leaf behavior when no depth is provided", () => {
    const policy = resolveSubagentToolPolicy(baseCfg);
    // Default depth=1, maxSpawnDepth=2 → orchestrator
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(true);
  });

  it("defaults to leaf behavior when depth is undefined and maxSpawnDepth is 1", () => {
    const policy = resolveSubagentToolPolicy(leafCfg);
    // Default depth=1, maxSpawnDepth=1 → leaf
    expect(isToolAllowedByPolicyName("sessions_spawn", policy)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// resolveSpawnLevelToolPolicy — Phase 4 sub-agent communication
// ─────────────────────────────────────────────────────────────

describe("resolveSpawnLevelToolPolicy", () => {
  it("returns undefined when policy is undefined", () => {
    expect(resolveSpawnLevelToolPolicy(undefined)).toBeUndefined();
  });

  it("returns undefined when policy is an empty object", () => {
    expect(resolveSpawnLevelToolPolicy({})).toBeUndefined();
  });

  it("returns undefined when allow is an empty array", () => {
    expect(resolveSpawnLevelToolPolicy({ allow: [] })).toBeUndefined();
  });

  it("returns undefined when deny is an empty array", () => {
    expect(resolveSpawnLevelToolPolicy({ deny: [] })).toBeUndefined();
  });

  it("returns undefined when both allow and deny are empty arrays", () => {
    expect(resolveSpawnLevelToolPolicy({ allow: [], deny: [] })).toBeUndefined();
  });

  it("returns policy with allow when allow has entries", () => {
    const result = resolveSpawnLevelToolPolicy({ allow: ["read", "glob"] });
    expect(result).toEqual({ allow: ["read", "glob"], deny: undefined });
  });

  it("returns policy with deny when deny has entries", () => {
    const result = resolveSpawnLevelToolPolicy({ deny: ["bash"] });
    expect(result).toEqual({ allow: undefined, deny: ["bash"] });
  });

  it("returns policy with both allow and deny when both have entries", () => {
    const result = resolveSpawnLevelToolPolicy({
      allow: ["read", "glob"],
      deny: ["bash"],
    });
    expect(result).toEqual({ allow: ["read", "glob"], deny: ["bash"] });
  });
});

// End-to-end: resolveSpawnLevelToolPolicy → isToolAllowedByPolicyName
describe("resolveSpawnLevelToolPolicy + isToolAllowedByPolicyName (integration)", () => {
  it("allow: ['read', 'glob'] — only allows read and glob", () => {
    const policy = resolveSpawnLevelToolPolicy({ allow: ["read", "glob"] });
    expect(isToolAllowedByPolicyName("read", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("glob", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("exec", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("write", policy)).toBe(false);
  });

  it("deny: ['bash'] — excludes bash (aliased to exec), allows others", () => {
    const policy = resolveSpawnLevelToolPolicy({ deny: ["bash"] });
    // "bash" is aliased to "exec" via normalizeToolName
    expect(isToolAllowedByPolicyName("bash", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("exec", policy)).toBe(false);
    expect(isToolAllowedByPolicyName("read", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("glob", policy)).toBe(true);
  });

  it("allow + deny — deny takes priority over allow", () => {
    const policy = resolveSpawnLevelToolPolicy({
      allow: ["read", "glob", "exec"],
      deny: ["exec"],
    });
    expect(isToolAllowedByPolicyName("read", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("glob", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("exec", policy)).toBe(false);
  });

  it("allow: ['*'] — allows all tools (wildcard)", () => {
    const policy = resolveSpawnLevelToolPolicy({ allow: ["*"] });
    expect(isToolAllowedByPolicyName("read", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("exec", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("some_random_tool", policy)).toBe(true);
  });

  it("undefined policy — everything is allowed (no restriction)", () => {
    const policy = resolveSpawnLevelToolPolicy(undefined);
    expect(isToolAllowedByPolicyName("read", policy)).toBe(true);
    expect(isToolAllowedByPolicyName("exec", policy)).toBe(true);
  });
});
