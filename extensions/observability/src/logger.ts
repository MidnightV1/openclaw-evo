/**
 * Two-layer LLM call logger.
 *
 * - Stats layer (permanent): JSONL with agent attribution + token + cost
 * - Raw layer (7-day retention): Full request/response bodies, date-partitioned
 */

import fs from "node:fs";
import path from "node:path";
import { estimateCost, type CostEstimate } from "./pricing.js";

export type LlmCallRecord = {
  /** ISO timestamp */
  ts: string;
  /** Unique run identifier */
  runId: string;
  /** Session identifier */
  sessionId: string;
  /** Session key (contains agent routing info) */
  sessionKey?: string;
  /** Agent identifier */
  agentId?: string;
  /** Parent agent (if subagent) */
  parentAgentId?: string;
  /** LLM provider */
  provider: string;
  /** Model identifier */
  model: string;
  /** Input token count */
  inputTokens?: number;
  /** Output token count */
  outputTokens?: number;
  /** Cached input tokens */
  cacheReadTokens?: number;
  /** Cache write tokens */
  cacheWriteTokens?: number;
  /** Total tokens */
  totalTokens?: number;
  /** Cost estimate */
  cost?: CostEstimate;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Whether this was a subagent call */
  isSubagent: boolean;
  /** Error message if failed */
  error?: string;
};

export type RawLlmPayload = {
  ts: string;
  runId: string;
  sessionKey?: string;
  stage: "input" | "output";
  payload: unknown;
};

// Pending input records waiting for their output counterpart
const pendingInputs = new Map<
  string,
  { startMs: number; sessionKey?: string; agentId?: string; parentAgentId?: string }
>();

export function createCallLogger(params: {
  statsDir: string;
  rawDir: string;
  rawRetentionDays: number;
}) {
  const { statsDir, rawDir, rawRetentionDays } = params;

  // Ensure directories exist
  fs.mkdirSync(statsDir, { recursive: true });

  function getStatsPath(): string {
    return path.join(statsDir, "llm-calls.jsonl");
  }

  function getRawDayDir(): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dir = path.join(rawDir, date);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeJsonl(filePath: string, data: unknown): void {
    try {
      const line = JSON.stringify(data) + "\n";
      fs.appendFileSync(filePath, line, "utf-8");
    } catch {
      // Silent fail — observability should never crash the host
    }
  }

  function recordInput(event: {
    runId: string;
    sessionId: string;
    sessionKey?: string;
    provider: string;
    model: string;
    systemPrompt?: string;
    prompt: string;
    historyMessages: unknown[];
    agentId?: string;
    parentAgentId?: string;
  }): void {
    pendingInputs.set(event.runId, {
      startMs: Date.now(),
      sessionKey: event.sessionKey,
      agentId: event.agentId,
      parentAgentId: event.parentAgentId,
    });

    // Write raw input
    const rawPayload: RawLlmPayload = {
      ts: new Date().toISOString(),
      runId: event.runId,
      sessionKey: event.sessionKey,
      stage: "input",
      payload: {
        provider: event.provider,
        model: event.model,
        systemPrompt: event.systemPrompt,
        prompt: event.prompt,
        historyMessageCount: event.historyMessages.length,
      },
    };
    writeJsonl(path.join(getRawDayDir(), `${event.runId}.input.jsonl`), rawPayload);
  }

  function recordOutput(event: {
    runId: string;
    sessionId: string;
    provider: string;
    model: string;
    assistantTexts: string[];
    lastAssistant?: unknown;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
    error?: string;
  }): void {
    const pending = pendingInputs.get(event.runId);
    pendingInputs.delete(event.runId);

    const durationMs = pending ? Date.now() - pending.startMs : undefined;
    const isSubagent = (pending?.sessionKey ?? "").includes("subagent:");

    const cost = estimateCost({
      modelId: event.model,
      inputTokens: event.usage?.input,
      outputTokens: event.usage?.output,
      cacheReadTokens: event.usage?.cacheRead,
      contextTokens: event.usage?.total,
    });

    // Stats record (permanent)
    const record: LlmCallRecord = {
      ts: new Date().toISOString(),
      runId: event.runId,
      sessionId: event.sessionId,
      sessionKey: pending?.sessionKey,
      agentId: pending?.agentId,
      parentAgentId: pending?.parentAgentId,
      provider: event.provider,
      model: event.model,
      inputTokens: event.usage?.input,
      outputTokens: event.usage?.output,
      cacheReadTokens: event.usage?.cacheRead,
      cacheWriteTokens: event.usage?.cacheWrite,
      totalTokens: event.usage?.total,
      cost,
      durationMs,
      isSubagent,
      error: event.error,
    };
    writeJsonl(getStatsPath(), record);

    // Raw output
    const rawPayload: RawLlmPayload = {
      ts: new Date().toISOString(),
      runId: event.runId,
      sessionKey: pending?.sessionKey,
      stage: "output",
      payload: {
        provider: event.provider,
        model: event.model,
        assistantTexts: event.assistantTexts,
        lastAssistant: event.lastAssistant,
        usage: event.usage,
        error: event.error,
      },
    };
    writeJsonl(path.join(getRawDayDir(), `${event.runId}.output.jsonl`), rawPayload);
  }

  function cleanupRawLogs(): number {
    if (!fs.existsSync(rawDir)) {
      return 0;
    }
    const cutoff = Date.now() - rawRetentionDays * 24 * 60 * 60 * 1000;
    let cleaned = 0;

    try {
      const entries = fs.readdirSync(rawDir);
      for (const entry of entries) {
        // Directory names are YYYY-MM-DD
        const dirDate = new Date(entry + "T00:00:00Z");
        if (Number.isNaN(dirDate.getTime())) {
          continue;
        }
        if (dirDate.getTime() < cutoff) {
          const dirPath = path.join(rawDir, entry);
          fs.rmSync(dirPath, { recursive: true, force: true });
          cleaned++;
        }
      }
    } catch {
      // Silent fail
    }
    return cleaned;
  }

  return {
    recordInput,
    recordOutput,
    cleanupRawLogs,
    getStatsPath,
  };
}
