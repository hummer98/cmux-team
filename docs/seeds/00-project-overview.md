# cmux-team: Project Overview

## What is this?

A Claude Code skill/command package that turns cmux into an AI sub-agent orchestration platform.
The **Conductor** (parent Claude session) spawns, monitors, and collects results from multiple
sub-agent Claude sessions running in cmux split panes — all controlled via cmux CLI.

## Core Concept

```
Human ←→ Conductor (parent Claude)
              ├── cmux send → Agent A (Researcher)
              ├── cmux send → Agent B (Architect)
              ├── cmux send → Agent C (Implementer)
              ├── cmux read-screen → monitor progress
              ├── cmux wait-for → synchronize completion
              └── collect .team/output/* → synthesize results
```

The human gives natural language instructions to the Conductor.
The Conductor translates these into cmux operations, agent prompts, and orchestration logic.

## Target Users

Developers using Claude Code inside cmux who want to parallelize development workflows.

## Key Principles

1. **Transparency** — Sub-agents are visible in cmux panes (not black boxes)
2. **Autonomy** — Sub-agents run with `--dangerously-skip-permissions`
3. **File-based communication** — Results written to `.team/output/`, synced via filesystem
4. **Signal-based coordination** — `cmux wait-for` for completion, `cmux set-status` for progress
5. **Task-driven decisions** — Temporary info (design decisions, research findings) tracked as tasks

## Parallelism Tiers

| Tier | Config | Use Case |
|------|--------|----------|
| Small | 1+3 (4 total) | Research, design review |
| Medium | 1+5 (6 total) | Implementation + review |
| Large | 1+7 (8 total) | Full team: impl + review + test + docs |

## Installation Target

```
~/.claude/
├── skills/
│   ├── cmux-team/SKILL.md
│   └── cmux-agent-role/SKILL.md
└── commands/
    ├── team-init.md
    ├── team-research.md
    ├── team-design.md
    ├── team-impl.md
    ├── team-review.md
    ├── team-test.md
    ├── team-sync-docs.md
    ├── team-task.md
    ├── team-status.md
    └── team-disband.md
```

## Per-Project State (created by /team-init)

```
.team/
├── team.json          # Team state: surfaces, roles, status
├── specs/
│   ├── requirements.md
│   ├── design.md
│   └── tasks.md
├── output/            # Agent deliverables
├── tasks/
│   ├── open/
│   └── closed/
├── prompts/           # Generated prompts for each agent
└── docs-snapshot/     # Last synced state for diff detection
```
