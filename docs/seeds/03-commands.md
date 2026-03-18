# Seed: Slash Commands

All commands are placed in `~/.claude/commands/` and reference the `cmux-team` skill.

---

## /team-init

**File:** `team-init.md`

**Purpose:** Initialize `.team/` directory structure in the current project.

**Behavior:**
1. Create `.team/` directory structure:
   ```
   .team/
   ├── team.json
   ├── specs/
   ├── output/
   ├── issues/open/
   ├── issues/closed/
   ├── prompts/
   └── docs-snapshot/
   ```
2. Initialize `team.json` with project name (derived from directory) and empty agents list
3. Add `.team/output/` and `.team/prompts/` to `.gitignore` (ephemeral)
4. Keep `.team/specs/` and `.team/issues/` tracked in git
5. Print summary of initialized structure

**Arguments:** `$ARGUMENTS` = project description (optional, stored in team.json)

---

## /team-research

**File:** `team-research.md`

**Purpose:** Spawn researcher agents to investigate a topic in parallel.

**Behavior:**
1. Parse topic from `$ARGUMENTS`
2. Decompose topic into 3 sub-questions (or use user-provided list)
3. Generate researcher prompts → `.team/prompts/researcher-{1,2,3}.md`
4. Spawn 3 researcher agents via cmux (1+3 layout)
5. Wait for all 3 to complete (`cmux wait-for`)
6. Read `.team/output/researcher-{1,2,3}.md`
7. Synthesize findings and present to user
8. Optionally save synthesis to `.team/specs/research.md`

**Arguments:** `$ARGUMENTS` = research topic or comma-separated sub-topics

---

## /team-spec

**File:** `team-spec.md`

**Purpose:** Interactive spec brainstorming with user. May spawn researchers.

**Behavior:**
1. If `.team/specs/requirements.md` exists, load it as starting point
2. Engage user in conversation about requirements
3. If research is needed, offer to run `/team-research`
4. Generate/update `.team/specs/requirements.md`
5. Ask for user approval before proceeding

**Arguments:** none (interactive)

---

## /team-design

**File:** `team-design.md`

**Purpose:** Spawn architect + reviewers for design phase.

**Behavior:**
1. Verify `.team/specs/requirements.md` exists and is approved
2. Generate architect prompt (include requirements + any research)
3. Spawn Architect agent (1 pane)
4. Wait for architect to complete → `.team/output/architect.md`
5. Copy architect output to `.team/specs/design.md`
6. Spawn 2 Reviewer agents with design as input
7. Wait for reviewers → `.team/output/reviewer-{1,2}.md`
8. Synthesize review feedback, present to user
9. If changes needed, iterate (respawn architect with feedback)
10. Finalize `.team/specs/design.md`

**Arguments:** none

---

## /team-impl

**File:** `team-impl.md`

**Purpose:** Spawn implementer agents for coding tasks.

**Behavior:**
1. Verify `.team/specs/design.md` and `.team/specs/tasks.md` exist
2. If tasks.md doesn't exist, generate it from design.md first
3. Parse tasks, identify parallel-safe tasks (marked with `(P)`)
4. Assign tasks to implementer agents
5. Spawn implementers (up to tier limit)
6. Monitor progress via `cmux read-screen` and status updates
7. As agents complete, assign next pending tasks
8. Collect all outputs → `.team/output/implementer-{N}.md`
9. Report completion status to user

**Arguments:** `$ARGUMENTS` = optional task numbers to implement (e.g., "1,2,3" or "all")

---

## /team-review

**File:** `team-review.md`

**Purpose:** Spawn reviewer agent for implementation review.

**Behavior:**
1. Collect git diff of changes since last review (or since team-init)
2. Read `.team/specs/requirements.md` and `.team/specs/design.md`
3. Generate reviewer prompt with diff + specs
4. Spawn Reviewer agent
5. Wait for completion → `.team/output/reviewer-impl.md`
6. Present review results to user
7. Create issues for any findings

**Arguments:** none

---

## /team-test

**File:** `team-test.md`

**Purpose:** Spawn tester agents for test creation and execution.

**Behavior:**
1. Read implementation outputs and git diff
2. Generate tester prompts (split by: unit, integration, e2e if applicable)
3. Spawn tester agents (up to 3)
4. Wait for completion
5. Collect test results → `.team/output/tester-{N}.md`
6. Run test suites and report pass/fail
7. Create issues for failures

**Arguments:** `$ARGUMENTS` = optional test scope ("unit", "integration", "e2e", or "all")

---

## /team-sync-docs

**File:** `team-sync-docs.md`

**Purpose:** Synchronize `docs/` with current `.team/specs/` state.

**Behavior:**
1. Read all files in `.team/specs/`
2. Compare with `.team/docs-snapshot/` (last synced state)
3. If no changes, report "docs are up to date"
4. If changes detected:
   a. Generate/update `docs/<project>/` structure
   b. Format specs into clean documentation
   c. Update `.team/docs-snapshot/` with current state
5. Show diff summary to user
6. Optionally create git commit

**Arguments:** none

---

## /team-issue

**File:** `team-issue.md`

**Purpose:** Create, list, close, and manage issues.

**Behavior:**
- `$ARGUMENTS` = "" → list all open issues
- `$ARGUMENTS` = "create <title>" → create new issue interactively
- `$ARGUMENTS` = "close <id>" → move issue to closed/
- `$ARGUMENTS` = "show <id>" → display issue details
- `$ARGUMENTS` = "<title>" → shorthand for create

---

## /team-status

**File:** `team-status.md`

**Purpose:** Show current team status.

**Behavior:**
1. Read `.team/team.json`
2. For each agent: show role, status, surface, current task
3. Run `cmux tree --all` for topology
4. Show open issue count
5. Show phase progress
6. Check agent health via `cmux read-screen` (detect crashes)

**Arguments:** none

---

## /team-disband

**File:** `team-disband.md`

**Purpose:** Close all sub-agent panes.

**Behavior:**
1. Read `.team/team.json` for active agents
2. For each agent:
   a. Send `/exit` command
   b. Wait briefly
   c. Close surface: `cmux close-surface --surface <ref>`
   d. Clear status: `cmux clear-status <role>`
3. Clear progress bar
4. Update team.json (clear agents list)
5. Report summary

**Arguments:** `$ARGUMENTS` = optional "force" to skip graceful shutdown
