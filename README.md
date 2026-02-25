# openclaw-evo

Personal fork of [openclaw/openclaw](https://github.com/openclaw/openclaw) — an open-source personal AI assistant platform. This repo tracks my own modifications on top of the upstream codebase.

For general documentation, setup guides, and channel configuration, refer to the [original project docs](https://docs.openclaw.ai).

---

## What's different

### Memory crystallization (`extensions/memory-crystallizer` + `skills/crystallize-memory`)

Agent-initiated persistent memory via a two-stage LLM pipeline. At the end of a meaningful session, the agent queues the full conversation for async processing: stage 1 synthesizes behavioral signals and user cognition patterns; stage 2 dispatches the results to the appropriate memory files (`SOUL.md`, `USER_COGNITION.md`, etc.). Memory is maintained as a git-versioned overwrite — no append bloat, full history preserved. The trigger is agent-initiated (via skill) rather than mechanical, with a passive `agent_end` hook as fallback.

### Cost tracking and billing (`extensions/observability`)

Token usage and API cost are tracked per session and logged in structured format. Pricing table covers major providers (Anthropic, OpenAI, Gemini). Useful for understanding real cost of long-context or multi-agent workloads.

### Prompt caching strategy (`src/agents/cache-strategy`)

Explicit cache management for system prompts and bootstrap files. Reduces cost on repeated sessions by ensuring stable, high-reuse content lands in the cache prefix. Particularly effective with Anthropic's prompt caching on long `SOUL.md` / `USER_COGNITION.md` files.

### Context entropy reduction (`extensions/context-optimizer`)

Message classifier and compressor that identifies low-signal content in long conversations (redundant tool results, repeated context, failed attempts) and compresses it before it hits the context window. Goal: keep the effective context small without losing decision-relevant information.

### Risk levels and approval gates (`extensions/risk-levels`)

Configurable risk tiers for tool calls. High-risk operations (file deletion, external sends, config changes) require explicit approval before execution. Risk rules defined in `risk-config.md`, approval state persisted across tool calls in a session.

### Task logging (`extensions/task-logging`)

Structured logging of agent tasks with timing, tool usage, and outcome. Feeds into observability and is useful for post-session review of what the agent actually did.

### Multi-agent coordination (`src/agents/subagent-*`)

Improvements to subagent spawn/registry/announce flow: cleaner handoff, explicit session key namespacing (`subagent:<id>`), and filtering to prevent subagent sessions from polluting main-agent memory crystallization.

---

## Upstream

This repo tracks `openclaw/openclaw` main. To pull upstream changes:

```bash
git fetch upstream
git merge upstream/main
```

Conflicts are expected in `src/agents/` and `src/config/` — resolve in favor of local changes unless upstream has a critical fix.
