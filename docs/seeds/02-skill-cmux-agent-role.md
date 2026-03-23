# Seed: cmux-agent-role Skill (Sub-Agent Behavior)

## File: `.claude/skills/cmux-agent-role/SKILL.md`

## Purpose

Loaded by sub-agent Claude sessions spawned by the Conductor.
Teaches the sub-agent HOW to behave: where to write output, how to signal completion,
how to create issues, and how to report status.

## Frontmatter

```yaml
---
name: cmux-agent-role
description: >
  Activated when running as a cmux-team sub-agent.
  Triggers: .team/team.json exists AND current session was spawned by Conductor
  (detect via: initial prompt contains "[CMUX-TEAM-AGENT]" marker).
  Provides: output protocol, completion signaling, task creation, status reporting.
---
```

## Content Sections to Implement

### 1. Agent Identity

On startup, the agent receives a prompt with:
```
[CMUX-TEAM-AGENT]
Role: researcher-1
Task: <task description>
Output: .team/output/researcher-1.md
Signal: cmux wait-for -S "researcher-1-done"
```

The agent MUST:
- Parse role and task from the prompt
- Know its output file path
- Know its completion signal

### 2. Output Protocol

All deliverables MUST be written to the designated output file:

```markdown
# Output: researcher-1
## Task
<original task description>

## Findings
<structured findings>

## Recommendations
<if applicable>

## Tasks Raised
- See .team/tasks/open/NNN-*.md
```

Rules:
- Write incrementally (append sections as work progresses)
- Use clear markdown structure
- Include references to files read, commands run
- Do NOT write to files outside the project unless explicitly told to

### 3. Status Reporting

During work, report status via cmux CLI:
```bash
cmux set-status <role> "<brief status>" --icon hammer --color "#0099ff"
```

Status transitions:
1. `spawning` (set by Conductor) → `running` (agent starts work)
2. `running` → update description as work progresses
3. `running` → `done` (work complete) or `error` (work failed)

```bash
# While working
cmux set-status researcher-1 "reading codebase" --icon hammer --color "#0099ff"
cmux set-status researcher-1 "analyzing patterns" --icon hammer --color "#0099ff"

# On completion
cmux set-status researcher-1 "done" --icon sparkle --color "#00cc00"

# On error
cmux set-status researcher-1 "error" --icon sparkle --color "#ff3333"
```

### 4. Completion Signal

When ALL work is done and output file is written:
```bash
cmux wait-for -S "<role>-done"
```

IMPORTANT: Signal AFTER writing the output file, not before.

### 5. Task Creation

When the agent encounters decisions, blockers, or findings that need tracking:

```bash
# Determine next task number
ls .team/tasks/open/ | wc -l  # → N, use N+1

# Create task file
```

Task format:
```markdown
---
id: NNN
title: <concise title>
type: decision|blocker|finding|question
raised_by: <role>
created_at: <ISO timestamp>
---

## Context
<what led to this task>

## Options
1. <option A> — pros/cons
2. <option B> — pros/cons

## Recommendation
<agent's recommendation if any>
```

### 6. Interaction with Other Agents

Sub-agents do NOT directly communicate with each other.
All coordination goes through:
- Shared files in `.team/`
- The Conductor (via cmux)

If an agent needs input from another agent's work:
- Read `.team/output/<other-role>.md` if it exists
- If not available, raise a task with type `blocker`

### 7. Role-Specific Guidelines

#### Researcher
- Focus on gathering facts, not making design decisions
- Cite sources (URLs, file paths, documentation references)
- Structure findings as: Context → Facts → Analysis → Recommendations

#### Architect
- Read all researcher outputs before designing
- Reference requirements from `.team/specs/requirements.md`
- Produce design decisions with rationale
- Use Mermaid diagrams for architecture

#### Reviewer
- Read the artifact being reviewed
- Check against requirements and design
- Output: Approved/Changes Requested + specific feedback items
- Raise issues for non-trivial concerns

#### Implementer
- Follow `.team/specs/design.md` strictly
- Read `.team/specs/tasks.md` for assigned tasks
- Write code, then update output with files changed
- Do NOT refactor unrelated code

#### Tester
- Read implementation output to understand what was built
- Write tests that verify requirements
- Run tests and report results
- Raise issues for test failures

#### DocKeeper
- Read all outputs and specs
- Update `docs/` to reflect current state
- Keep documentation concise and accurate

#### TaskManager
- Monitor `.team/tasks/open/` for new tasks
- Categorize, link related tasks
- Summarize open tasks for Conductor on request
