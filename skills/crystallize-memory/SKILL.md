---
name: crystallize-memory
description: Crystallize learnings from this conversation into persistent memory files (SOUL.md, USER_COGNITION.md, USER.md, etc.). Use at the natural end of a meaningful session — when the conversation genuinely changed your understanding of this person, their preferences, your working style together, or anything worth persisting across sessions. Do not use for routine or short exchanges.
metadata: { "openclaw": { "emoji": "🔮", "requires": { "bins": ["jq"] } } }
---

# crystallize-memory

Queue the current session for async memory crystallization. Returns immediately — the worker processes in the background.

## When to Use

Trust your judgment. Use when:
- You learned something new about how this person thinks or works
- A preference, pattern, or boundary became clearer
- You were corrected in a way worth remembering
- The conversation shaped who you are with this person

Skip for routine sessions where nothing changed.

## How

Find these values in your system prompt Runtime line: `agent=<agentId>`, `session=<sessionId>`, `workspace=<workspaceDir>`.

Then run:

```bash
bash <skill_location_dir>/scripts/queue-crystallization.sh "<agentId>" "<sessionId>" "<workspaceDir>"
```

Where `<skill_location_dir>` is the directory containing this SKILL.md (strip the `/SKILL.md` suffix from the skill's `location` field in the system prompt).

## After Calling

Briefly acknowledge: *"I've queued a memory update — my understanding of you will be refined in the background and ready next session."*

Keep it light. This is housekeeping, not a ceremony.
