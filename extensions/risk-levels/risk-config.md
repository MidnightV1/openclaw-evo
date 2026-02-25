# Risk Level Configuration

Tool execution risk classification for progressive authorization.
This file is injected into agent system prompt context.

---

## Risk Levels

| Level | Label | Behavior | Examples |
|-------|-------|----------|----------|
| 0 | No risk | Silent execution | read, glob, grep, list_files |
| 1 | Low risk | Silent execution + log | write (new file), mkdir, stat |
| 2 | Medium-low risk | Confirm first N times, then silent | bash (non-destructive), npm install, pip install |
| 3 | Medium-high risk | Confirm every time, allow-always available | edit (existing file), git commit, git add |
| 4 | High risk | Confirm every time, no allow-always | rm, git push, send_message, deploy |
| 5 | Critical risk | Double confirmation, cannot skip | rm -rf, DROP TABLE, TRUNCATE, force push, format |

---

## Rules

- **Level 0-1**: No user interruption. Level 1 writes an audit log entry.
- **Level 2**: After N consecutive approvals (default: 5) of the same tool+pattern, auto-approve silently.
- **Level 3**: Always prompt. User may select "allow-always" to permanently whitelist the specific tool+pattern.
- **Level 4**: Always prompt. "allow-always" is NOT offered. Each invocation requires explicit approval.
- **Level 5**: Two-phase confirmation. First prompt describes the action; second prompt warns irreversibility.

---

## Tool-to-Level Mapping

### Level 0 (read-only, no side effects)
- `read`, `glob`, `grep`, `search`, `list_files`, `web_search`, `web_fetch`

### Level 1 (low side effects, easily reversible)
- `write` (new file only), `mkdir`, `notebook_edit` (new cell)

### Level 2 (moderate side effects, generally safe)
- `bash` (non-destructive commands: ls, cat, npm install, pip install, cargo build, etc.)
- `notebook_edit` (replace existing cell)

### Level 3 (meaningful changes to existing state)
- `edit` (existing files), `git commit`, `git add`, `git checkout`, `git merge`
- `write` (overwrite existing file)

### Level 4 (potentially destructive, hard to reverse)
- `rm` (single file), `git push`, `send_message`, `deploy`
- `bash` with destructive patterns (rm, mv to /dev/null, kill, pkill)

### Level 5 (catastrophically destructive)
- `rm -rf`, `git push --force`, `git reset --hard`
- SQL: `DROP`, `TRUNCATE`, `DELETE FROM ... WHERE 1=1`
- `format`, `fdisk`, `mkfs`

---

## Trash / Recycle Bin

File deletions at Level 4+ are intercepted:
- Files are moved to `.openclaw/trash/{YYYY-MM-DD}/` instead of deleted.
- Trash is auto-cleaned after 7 days.
- Original path is recorded in `.openclaw/trash/manifest.json` for restore.
