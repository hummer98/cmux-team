![cmux-team](banner.jpeg)

# cmux-team

[![npm version](https://img.shields.io/npm/v/@hummer98/cmux-team.svg)](https://www.npmjs.com/package/@hummer98/cmux-team)
[![npm downloads](https://img.shields.io/npm/dm/@hummer98/cmux-team.svg)](https://www.npmjs.com/package/@hummer98/cmux-team)
[![npm total downloads](https://img.shields.io/npm/dt/@hummer98/cmux-team.svg)](https://www.npmjs.com/package/@hummer98/cmux-team)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Multi-agent development orchestration with Claude Code + cmux.

**[日本語版 README はこちら](README.ja.md)**

## Demo

https://github.com/user-attachments/assets/1d402a69-f48c-4a43-b52d-9c80f0f90ea1

## Why cmux-team?

Claude Code's built-in sub-agents are useful, but **you can't see what they're doing**. You only get the final result — the process is a black box.

This matters more than it might seem. When AI agents work invisibly, two problems compound:

- **Late detection**: You only discover something went wrong after the work is done — wasting compute and time, with no way to intervene mid-course
- **No improvement signal**: Without seeing intermediate behavior, you can't tell *why* a result was good or bad — which makes it hard to improve your prompts, tasks, and agent design

cmux-team is an **AI observatory**, not another automation black box. The terminal panes aren't decoration — they're the product. A 10-second glance at a Conductor pane is often enough to catch a problem that would otherwise only surface at the end.

The design principle: *reduce cognitive load by making the process **visible**, not by hiding it.*

**What you do**: Give Claude instructions in natural language.
**What Claude does**: Splits panes via cmux, launches sub-agents, monitors them, and integrates results — all in plain sight.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- [cmux](https://github.com/manaflow-ai/cmux) installed
- [bun](https://bun.sh/) installed (required for the Manager daemon)
- Running Claude Code inside a cmux session
- [Nerd Font](https://www.nerdfonts.com/) (recommended) — enhances TUI dashboard icons
  ```bash
  brew install --cask font-hack-nerd-font
  ```
  Works without Nerd Font (falls back to Unicode symbols). Set `CMUX_NERD_FONT=0` to use fallback icons explicitly.

## Installation

```bash
npm install -g @hummer98/cmux-team
```

### About auto-update

The daemon **detects** new versions via `update-notifier` and surfaces them in the TUI banner. **Install is always manual** — run `npm i -g @hummer98/cmux-team@<latest>` yourself to avoid surprises across mixed Node environments (Volta / nvm / Homebrew).

Two modes (default: `off`):

| mode | behavior |
|------|----------|
| `off` | do nothing (no registry access) |
| `notify` | detect every 12h and show a TUI banner; no install |

Configuration (precedence: **env > config > default**):

- `CMUX_TEAM_AUTO_UPDATE=off|notify` (also accepts `0|false` as off)
- `.team/config.json`: `{ "autoUpdate": "off" | "notify" }`

Related:
- `NO_UPDATE_NOTIFIER=1` disables detection (standard update-notifier env var)
- Boot log: `auto_update_config mode=<mode> source=<env|config|default>`

**Breaking change (v4.5.0, T294):**
- The `task` mode (auto-creation of update tasks) is removed. `CMUX_TEAM_AUTO_UPDATE=task|1|true` and `.team/config.json: autoUpdate: "task" | true | false` now exit with status 1.
- The `cmux-team self-update` subcommand is removed.
- Migration: set `autoUpdate` to `notify` (or `off`), then run `npm install -g @hummer98/cmux-team@latest` when the banner appears.

### Configuration (`.team/config.json`)

Created per-project by `cmux-team start`. All keys are optional — the file can be edited by hand and is re-read on next start. General precedence: **CLI flag > env var > `.team/config.json` > built-in default**.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `mainBranch` | string | auto-detected from `origin/HEAD` | Primary development branch used as the default worktree base & merge target. Overrides: env `CMUX_TEAM_MAIN_BRANCH`, CLI `--main-branch`, per-task `--base-branch`. |
| `layout` | `"wide"` \| `"16x9"` | `"16x9"` | Pane layout preset at startup. Override: CLI `--layout`. |
| `sleepPrevention` | `"off"` \| `"idle"` \| `"aggressive"` \| boolean | `"aggressive"` | macOS sleep prevention mode. `aggressive` = `caffeinate -dis` (block display + idle + system sleep, default since T256), `idle` = `caffeinate -i` (block user-idle only; allows display sleep), `off` = no caffeinate. Boolean is accepted for backward compatibility (`true` → `aggressive`, `false` → `off`). Override: CLI `--sleep-prevention <mode>` or `--no-sleep-prevention`. |
| `autoUpdate` | `"off"` \| `"notify"` | `"off"` | Version detection mode (see above). Override: env `CMUX_TEAM_AUTO_UPDATE`. |
| `models.master` / `models.conductor` / `models.agent` | string | Claude defaults | Per-role model selection (e.g. `"claude-sonnet-4-6"`). |
| `envrcHookPromptSkipped` | boolean | `false` | Internal flag set when the user declines the direnv hook prompt — normally not edited by hand. |

Example:

```json
{
  "mainBranch": "develop",
  "layout": "16x9",
  "sleepPrevention": "idle",
  "autoUpdate": "notify",
  "models": { "conductor": "claude-sonnet-4-6" }
}
```

See `docs/spec/05-install-and-infrastructure.md` for the full resolution semantics (including `mainBranch` auto-detection and worktree start-point order).

## Usage

### Basic Workflow

Start cmux, launch Claude Code inside it.

```
$ cmux-team start
  → Daemon starts with TUI dashboard
  → Manager / Master panes created, Conductors spawned
  → Switch to Master pane to give tasks

You:    Build a TODO app with React
Claude: Task created.
  → Daemon detects task → assigns to an idle Conductor
  → Conductor spawns Agents as tabs in the same pane
  → Watch each agent working in real time

You:    How's it going?
Claude: (checks manager.log, cmux tree)
        Conductor-1: implementing (2/3 agents done)

You:    Also clean up worktrees
Claude: → cmux-team create-task --title "..." --status ready
       → Daemon assigns it to another idle Conductor in parallel
```

### Commands

#### CLI Commands (run from terminal)

See `cmux-team --help` for the full list. Common commands:

**Lifecycle**
| Command | What it does |
|---------|-------------|
| `cmux-team start` | Start daemon + Master + Conductors (self-heals if layout got lost) |
| `cmux-team status` | Show team status |
| `cmux-team --version` | Show version |

> Note: `cmux-team stop` was removed in v4.3.0. The daemon auto-stops when the cmux session exits (pidfile release). To terminate manually: `kill <pid>` (see `.team/daemon.pid`).

**Task management**
| Command | What it does |
|---------|-------------|
| `cmux-team create-task --title <t> [--status ready] [--body <b>] [--depends-on <ids>] [--base-branch <branch>] [--run-after-all] [--exclusive]` | Create a task (`--base-branch`: worktree start-point & merge target, default: main; `--exclusive`: run alone after drain, implies `--run-after-all`) |
| `cmux-team update-task --task-id <id> --status <s>` | Update task status |
| `cmux-team close-task --task-id <id> --deliverable-kind <files|merged|pr|none> [kind-specific flags] [--journal <text>]` | Close a task |
| `cmux-team abort-task --task-id <id>` | Abort a running task |
| `cmux-team restart-task --task-id <id>` | Restart an assigned Conductor session |
| `cmux-team delete-task --task-id <id>` | Delete a draft/ready task |
| `cmux-team await-task --task-id <id> [--timeout <sec>]` | Wait for task completion |

> **Base branch (`--base-branch`)**: By default each task's worktree is cut from your `mainBranch` (resolved via env `CMUX_TEAM_MAIN_BRANCH` → `config.mainBranch` → `origin/HEAD`), and the Conductor treats it as the merge target. Pass `--base-branch develop` to cut from and merge back to `develop` instead — useful for hotfixes or feature branches that should not target main. Start-point resolution order: explicit `--base-branch` → local `<mainBranch>` ahead of origin → `origin/<mainBranch>` → local `<mainBranch>` → `HEAD` (see `docs/spec/05-install-and-infrastructure.md` for details).

**Agent / Conductor**
| Command | What it does |
|---------|-------------|
| `cmux-team spawn-conductor` | Spawn and register a single Conductor |
| `cmux-team spawn-agent --conductor-surface <s> --role <r> --prompt <p>` | Spawn an Agent tab |
| `cmux-team agents` | List running agents |
| `cmux-team close-agent --surface <s>` | Gracefully stop an Agent |
| `cmux-team kill-agent --surface <s>` | Force-terminate an Agent (crash) |
| `cmux-team send-agent --surface <s> <message>` | Send a message to Agent / Conductor |
| `cmux-team conductor` | Boot Conductor role (proxy auto-resolved) |
| `cmux-team spawn-master` | Boot Master role (proxy auto-resolved) |

**Token Pool**
| Command | What it does |
|---------|-------------|
| `cmux-team token add` | Register a manual API key interactively (paste token) |
| `cmux-team token add --subscription <handle> [--plan max-x20] [--tags any]` | Register a Claude Max / subscription token (no keychain snapshot, Claude Code-managed auth) |
| `cmux-team token list` | List registered tokens with utilization |
| `cmux-team token remove --handle <h>` | Remove a token |
| `cmux-team token rotate --handle <h>` | Re-probe credential and update auth hash |
| `cmux-team token set-plan --handle <h> --plan <p>` | Override plan/ratio manually |
| `cmux-team token promote --handle <h>` | Set `selectable=true` on an auto-discovered token |
| `cmux-team token migrate-subscription` | Delete cmux-team-token keychain entries for subscription rows (idempotent) |
| `cmux-team pool status` | Show pool capacity dashboard |

#### Manual vs subscription tokens

- **`manual`** — A persistent API key. cmux-team stores the token in macOS keychain
  (service `cmux-team-token`) and injects `CLAUDE_CODE_OAUTH_TOKEN` into spawned agents.
- **`--subscription`** — A Claude Max subscription. Claude Code itself manages auth
  via `~/.claude/.credentials.json` and refreshes the token as needed. cmux-team does
  **not** keep a keychain snapshot and does **not** inject the token into agents — it
  lets Claude Code handle authentication and only observes the requests through the
  proxy to track utilization. Use this for any subscription-backed handle.

**Diagnostics**
| Command | What it does |
|---------|-------------|
| `cmux-team trace-task <task-id>` | Show session history for a task |
| `cmux-team trace-hooks` | Show hook signal history |
| `cmux-team artifacts [add\|show\|open\|search]` | Manage knowledge artifacts |
| `cmux-team metrics [--since <range>] [--group-by day]` | Show task lifecycle / tool call / token aggregates (see `docs/spec/11-metrics.md`) |
| `cmux-team metrics snapshot\|compare\|health\|query` | Daily snapshot, cohort comparison, health check, and DuckDB ad-hoc query |
| `cmux-team events [--follow] [--types <names>] [--format json\|tsv]` | Tail / filter the events stream (`.team/logs/events.jsonl`) |

#### Slash Commands (run within Claude)

| Command | What it does | When to use |
|---------|-------------|-------------|
| `/master` | Reload Master role | After `/clear` |
| `/cmux-team:watch` | Watch events stream and auto-handle PR merge / conflict resolve / pull (opt-in) | When you want Master to auto-merge completed PRs and surface escalations |
| `/team-spec [summary]` | Brainstorm requirements | Deciding what to build |
| `/team-task [action]` | Task management | Create / list / close tasks |
| `/team-archive [range]` | Archive closed tasks | Task cleanup |
| `/artifact [type] [title]` | Save findings as artifact | Knowledge capture |
| `/docs-sync [--dry-run\|--auto]` | Sync `docs/spec/` with implementation | Doc maintenance |
| `/trace-task <task-id>` | Analyze a task's session history | Debugging, review |

## Architecture

```
┌─────────────────────────────────────────┐
│  cmux-team daemon (TypeScript/bun)      │
│  ┌───────────────────────────────────┐  │
│  │  TUI Dashboard                    │  │
│  │  Tasks: 2 open | Conductors: 1/3  │  │
│  └───────────────────────────────────┘  │
│  Queue ← Master/Hook write via CLI      │
│  Loop  → Task scan → Conductor spawn    │
│  Monitor → Completion → Result collect   │
└───────────┬────────────┬────────────────┘
            │            │
     [Master]    [Conductor-035]
     Claude Code  Claude Code
     (Opus)       → [Agent] Claude Code
```

### Deterministic Manager

The Manager is **not** a Claude Code session. It's a TypeScript program with a deterministic event loop:

- **HTTP message queue** via the built-in proxy (`cmux-team send <TYPE>`) — event-driven, not polling
- **File-based task state** (`.team/tasks/` + `task-state.json`)
- **zod** schema validation for all messages
- **ink** TUI dashboard
- **Task dependency resolution** via `depends_on` field
- **Priority sorting** (high > medium > low)
- **Agent completion via fs.watch** — Agent's Stop / SessionEnd hook writes a done marker, Conductor awaits it with `cmux-team await-agent` (no busy polling, T181)

### Task Dependencies

```yaml
---
id: 13
title: Consolidated report
status: ready
depends_on: [10, 11, 12]  # waits for all to complete
---
```

### Communication

| Direction | Mechanism |
|-----------|-----------|
| Master → daemon | `cmux-team send <TYPE>` → HTTP message to proxy |
| daemon → Conductor | `cmux send` (`/clear` + new prompt on a persistent Conductor pane) |
| daemon ← Conductor | Done marker file (`.team/conductors/<id>/done`) + SESSION_* hook messages |
| Conductor → Agent | `cmux-team send-agent` / `spawn-agent` (direct `cmux send` is blocked by hook) |
| Conductor ← Agent | `cmux-team await-agent` (fs.watch on Agent done marker) |
| daemon → external readers | events stream (`.team/logs/events.jsonl`, JSONL append-only) — opt-in, consumed by `cmux-team events --follow` and Master `/cmux-team:watch` |

## Project-Specific Agent Instructions

You can give each overlay role (10 in total: researcher / architect / planner / design-reviewer / implementer / inspector / dockeeper / task-manager / **master / conductor**) a project-local overlay by writing `.team/agent-instructions/<role>.md`. The overlay content is injected into the corresponding prompt:

- **Agent roles (8)** — overlay is applied at `cmux-team spawn-agent` time (replaces `{{PROJECT_INSTRUCTIONS}}` in the agent prompt-file).
- **master / conductor (T342)** — overlay is applied as a shared system-prompt overlay at daemon start: `generateMasterPrompt` / `generateConductorRolePrompt` injects it into `.team/prompts/master.md` / `.team/prompts/conductor-role.md`. They cannot be passed to `cmux-team spawn-agent --role` (it returns exit 1 with a "reserved" error).

```bash
# Write an overlay
cmux-team set-agent-instructions --role implementer --from-file ./my-impl-notes.md
cmux-team set-agent-instructions --role researcher --body "Limit search to papers from 2025 onward"
cmux-team set-agent-instructions --role master --body "Always summarise progress in 3 lines"
cmux-team set-agent-instructions --role conductor --from-file ./conductor-overlay.md

# Inspect / list
cmux-team get-agent-instructions --role implementer
cmux-team list-agent-instructions

# Delete (idempotent)
cmux-team delete-agent-instructions --role implementer
```

Max overlay size is 100 KB. The dashboard's `Settings` tab (`4` key) shows a read-only preview of all role overlays plus a config snapshot.

## Token Pool

When you have multiple Claude accounts, cmux-team can automatically distribute Agent spawns across them to avoid rate limits.

**Enable** (opt-in, per-project):

```json
// .team/config.json
{ "tokenPool": { "enabled": true } }
```

Or via env: `CMUX_TEAM_TOKEN_POOL=1`.

**Register tokens** (macOS Keychain required for `manual`; subscription does not use keychain):

```bash
# Manual API key (interactive, stored in keychain)
cmux-team token add

# Claude Max subscription (no keychain, Claude Code-managed auth)
cmux-team token add --subscription @tayo --plan max-x20 --tags any

cmux-team token list     # show all tokens with 5h/7d utilization
```

**Selection algorithm** (per Agent spawn):

1. Exclude handles in `policy.exclude`
2. Skip tokens with active lease (120 s) or `util_5h > 95%`
3. Admit by: `projectDefault` match → `include` list → `isOss` flag → tag match (`"any"`)
4. Score = `0.3 × util_5h + 0.7 × util_7d` — pick the lowest

The TUI dashboard header shows the **7-day forecast sparkline** (Day 0..6 daily allocation, 100% = sustainable pace) and the **next account** the agent spawn will pick:

```
pool 7d  ██▇▅▅▆█   next: @kddi 5h:65%
```

Per-surface decoration (`@handle <5h:X%/7d:Y%> cap:Z%`) is removed in favor of the aggregate header. Run `cmux-team pool status` for per-account detail.

See `docs/spec/09-token-pool.md` for tag filtering, exclude/include policy, and plan ratio details.

## Traceability

All API requests are automatically recorded through the built-in proxy when the daemon is running.

### Inspecting a Task's Sessions

```bash
# Show session history for a specific task (Conductor + Agents)
cmux-team trace-task 035
```

Traces are stored in `.team/traces/traces.db` with request/response bodies in `.team/logs/traces/bodies/`. Metadata headers (`x-cmux-task-id`, `x-cmux-conductor-surface`, `x-cmux-role`) are propagated so every API request can be correlated with its originating task.

## Troubleshooting

### Daemon won't start

**bun not installed**: `brew install oven-sh/bun/bun`

**Not in cmux**: Run inside cmux. `CMUX_SOCKET_PATH` must be set.

### Panes too narrow

Too many panes cause cmux commands to fail. Exit the cmux session (daemon auto-stops) and restart with `CMUX_TEAM_MAX_CONDUCTORS=1` to limit concurrency.

### View Conductor session logs

```bash
grep conductor-xxx .team/logs/manager.log
# → task_completed ... session=abc-123
claude --resume abc-123
```

## Known Limitations

- **API rate limits**: Multiple concurrent agents. Claude Max recommended. Control with `CMUX_TEAM_MAX_CONDUCTORS` (default: 3).
- **Pane width**: Too many panes can break cmux commands.
- **Trust prompts**: New directories trigger trust confirmation. Conductor auto-approves but may need manual intervention.

## Testing

> **⚠️ Do NOT run `bun test` against the whole manager directory.**
> The full-suite invocation suffers O(N²) slowdown and may hang for 30+ minutes
> (see `.team/artifacts/A021-research.md`). Use the per-file loop:
>
> ```bash
> cd skills/cmux-team/manager
> for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do
>   bun test --timeout 30000 "$f" || echo "FAIL: $f"
> done
> ```
>
> CI (`.github/workflows/test.yml`) runs the same per-file loop on every PR
> and on `push` to `main`. The aggregate-mode invocation will be restored once
> the root cause (module-level singleton accumulation) is fixed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for testing, repository structure, and coding conventions.

## License

MIT License — see [LICENSE](LICENSE) for details.
