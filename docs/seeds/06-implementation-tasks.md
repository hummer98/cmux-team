# Seed: Implementation Tasks

Ordered implementation plan. Each task builds on the previous.

---

## Phase 1: Foundation

### Task 1.1: Repository scaffolding
- Create directory structure matching the install target layout
- `.claude/skills/cmux-team/SKILL.md` (stub)
- `.claude/skills/cmux-agent-role/SKILL.md` (stub)
- `.claude/commands/` (stubs for all 10 commands)
- `templates/` directory with template files
- `.gitignore`, `LICENSE` (MIT), `README.md`

### Task 1.2: install.sh / uninstall
- Implement install.sh with --uninstall and --check flags
- Test: run install, verify files exist; run uninstall, verify removed

### Task 1.3: cmux-agent-role SKILL.md
- Implement the sub-agent behavior skill (simpler, fewer dependencies)
- Include: output protocol, status reporting, completion signaling, task creation
- This must work standalone when an agent is spawned

---

## Phase 2: Core Orchestration

### Task 2.1: cmux-team SKILL.md — Agent Lifecycle
- Implement spawning, monitoring, collecting, teardown protocols
- Include: cmux CLI patterns, team.json management, error recovery

### Task 2.2: /team-init command
- Create .team/ structure, team.json, .gitignore entries
- This is the entry point — must work before anything else

### Task 2.3: /team-status command
- Read team.json, query cmux for topology, show agent health
- Useful for debugging all subsequent commands

### Task 2.4: /team-disband command
- Graceful shutdown of all agents
- Essential safety valve — implement early

---

## Phase 3: Workflow Commands

### Task 3.1: /team-research command
- Topic decomposition, researcher spawning, result synthesis
- First real multi-agent workflow — validates the whole architecture

### Task 3.2: /team-spec command
- Interactive spec brainstorming with optional research delegation
- Generates requirements.md

### Task 3.3: /team-design command
- Architect + reviewer spawning, iteration loop
- Generates design.md

### Task 3.4: /team-impl command
- Task assignment, parallel implementation, progress tracking
- Most complex command — builds on all previous

### Task 3.5: /team-review command
- Git diff collection, review spawning
- Generates review output + issues

### Task 3.6: /team-test command
- Test generation, execution, result collection
- Parallel by test type (unit/integration/e2e)

---

## Phase 4: Support Commands

### Task 4.1: /team-task command
- CRUD for tasks in .team/tasks/
- create, list, show, close subcommands

### Task 4.2: /team-sync-docs command
- Spec → docs/ synchronization with diff detection

---

## Phase 5: Templates & Polish

### Task 5.1: Agent prompt templates
- All role templates with {{VARIABLE}} placeholders
- Common header template

### Task 5.2: README.md
- Installation instructions
- Quick start guide
- Command reference
- Architecture overview
- Hooks configuration guide

### Task 5.3: Integration testing
- Manual test: /team-init → /team-research → verify results
- Manual test: full workflow init → spec → design → impl → test
