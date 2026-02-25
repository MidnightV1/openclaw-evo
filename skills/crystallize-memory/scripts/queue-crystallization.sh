#!/usr/bin/env bash
# Queue the current session for async memory crystallization.
# Reads the session JSONL, converts it to a crystallizer queue entry, and exits.
# The worker (started by the memory-crystallizer plugin) processes the queue in background.
#
# Usage: queue-crystallization.sh <agentId> <sessionId> [workspaceDir]

set -euo pipefail

AGENT_ID="${1:?Usage: queue-crystallization.sh <agentId> <sessionId> [workspaceDir]}"
SESSION_ID="${2:?Usage: queue-crystallization.sh <agentId> <sessionId> [workspaceDir]}"
WORKSPACE_DIR="${3:-}"

STATE="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
SESSION_FILE="$STATE/agents/$AGENT_ID/sessions/$SESSION_ID.jsonl"
QUEUE_DIR="$STATE/memory/crystallization-queue"

# Validate session file exists
if [[ ! -f "$SESSION_FILE" ]]; then
  echo "ERROR: Session file not found: $SESSION_FILE" >&2
  exit 1
fi

# Extract messages to a temp file to avoid ARG_MAX limits on large sessions
TEMP_MESSAGES=$(mktemp /tmp/crystallize-XXXXXX.json)
trap 'rm -f "$TEMP_MESSAGES"' EXIT

jq -s '[.[] | select(.type == "message") | .message]' "$SESSION_FILE" > "$TEMP_MESSAGES"

# Count user messages — skip sessions with insufficient signal
USER_COUNT=$(jq '[.[] | select(.role == "user")] | length' "$TEMP_MESSAGES")
if [[ "$USER_COUNT" -lt 3 ]]; then
  echo "Only $USER_COUNT user messages — skipping (minimum 3 required)"
  exit 0
fi

mkdir -p "$QUEUE_DIR"

# Write queue entry
TS=$(date +%s%3N)
SID="${SESSION_ID:0:8}"
QUEUE_FILE="$QUEUE_DIR/${TS}_${SID}_skill.json"

# Use --slurpfile to read messages from temp file (avoids ARG_MAX for large sessions).
# --slurpfile wraps content in an array, so $messages[0] unwraps it.
jq -n \
  --arg sessionId "$SESSION_ID" \
  --arg agentId "$AGENT_ID" \
  --arg workspaceDir "$WORKSPACE_DIR" \
  --slurpfile messages "$TEMP_MESSAGES" \
  --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    sessionId: $sessionId,
    agentId: $agentId,
    workspaceDir: $workspaceDir,
    messages: $messages[0],
    success: true,
    skillTriggered: true,
    capturedAt: $capturedAt
  }' > "$QUEUE_FILE"

echo "Crystallization queued: $(basename "$QUEUE_FILE")"
echo "  $USER_COUNT user messages captured"
echo "  Worker will process in background — updates ready next session"
