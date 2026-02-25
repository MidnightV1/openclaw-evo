import { Type } from "@sinclair/typebox";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { optionalStringEnum } from "../schema/typebox.js";
import {
  SUBAGENT_RESPONSE_FORMATS,
  SUBAGENT_SPAWN_MODES,
  spawnSubagentDirect,
  type SpawnSubagentToolPolicy,
  type SubagentResponseFormat,
} from "../subagent-spawn.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat: older callers used timeoutSeconds for this tool.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  thread: Type.Optional(Type.Boolean()),
  mode: optionalStringEnum(SUBAGENT_SPAWN_MODES),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  /** Expected response format: "json" (strict JSON), "text" (default), or "structured" (JSON meta + text body). */
  responseFormat: optionalStringEnum(SUBAGENT_RESPONSE_FORMATS),
  /** JSON Schema for validating the response when responseFormat="json". */
  responseSchema: Type.Optional(Type.Object({}, { additionalProperties: true })),
  /** Per-spawn tool policy override. allow = whitelist, deny = blacklist. Applied as highest priority. */
  toolPolicy: Type.Optional(
    Type.Object({
      allow: Type.Optional(Type.Array(Type.String())),
      deny: Type.Optional(Type.Array(Type.String())),
    }),
  ),
});

export function createSessionsSpawnTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  sandboxed?: boolean;
  /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    description:
      'Spawn a sub-agent in an isolated session (mode="run" one-shot or mode="session" persistent) and route results back to the requester chat/thread.',
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      const label = typeof params.label === "string" ? params.label.trim() : "";
      const requestedAgentId = readStringParam(params, "agentId");
      const modelOverride = readStringParam(params, "model");
      const thinkingOverrideRaw = readStringParam(params, "thinking");
      const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      // Back-compat: older callers used timeoutSeconds for this tool.
      const timeoutSecondsCandidate =
        typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : typeof params.timeoutSeconds === "number"
            ? params.timeoutSeconds
            : undefined;
      const runTimeoutSeconds =
        typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate)
          ? Math.max(0, Math.floor(timeoutSecondsCandidate))
          : undefined;
      const thread = params.thread === true;

      // Parse responseFormat
      const responseFormatRaw = readStringParam(params, "responseFormat");
      const responseFormat: SubagentResponseFormat | undefined =
        responseFormatRaw && SUBAGENT_RESPONSE_FORMATS.includes(responseFormatRaw as SubagentResponseFormat)
          ? (responseFormatRaw as SubagentResponseFormat)
          : undefined;

      // Parse responseSchema (only meaningful when responseFormat="json")
      const responseSchema =
        responseFormat === "json" && params.responseSchema && typeof params.responseSchema === "object"
          ? params.responseSchema
          : undefined;

      // Parse toolPolicy
      const rawToolPolicy = params.toolPolicy;
      const parsedToolPolicy: SpawnSubagentToolPolicy | undefined = (() => {
        if (!rawToolPolicy || typeof rawToolPolicy !== "object") return undefined;
        const allow = Array.isArray((rawToolPolicy as Record<string, unknown>).allow)
          ? ((rawToolPolicy as Record<string, unknown>).allow as string[]).filter(
              (v) => typeof v === "string" && v.trim(),
            )
          : [];
        const deny = Array.isArray((rawToolPolicy as Record<string, unknown>).deny)
          ? ((rawToolPolicy as Record<string, unknown>).deny as string[]).filter(
              (v) => typeof v === "string" && v.trim(),
            )
          : [];
        return (allow.length > 0 || deny.length > 0)
          ? { allow: allow.length > 0 ? allow : undefined, deny: deny.length > 0 ? deny : undefined }
          : undefined;
      })();
      const toolPolicy = parsedToolPolicy;

      const result = await spawnSubagentDirect(
        {
          task,
          label: label || undefined,
          agentId: requestedAgentId,
          model: modelOverride,
          thinking: thinkingOverrideRaw,
          runTimeoutSeconds,
          thread,
          mode,
          cleanup,
          expectsCompletionMessage: true,
          responseFormat,
          responseSchema,
          toolPolicy,
        },
        {
          agentSessionKey: opts?.agentSessionKey,
          agentChannel: opts?.agentChannel,
          agentAccountId: opts?.agentAccountId,
          agentTo: opts?.agentTo,
          agentThreadId: opts?.agentThreadId,
          agentGroupId: opts?.agentGroupId,
          agentGroupChannel: opts?.agentGroupChannel,
          agentGroupSpace: opts?.agentGroupSpace,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
        },
      );

      return jsonResult(result);
    },
  };
}
