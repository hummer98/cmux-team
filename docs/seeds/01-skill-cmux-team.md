# Seed: cmux-team Skill (Conductor Orchestration)

## File: `.claude/skills/cmux-team/SKILL.md`

## Purpose

The core orchestration skill loaded by the Conductor (parent Claude).
Teaches the Conductor how to spawn, monitor, communicate with, and collect results
from sub-agent Claude sessions via cmux CLI.

## Frontmatter

```yaml
---
name: cmux-team
description: >
  Use when orchestrating multi-agent development via cmux.
  Triggers: .team/ directory exists, user says "team", "spawn agents",
  "parallel", "sub-agent", or any /team-* command is invoked.
  Provides: agent spawning, monitoring, result collection, synchronization protocols.
---
```

## Content Sections to Implement

### 1. Quick Orientation
- Detect cmux environment: `CMUX_SOCKET_PATH` must be set
- Check `.team/team.json` for existing team state
- `cmux tree --all --json` to see current topology

### 2. Agent Lifecycle Protocol

#### Spawning
```bash
# 1. Create pane
cmux new-split right  # → surface:N

# 2. Register in team.json
# { "agents": [{ "role": "researcher-1", "surface": "surface:N", "status": "spawning" }] }

# 3. Set sidebar status
cmux set-status <role> "spawning" --icon sparkle --color "#ffcc00"

# 4. Launch autonomous Claude
cmux send --surface surface:N "claude --dangerously-skip-permissions\n"

# 5. Wait for Claude to boot (detect prompt ❯ via read-screen)
# Poll: cmux read-screen --surface surface:N | grep '❯'

# 6. Send task prompt
cmux send --surface surface:N "<prompt content>\n"

# 7. Update status
cmux set-status <role> "running" --icon hammer --color "#0099ff"
```

#### Monitoring
```bash
# Read current screen
cmux read-screen --surface surface:N --lines 50

# Read with scrollback for full output
cmux read-screen --surface surface:N --scrollback --lines 200

# Check if agent is idle (prompt visible again)
cmux read-screen --surface surface:N | tail -5 | grep '❯'
```

#### Collecting Results
```bash
# Option A: File-based (preferred)
cat .team/output/<role>.md

# Option B: Screen scraping (fallback)
cmux read-screen --surface surface:N --scrollback
```

#### Completion Synchronization
```bash
# Conductor waits:
cmux wait-for "<role>-done" --timeout 300

# Agent signals (instructed via prompt):
# cmux wait-for -S "<role>-done"
```

#### Teardown
```bash
# Close specific agent
cmux send --surface surface:N "/exit\n"
cmux close-surface --surface surface:N

# Close all agents
# Read team.json, iterate surfaces, close each
```

### 3. Prompt Generation Protocol

The Conductor generates prompts for each agent role by:
1. Reading `.team/specs/` for current requirements/design
2. Reading `.team/tasks/open/` for relevant context
3. Composing role-specific prompt from template + context
4. Writing to `.team/prompts/<role>.md` for auditability
5. Sending to agent via `cmux send`

### 4. Team State Management (team.json)

```json
{
  "project": "project-name",
  "phase": "design",
  "created_at": "2026-03-18T00:00:00Z",
  "agents": [
    {
      "id": "researcher-1",
      "role": "researcher",
      "surface": "surface:21",
      "workspace": "workspace:5",
      "status": "running",
      "task": "Investigate auth patterns",
      "started_at": "2026-03-18T00:01:00Z"
    }
  ],
  "completed_outputs": [
    "output/researcher-1.md"
  ]
}
```

### 5. Layout Strategies

```
# 1+3 (Small): vertical splits
[Conductor] | [Agent A] | [Agent B] | [Agent C]

# 1+5 (Medium): grid
[Conductor] | [Agent A] | [Agent B]
            | [Agent C] | [Agent D] | [Agent E]

# 1+7 (Large): use separate workspaces
workspace:1 → Conductor
workspace:2 → Agent A, Agent B (split)
workspace:3 → Agent C, Agent D (split)
workspace:4 → Agent E, Agent F, Agent G (3-way split)
```

For 1+5 and 1+7, prefer new workspaces over deep splits for readability:
```bash
cmux new-workspace --cwd $(pwd)  # → workspace:N, surface:M
```

### 6. Progress Tracking
```bash
# Per-agent status in sidebar
cmux set-status researcher-1 "reading files" --icon hammer --color "#0099ff"

# Phase progress
cmux set-progress 0.33 --label "Research: 1/3 agents done"
```

### 7. Error Recovery

- If `cmux read-screen` shows an error in agent pane → log to `.team/tasks/open/`
- If `cmux wait-for` times out → read-screen to diagnose, notify user
- If agent crashes → detect via missing prompt, offer to respawn
