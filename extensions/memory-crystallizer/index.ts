/**
 * Memory Crystallizer Plugin — Phase 2
 *
 * Thin message capturer: hooks into agent_end to serialize the full
 * conversation into a queue directory. An external worker process
 * picks up queue files, invokes an LLM for deep crystallization,
 * and writes the results to git-versioned storage.
 *
 * This plugin contains ZERO intelligence — no parsing, no extraction,
 * no heuristics. It is a reliable pipe from runtime to disk.
 *
 * The worker is automatically started as a plugin service when the Gateway
 * launches (if crystallizer.config.json is present), and stopped on shutdown.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

type CrystallizerConfig = {
  enabled?: boolean;
  /** Minimum messages to trigger capture (skip trivial sessions) */
  minMessageCount?: number;
  /** Queue directory for pending crystallization jobs */
  queueDir?: string;
};

type QueueEntry = {
  sessionId: string;
  agentId?: string;
  workspaceDir?: string;
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
  capturedAt: string;
};

export default function register(api: OpenClawPluginApi) {
  const pluginConfig = (api.config?.plugins?.["memory-crystallizer"] ?? {}) as CrystallizerConfig;
  if (pluginConfig.enabled === false) {
    return;
  }

  const minMessages = pluginConfig.minMessageCount ?? 5;
  const stateDir =
    process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "~", ".openclaw");
  const queueDir = pluginConfig.queueDir ?? path.join(stateDir, "memory", "crystallization-queue");

  api.on("agent_end", async (event, ctx) => {
    try {
      // Skip subagent sessions — only crystallize main agent conversations
      if (ctx.sessionKey?.includes("subagent:")) {
        return;
      }

      const messages = event.messages ?? [];
      if (messages.length < minMessages) {
        return;
      }

      fs.mkdirSync(queueDir, { recursive: true });

      const entry: QueueEntry = {
        sessionId: ctx.sessionId ?? "unknown",
        agentId: ctx.agentId,
        workspaceDir: ctx.workspaceDir,
        messages,
        success: event.success,
        error: event.error,
        durationMs: event.durationMs,
        capturedAt: new Date().toISOString(),
      };

      const ts = Date.now();
      const sid = (ctx.sessionId ?? "unknown").slice(0, 8);
      const fileName = `${ts}_${sid}.json`;
      fs.writeFileSync(path.join(queueDir, fileName), JSON.stringify(entry), "utf-8");

      api.logger.info(`crystallizer: captured ${messages.length} messages → ${fileName}`);
    } catch (err) {
      api.logger.error(`crystallizer: capture failed: ${err}`);
    }
  });

  // Auto-start the crystallization worker as a Gateway service.
  // The worker polls the queue directory and runs the two-stage LLM pipeline.
  // It only starts if crystallizer.config.json is present alongside this plugin.
  let workerProcess: ChildProcess | null = null;

  api.registerService({
    id: "memory-crystallizer-worker",

    start(ctx) {
      const pluginDir = path.dirname(fileURLToPath(import.meta.url));
      const workerPath = path.join(pluginDir, "src", "worker.ts");
      const configPath = path.join(pluginDir, "crystallizer.config.json");

      if (!fs.existsSync(configPath)) {
        ctx.logger.warn(
          `crystallizer worker: no config at ${configPath} — skipping auto-start. ` +
            `Create crystallizer.config.json or run the worker manually.`,
        );
        return;
      }

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CRYSTALLIZER_CONFIG: configPath,
        CRYSTALLIZER_QUEUE_DIR: queueDir,
      };

      workerProcess = spawn("bun", [workerPath], {
        env,
        stdio: ["ignore", "inherit", "inherit"],
        detached: false,
      });

      workerProcess.on("error", (err) => {
        ctx.logger.error(`crystallizer worker failed to start: ${err.message}`);
        workerProcess = null;
      });

      workerProcess.on("exit", (code, signal) => {
        workerProcess = null;
        if (signal !== "SIGTERM" && code !== 0) {
          ctx.logger.warn(
            `crystallizer worker exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"})`,
          );
        }
      });

      ctx.logger.info("crystallizer worker started");
    },

    stop(ctx) {
      if (workerProcess) {
        workerProcess.kill("SIGTERM");
        workerProcess = null;
        ctx.logger.info("crystallizer worker stopped");
      }
    },
  });
}
