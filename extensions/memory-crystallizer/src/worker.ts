/**
 * Memory Crystallization Worker
 *
 * Stage 1 (Opus-level): Reads current holistic user portrait + new session
 *   interaction signals. Decides whether the portrait needs updating.
 *   If yes, outputs the complete updated portrait as XML. If no, outputs
 *   <portrait action="unchanged" />.
 *
 * Stage 2 (Flash/Sonnet-level): Takes the Stage 1 full portrait output and
 *   splits it into the appropriate bootstrap files per routing config.
 *   Pure mechanical decomposition — no analysis, no judgment.
 *
 * Core principle: Reconstructive memory — the portrait always represents
 * "our best current understanding", not a log of what happened.
 *
 * Usage:
 *   npx tsx extensions/memory-crystallizer/src/worker.ts
 *
 * Environment:
 *   CRYSTALLIZER_CONFIG    — path to config JSON (default: ./crystallizer.config.json)
 *   CRYSTALLIZER_QUEUE_DIR — queue directory override
 *   CRYSTALLIZER_POLL_MS   — poll interval in ms (default: 5000)
 */

import fs from "node:fs";
import path from "node:path";
import { createProvider, type LLMProvider } from "./providers.js";
import { ensureGitRepo, commitFile } from "./git-store.js";
import {
  normalizeWinPath,
  buildSignalPairs,
  parseStage1Result,
  parseStage2Result,
  resolveRoutePath,
  type FileRoute,
  type FileOutput,
} from "./parsing.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

type ModelConfig = {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  thinking?: boolean | number | "low" | "medium" | "high";
};

type CrystallizerConfig = {
  stage1: ModelConfig;
  stage2: ModelConfig;
  /** Path to the holistic portrait file (Stage 1 reads/writes this) */
  portraitPath: string;
  /** Routes for Stage 2 decomposition into bootstrap files */
  routes: FileRoute[];
  queueDir?: string;
  pollMs?: number;
  minUserMessages?: number;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_PATH = normalizeWinPath(
  process.env.CRYSTALLIZER_CONFIG ??
  path.join(path.dirname(new URL(import.meta.url).pathname), "..", "crystallizer.config.json"),
);

function loadConfig(): CrystallizerConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}`);
    console.error(`Create crystallizer.config.json or set CRYSTALLIZER_CONFIG env var.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as CrystallizerConfig;
}

function resolveApiKey(cfg: ModelConfig): string {
  if (cfg.apiKey) return cfg.apiKey;
  const envMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    gemini: "GEMINI_API_KEY",
    openai: "OPENAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
  };
  const envKey = envMap[cfg.provider];
  const val = envKey ? process.env[envKey] : undefined;
  if (!val) {
    throw new Error(`No API key for ${cfg.provider}. Set ${envKey} or config.apiKey`);
  }
  return val;
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(process.env.HOME || process.env.USERPROFILE || "~", p.slice(2));
  }
  return path.isAbsolute(p) ? p : path.resolve(path.dirname(CONFIG_PATH), p);
}

// ---------------------------------------------------------------------------
// Stage 1: Portrait reconstruction (Opus-level)
// ---------------------------------------------------------------------------

const STAGE1_SYSTEM = `You are a user cognition profiler. You maintain a holistic portrait of a human user based on their behavioral signals in conversations with an AI coding assistant.

## Core Principle: Reconstructive Memory

Memory serves the present, not the past. The portrait represents the current best understanding. New evidence can rewrite, sharpen, or remove old entries. Old versions are preserved by git — the portrait itself is always present-tense.

## Signal Source

ONLY analyze the USER's messages. Assistant messages are context (what the user was responding to), not signal.

Observe:
- What they say: explicit preferences, goals, domain knowledge, values
- How they say it: language density, abstraction level, code-switching, directive vs exploratory
- What they choose: selection criteria when given options
- What they correct: what triggers pushback vs what they accept
- What they skip: topics they compress, suggestions they ignore
- How they sequence: top-down vs bottom-up, breadth-first vs depth-first
- When they escalate: what increases engagement vs disengagement
- Decision speed: snap decisions vs deliberation

## Task

You receive:
1. The CURRENT PORTRAIT (may be empty if first run)
2. INTERACTION RECORD from a new session

Compare the signals against the current portrait. Decide: does anything need updating?

## Output Format (XML)

If NO update needed (signals reinforce existing portrait, or insufficient signal):

<portrait action="unchanged" />

If update needed (new patterns, contradictions, sharper understanding, or first run):

<portrait action="updated">
... complete updated portrait in natural language (markdown) ...
</portrait>

Rules:
- The portrait is a holistic document about the user — cognitive patterns, decision-making, communication style, preferences, background, growth trajectory, anything relevant.
- Use natural language. A portrait is a living description, not a database schema.
- Every claim must trace to observable behavior.
- Be concise but rich — a useful portrait, not an exhaustive log.
- If current portrait is empty, build the initial portrait from observed signals.
- Output ONLY the <portrait> XML tag, nothing else.`;

async function runStage1(
  provider: LLMProvider,
  config: ModelConfig,
  currentPortrait: string,
  signalPairs: string,
): Promise<{ action: "unchanged" | "updated"; content?: string }> {
  const userContent = [
    "<current-portrait>",
    currentPortrait || "(empty — first session, build initial portrait)",
    "</current-portrait>",
    "",
    "<interaction-record>",
    signalPairs,
    "</interaction-record>",
  ].join("\n");

  const result = await provider.complete({
    model: config.model,
    system: STAGE1_SYSTEM,
    userContent,
    maxTokens: 8192,
    thinking: config.thinking,
  });

  return parseStage1Result(result);
}

// ---------------------------------------------------------------------------
// Stage 2: Decompose portrait into bootstrap files (Flash/Sonnet-level)
// ---------------------------------------------------------------------------

const STAGE2_SYSTEM = `You are a document decomposer. You take a holistic user portrait and split its content into separate files based on routing instructions.

## Task

You receive:
1. A COMPLETE USER PORTRAIT (markdown, natural language)
2. A list of TARGET FILES, each with a path and purpose description

For each target file, extract the relevant portions of the portrait that belong in that file. Rewrite as needed to fit the file's purpose and voice, but preserve all information.

## Output Format (XML)

<files>
  <file path="path/to/file.md">
  ... complete file content (markdown) ...
  </file>
  <file path="path/to/other.md">
  ... complete file content (markdown) ...
  </file>
</files>

Rules:
- Every piece of information from the portrait must end up in exactly one file.
- If a piece of information doesn't fit any file's purpose, put it in the file whose purpose is closest.
- Each file's content should be self-contained and well-structured.
- Preserve the natural language quality — do not flatten into bullet lists unless the original was bullet lists.
- Output ONLY the <files> XML block, nothing else.`;

async function runStage2(
  provider: LLMProvider,
  config: ModelConfig,
  portrait: string,
  routes: FileRoute[],
): Promise<FileOutput[]> {
  const routeList = routes
    .map((r) => `<target path="${r.path}" purpose="${r.purpose}" />`)
    .join("\n");

  const userContent = [
    "<portrait>",
    portrait,
    "</portrait>",
    "",
    "<targets>",
    routeList,
    "</targets>",
  ].join("\n");

  const result = await provider.complete({
    model: config.model,
    system: STAGE2_SYSTEM,
    userContent,
    maxTokens: 8192,
  });

  return parseStage2Result(result);
}

// ---------------------------------------------------------------------------
// Queue processing
// ---------------------------------------------------------------------------

async function processFile(
  filePath: string,
  config: CrystallizerConfig,
  stage1Provider: LLMProvider,
  stage2Provider: LLMProvider,
): Promise<void> {
  const raw = fs.readFileSync(filePath, "utf-8");
  const entry = JSON.parse(raw) as QueueEntry;
  const sid = entry.sessionId.slice(0, 8);

  const { pairs, userCount } = buildSignalPairs(entry.messages);
  const minMsgs = config.minUserMessages ?? 3;
  if (userCount < minMsgs) {
    console.log(`  ${sid}: ${userCount} user msgs (min ${minMsgs}), skipping`);
    fs.unlinkSync(filePath);
    return;
  }

  console.log(`  ${sid}: ${userCount} user signals`);

  // Read current holistic portrait
  const portraitPath = expandPath(config.portraitPath);
  const currentPortrait = fs.existsSync(portraitPath)
    ? fs.readFileSync(portraitPath, "utf-8")
    : "";

  // Stage 1: Analyze + reconstruct portrait
  console.log(`  ${sid}: stage 1 — analyzing (${stage1Provider.name}/${config.stage1.model})`);
  const stage1Result = await runStage1(stage1Provider, config.stage1, currentPortrait, pairs);

  if (stage1Result.action === "unchanged" || !stage1Result.content) {
    console.log(`  ${sid}: portrait unchanged`);
    fs.unlinkSync(filePath);
    return;
  }

  console.log(`  ${sid}: portrait updated, writing holistic file`);

  // Save holistic portrait
  const portraitDir = path.dirname(portraitPath);
  fs.mkdirSync(portraitDir, { recursive: true });
  ensureGitRepo(portraitDir);
  fs.writeFileSync(portraitPath, stage1Result.content, "utf-8");
  const date = entry.capturedAt.slice(0, 10);
  commitFile({
    repoDir: portraitDir,
    filePath: portraitPath,
    commitMessage: `crystallize: ${date} session ${sid} — portrait updated`,
  });

  // Stage 2: Decompose into bootstrap files
  if (config.routes.length === 0) {
    console.log(`  ${sid}: no routes configured, skipping decomposition`);
    fs.unlinkSync(filePath);
    return;
  }

  console.log(`  ${sid}: stage 2 — decomposing into ${config.routes.length} files (${stage2Provider.name}/${config.stage2.model})`);
  const fileOutputs = await runStage2(stage2Provider, config.stage2, stage1Result.content, config.routes);

  let filesWritten = 0;
  for (const output of fileOutputs) {
    const routePath = resolveRoutePath(output.path, config.routes);
    if (!routePath) {
      console.log(`  ${sid}: LLM output path "${output.path}" matches no configured route, skipping`);
      continue;
    }
    const targetPath = expandPath(routePath);

    // Check if content actually changed
    const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf-8") : "";
    if (output.content.trim() === existing.trim()) {
      console.log(`  ${sid}: ${path.basename(routePath)} unchanged`);
      continue;
    }

    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });
    ensureGitRepo(dir);
    fs.writeFileSync(targetPath, output.content, "utf-8");
    commitFile({
      repoDir: dir,
      filePath: targetPath,
      commitMessage: `crystallize: ${date} session ${sid}`,
    });
    filesWritten++;
    console.log(`  ${sid}: ${path.basename(routePath)} updated`);
  }

  fs.unlinkSync(filePath);
  console.log(`  ${sid}: done — ${filesWritten} bootstrap files updated`);
}

async function pollOnce(
  config: CrystallizerConfig,
  stage1Provider: LLMProvider,
  stage2Provider: LLMProvider,
): Promise<number> {
  const queueDir = process.env.CRYSTALLIZER_QUEUE_DIR ?? config.queueDir ??
    path.join(process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "~", ".openclaw"),
      "memory", "crystallization-queue");

  if (!fs.existsSync(queueDir)) return 0;

  const files = fs.readdirSync(queueDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  let processed = 0;
  for (const file of files) {
    const fp = path.join(queueDir, file);
    try {
      await processFile(fp, config, stage1Provider, stage2Provider);
      processed++;
    } catch (err) {
      console.error(`  ✗ ${file}: ${err}`);
      const failedDir = path.join(queueDir, "failed");
      fs.mkdirSync(failedDir, { recursive: true });
      fs.renameSync(fp, path.join(failedDir, file));
    }
  }
  return processed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = loadConfig();

  const stage1Provider = createProvider({
    provider: config.stage1.provider,
    apiKey: resolveApiKey(config.stage1),
    baseUrl: config.stage1.baseUrl,
  });

  const stage2Provider = createProvider({
    provider: config.stage2.provider,
    apiKey: resolveApiKey(config.stage2),
    baseUrl: config.stage2.baseUrl,
  });

  const pollMs = Number(process.env.CRYSTALLIZER_POLL_MS) || config.pollMs || 5_000;

  console.log(`Memory Crystallization Worker`);
  console.log(`  stage 1: ${stage1Provider.name}/${config.stage1.model} (portrait)`);
  console.log(`  stage 2: ${stage2Provider.name}/${config.stage2.model} (decompose)`);
  console.log(`  portrait: ${config.portraitPath}`);
  console.log(`  routes: ${config.routes.map((r) => path.basename(r.path)).join(", ")}`);
  console.log(`  poll:   ${pollMs}ms`);
  console.log();

  const initial = await pollOnce(config, stage1Provider, stage2Provider);
  if (initial > 0) console.log(`Drained ${initial} queued entries\n`);

  const poll = async () => {
    const n = await pollOnce(config, stage1Provider, stage2Provider);
    if (n > 0) console.log(`Processed ${n} entries`);
    setTimeout(poll, pollMs);
  };
  setTimeout(poll, pollMs);
}

main().catch((err) => {
  console.error(`Worker fatal: ${err}`);
  process.exit(1);
});
