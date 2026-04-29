/**
 * i18n — 国際化サポート
 *
 * 言語検出優先順位: CMUX_TEAM_LANG > LC_ALL > LC_MESSAGES > LANG
 * デフォルト: 英語 (en)
 */

export type Locale = "ja" | "en";

function detectLocale(): Locale {
  const envVars = [
    process.env.CMUX_TEAM_LANG,
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
  ];
  for (const v of envVars) {
    if (v?.startsWith("ja")) return "ja";
  }
  return "en";
}

export const locale: Locale = detectLocale();

// --- メッセージ定義 ---

const en = {
  // ── T247: project-local agent instructions overlay ─────────────────────────
  /** `{{PROJECT_INSTRUCTIONS}}` 展開時に overlay 本文の先頭に付ける見出し文字列 */
  project_instructions_heading: "Project-Specific Instructions",

  // ── エラー・ステータスメッセージ ──────────────────────────────────────────────
  not_in_cmux:
    "❌ Not running in a cmux session. Please run this command inside cmux.",
  daemon_not_running:
    "Error: daemon is not running (proxy-port file not found)",
  team_not_started_start: "Team not started. Run `start` to initialize.",
  team_not_started: "Team not started.",
  no_running_agents: "No running agents.",
  no_artifacts: "No artifacts found.",
  artifact_id_required:
    "Error: artifact ID is required\nUsage: cmux-team artifacts show <id>",
  artifact_id_required_open:
    "Error: artifact ID is required\nUsage: cmux-team artifacts open <id>",
  search_query_required:
    "Error: search query is required\nUsage: cmux-team artifacts search <query>",
  artifact_add_file_required:
    "Error: file path is required\nUsage: cmux-team artifacts add <file> [--type <type>] [--title <title>] [--task <id>] [--tags <tag1,tag2>]",
  dashboard_startup_hint:
    "Hint: Run 'cmux-team start' in a TTY environment",
  task_section_header: "Task",

  // ── テンプレートメッセージ（tf() で変数展開） ────────────────────────────────
  artifact_not_found: "Artifact {id} not found",
  no_artifacts_matching: 'No artifacts matching "{query}"',
  artifact_add_file_not_found: "Error: file not found: {path}",
  artifact_added: "Added {id} → {path}",
  dashboard_startup_failed: "❌ Dashboard startup failed: {message}",
  abort_journal_default: "Aborted: T{id} {title}",
  restart_journal_default: "Restarted: T{id} {title}",
  delete_journal_default: "Deleted: T{id} {title}",

  // ── テンプレートエラーメッセージ ──────────────────────────────────────────────
  template_dir_not_found:
    "Template directory not found. Please run: npm install -g @hummer98/cmux-team",
  conductor_role_template_not_found:
    "Conductor role template not found. Please run: npm install -g @hummer98/cmux-team",
  conductor_task_template_not_found:
    "Conductor task template not found. Please run: npm install -g @hummer98/cmux-team",

  // ── e2e.ts ────────────────────────────────────────────────────────────────────
  e2e_daemon_not_confirmed:
    "  WARNING: daemon startup not confirmed. Continuing tests.",
  e2e_master_not_found:
    "  WARNING: Master surface not found (Master spawn may have failed)",
  e2e_team_json_failed: "  WARNING: team.json read failed: {message}",
  e2e_scenario1_title: "  Running 3 tasks with chained dependencies:",
  e2e_scenario1_tasks: "  Task 1 (research) → Task 2 (design) → Task 3 (impl)\n",

  // ── ヘルプテキスト ────────────────────────────────────────────────────────────
  help_start: `
cmux-team start -- launch daemon + spawn Master + show dashboard

Usage:
  cmux-team start [--layout=<wide|16x9>] [--no-sleep-prevention]

Options:
  --layout <wide|16x9>     layout mode (default: 16x9, or config.json layout)
                           - 16x9: top full-width + bottom split, 2 Conductors (default)
                           - wide: 2x2 layout, 3 Conductors
  --no-sleep-prevention    disable macOS sleep prevention (caffeinate -dis)
                           also configurable via .team/config.json "sleepPrevention": false

Notes:
  - Must be run inside a cmux session (CMUX_SOCKET_PATH is required)
  - Starts daemon + logging proxy + layout panes + Master
  - Priority: --layout > .team/config.json "layout" > "16x9"
  - CMUX_TEAM_MAX_CONDUCTORS env var overrides layout-derived max
    (16x9 still creates only 2 panes; extra conductors are clamped)
  - Dashboard is displayed with keyboard shortcuts for interaction
  - Sleep prevention: on macOS, caffeinate -dis is used while any agent is active
    (prevents display sleep, idle system sleep, and AC-powered system sleep).
    Priority: --no-sleep-prevention > .team/config.json "sleepPrevention" > true
`,

  help_send: `
cmux-team send -- send a message to the queue

Usage:
  cmux-team send <type> [options]

Types and required/optional options:
  TASK_CREATED
    --task-id <id>          task ID (required)
    --task-file <path>      task file path (required)

  TASK_UPDATED
    --task-id <id>          task ID (required)
    --task-file <path>      task file path (required)

  CONDUCTOR_DONE
    --surface <surface>     Conductor surface ID (required)
    --success <bool>        success/failure (optional, default true)
    --reason <text>         reason (optional)
    --exit-code <number>    exit code (optional)
    --session-id <id>       session ID (optional)
    --transcript-path <p>   transcript path (optional)

  CONDUCTOR_REGISTERED
    --surface <surface>     Conductor surface ID (required)

  AGENT_SPAWNED
    --conductor-surface <s> Conductor surface ID (required)
    --surface <surface>     Agent surface ID (required)
    --role <role>           role name (optional)
    --task-title <title>    task title (optional)

  SESSION_STARTED
    --surface <surface>     surface ID (required)
    --pid <number>          process ID (required)
    --session-id <id>       session ID (optional)

  SESSION_ENDED
    --surface <surface>     surface ID (required)
    --pid <number>          process ID (optional)
    --reason <text>         reason (optional)

  SESSION_ACTIVE
    --surface <surface>     surface ID (required)
    --pid <number>          process ID (optional)

  SESSION_IDLE
    --surface <surface>     surface ID (required)
    --pid <number>          process ID (optional)

  SESSION_CLEAR
    --surface <surface>     surface ID (required)
    --pid <number>          process ID (optional)

  SHUTDOWN
    (no options)

Examples:
  cmux-team send TASK_CREATED --task-id 035 --task-file .team/tasks/035-example.md
  cmux-team send SHUTDOWN
  cmux-team send CONDUCTOR_DONE --surface surface:210 --success true
`,

  help_status: `
cmux-team status -- show team status

Usage:
  cmux-team status [options]

Options:
  --log <N>     number of log lines to show (optional, default 10)

Examples:
  cmux-team status
  cmux-team status --log 20

Token Pool (T323):
  When token pool is enabled (CMUX_TEAM_TOKEN_POOL=1 / config / global yaml),
  the status output prepends a token pool header (capacity / next reset) and
  appends per-surface handle / utilization / cap_pct columns. When disabled,
  the layout is identical to the legacy output.
  See: cmux-team pool status   for the full per-token dashboard.
`,

  help_spawn_conductor: `
cmux-team spawn-conductor -- launch and register a Conductor on the current surface

Usage:
  cmux-team spawn-conductor

The Conductor is started on the current surface ($CMUX_SURFACE or caller surface).
`,

  help_spawn_agent: `
cmux-team spawn-agent -- launch a sub-agent

Usage:
  cmux-team spawn-agent --conductor-surface <surface> --role <role> (--prompt <text> | --prompt-file <path>) [options]

Options:
  --conductor-surface <surface>   Conductor surface ID (required)
  --role <role>                   agent role name (required)
  --prompt <text>                 inline prompt (mutually exclusive with --prompt-file, one required)
  --prompt-file <path>            prompt file path (mutually exclusive with --prompt, one required)
  --task-title <title>            task title (optional, used for tab name)
  --model <model>                 model to use (default: config.models.agent or "{model}")

Examples:
  cmux-team spawn-agent --conductor-surface surface:210 --role researcher --prompt "Research the API endpoints"
  cmux-team spawn-agent --conductor-surface surface:210 --role implementer --prompt-file .team/prompts/task.md

Notes:
  - Creates an Agent as a tab within the Conductor pane
  - Falls back to new-split right if tab creation fails
  - AGENT_SPAWNED message is automatically sent to the queue
`,

  help_agents: `
cmux-team agents -- list running agents

Usage:
  cmux-team agents

Options:
  (none)
`,

  help_kill_agent: `
cmux-team kill-agent -- stop an agent

Usage:
  cmux-team kill-agent --surface <surface>

Options:
  --surface <surface>     surface ID of the Agent to stop (required)

Examples:
  cmux-team kill-agent --surface surface:215
`,

  help_close_agent: `
cmux-team close-agent -- close an agent (normal exit)

Usage:
  cmux-team close-agent --surface <surface>

Options:
  --surface <surface>     surface ID of the Agent to close (required)

Notes:
  - Use this when the Agent finished normally (e.g. approved by inspector).
  - Unlike kill-agent, this records status=completed in the agent done marker.
  - For crash/abort, prefer kill-agent which records status=crashed.

Examples:
  cmux-team close-agent --surface surface:215
`,

  help_send_agent: `
cmux-team send-agent -- send a message to an Agent spawned by this Conductor

Usage:
  cmux-team send-agent --surface <agent-surface> [--no-return] <message>

Options:
  --surface <agent-surface>   target Agent surface (required)
  --no-return                 skip sending Enter after the message
  <message>                   message body (quoted)

Environment:
  CMUX_SURFACE                caller Conductor surface (falls back to cmux identify)

Examples:
  cmux-team send-agent --surface surface:382 "Please resume from plan.md section 3"
  cmux-team send-agent --surface surface:382 --no-return "partial line"

Notes:
  - Only Agents spawned by the caller Conductor are allowed (verified via .team/team.json)
  - Self-send (caller == target) and other Conductors' Agents are rejected
  - Retries up to 5 × 200ms when the Agent is not yet registered in team.json
`,

  help_create_task: `
cmux-team create-task -- create a task

Usage:
  cmux-team create-task --title <title> [options]

Options:
  --title <title>         task title (required)
  --body <text>           task body (optional)
  --priority <priority>   priority: high / medium / low (optional, default medium)
  --status <status>       initial status: draft / ready (optional, default draft)
  --depends-on <ids>      dependency task IDs (comma-separated, e.g. "081,082") (optional)
  --base-branch <branch>  merge target branch (optional, default: none → merges to main)
  --run-after-all         run after all regular tasks complete (optional)
  --exclusive             run exclusively: after drain, block all other assignments
                          until this task is closed (implies --run-after-all)
  --force                 bypass the ready sync-state check (use with caution)
  --skip-fetch            skip 'git fetch' before the ready sync-state check
  --no-auto-pull          on behind-ff while on <mainBranch>, skip the auto
                          'git pull --ff-only' and warn instead

Examples:
  cmux-team create-task --title "Fix bug" --status ready --body "Login screen error"
  cmux-team create-task --title "Add feature" --priority high
  cmux-team create-task --title "Refactor" --depends-on "081,082" --status ready
  cmux-team create-task --title "hotfix" --base-branch develop --status ready
  cmux-team create-task --title "Release v3.5.0" --run-after-all --status ready
  cmux-team create-task --title "Release v3.53.0" --exclusive --status ready

Notes:
  - If status is ready, a TASK_CREATED message is automatically sent
    and the daemon assigns it to an idle Conductor
  - If draft, it will not be assigned. Use update-task --status ready to start
  - Only one --run-after-all task may exist at a time (error if one already exists unclosed)
  - The run_after_all task runs automatically after all regular tasks are closed
  - --exclusive implies --run-after-all (drain) and additionally blocks all other
    task assignments while this task is running (resumes after it closes)
  - Multiple --exclusive tasks may coexist; they run sequentially in ID order.
    A non-exclusive --run-after-all cannot coexist with any unclosed --exclusive
    task (create-task errors with RUN_AFTER_ALL_CONFLICT in either direction)
  - When status is ready, cmux-team verifies local <mainBranch> vs origin/<mainBranch>
    and rejects create on diverged / uncommitted / detached states. Bypass with
    --force or CMUX_TEAM_SKIP_SYNC_CHECK=1
  - On behind-ff while <mainBranch> is checked out, cmux-team auto-runs
    'git pull --ff-only origin <mainBranch>' and rejects create if it fails.
    Use --no-auto-pull to skip the auto-pull (warn-only). On other branches /
    detached, behind-ff is already warn-only.
`,

  help_update_task: `
cmux-team update-task -- update a task

Usage:
  cmux-team update-task --task-id <id> [options]

Options:
  --task-id <id>          task ID (required)
  --status <status>       new status (optional)
  --title <title>         new title (optional)
  --body <text>           new body (optional)
  --depends-on <ids>      dependency task IDs (comma-separated, e.g. "081,082") (optional)
  --force                 bypass the ready sync-state check (use with caution)
  --skip-fetch            skip 'git fetch' before the ready sync-state check
  --no-auto-pull          on behind-ff while on <mainBranch>, skip the auto
                          'git pull --ff-only' and warn instead

  * At least one of --status, --title, --body, or --depends-on is required

Examples:
  cmux-team update-task --task-id 035 --status ready
  cmux-team update-task --task-id 035 --title "New title" --body "New description"
  cmux-team update-task --task-id 035 --depends-on "081,082"

Notes:
  - Tasks in assigned (running) state cannot be updated
  - Closed tasks cannot be updated (create a new task instead)
  - Changing status to ready automatically sends a TASK_CREATED message
  - When transitioning to ready, cmux-team verifies local <mainBranch> vs
    origin/<mainBranch> and rejects on diverged / uncommitted / detached. Bypass
    with --force or CMUX_TEAM_SKIP_SYNC_CHECK=1
  - On behind-ff while <mainBranch> is checked out, cmux-team auto-runs
    'git pull --ff-only origin <mainBranch>' and rejects update if it fails.
    Use --no-auto-pull to skip the auto-pull (warn-only).
`,

  help_close_task: `
cmux-team close-task -- mark a task as complete (closed)

Usage:
  cmux-team close-task --task-id <id> --deliverable-kind <kind> [kind-specific flags] [--journal <text>] [--force]

Options:
  --task-id <id>                  task ID (required)
  --deliverable-kind <kind>       deliverable kind (required, one of: files, merged, pr, none)
  --deliverable <path>            file path (repeatable; required when kind=files)
  --merged-into <branch>          merge target branch name (required when kind=merged)
  --merge-sha <sha>               merge commit SHA (required when kind=merged)
  --pr-url <url>                  pull request URL (required when kind=pr)
  --journal <text>                completion journal (optional, recorded on success)
  --force                         force-close a running (assigned) task

Examples:
  # local ff-only merge (the most common case)
  cmux-team close-task --task-id 035 --deliverable-kind merged \\
    --merged-into task-035/task --merge-sha $(git rev-parse task-035/task) \\
    --journal "Implementation complete, tests passed"

  # GitHub PR
  cmux-team close-task --task-id 036 --deliverable-kind pr \\
    --pr-url https://github.com/owner/repo/pull/42 --journal "PR opened"

  # investigation / docs-only delivery (no branch produced)
  cmux-team close-task --task-id 037 --deliverable-kind files \\
    --deliverable .team/artifacts/A042.md --deliverable docs/spec/01-x.md \\
    --journal "Research summary delivered"

  # no deliverable (e.g. spec turned out already satisfied)
  cmux-team close-task --task-id 038 --deliverable-kind none --journal "Already satisfied by T294"

Notes:
  - --deliverable-kind is mandatory; running without it exits 1
  - kind-specific flags are mutually exclusive across kinds (e.g. --pr-url is rejected for kind=merged)
  - Assigned (running) tasks require --force to close regardless of kind
  - Legacy closed rows (before T295) load with deliverable=undefined for read-back compatibility;
    only the creation path is a breaking change
`,

  help_abort_task: `
cmux-team abort-task -- abort a running task (sets to aborted)

Usage:
  cmux-team abort-task --task-id <id> [--journal <text>]

Options:
  --task-id <id>          task ID (required)
  --journal <text>        abort journal (optional, default: "Aborted: T{id} {title}")

Examples:
  cmux-team abort-task --task-id 035
  cmux-team abort-task --task-id 035 --journal "Aborted due to direction change"

Notes:
  - Only tasks in assigned (running) state can be aborted
  - Stops the Conductor's sub-agents and the Conductor itself
  - Removes the worktree and changes task status to aborted
  - Conductor automatically restarts to idle state
`,

  help_restart_task: `
cmux-team restart-task -- restart an assigned or aborted task (re-queues as ready)

Usage:
  cmux-team restart-task --task-id <id> [--journal <text>]

Options:
  --task-id <id>          task ID (required)
  --journal <text>        restart journal (optional, default: "Restarted: T{id} {title}")

Examples:
  cmux-team restart-task --task-id 035                                    # works for both assigned and aborted
  cmux-team restart-task --task-id 035 --journal "Conductor crashed, retrying"

Notes:
  - Only tasks in assigned or aborted state can be restarted
  - For assigned: performs the same cleanup as abort-task (stops agents, removes worktree)
  - For aborted: removes residual worktree/branch left over from the abort
  - Sets status back to ready instead of aborted
  - Sends TASK_CREATED notification for automatic re-assignment
`,

  help_clear_conductor: `
cmux-team clear-conductor -- explicitly reset a broken Conductor (broken -> idle)

Usage:
  cmux-team clear-conductor --surface <id>

Options:
  --surface <id>   surface ID (e.g. 112 or surface:112)

Examples:
  cmux-team clear-conductor --surface 112
  cmux-team clear-conductor --surface surface:112

Notes:
  - Only Conductors currently in broken state can be cleared
  - For other states, use abort-task / restart-task
  - Worktree / branch residue is already cleaned up at the broken transition; this CLI only resets the status
`,

  help_delete_task: `
cmux-team delete-task -- delete a task (sets to deleted)

Usage:
  cmux-team delete-task --task-id <id> [options]

Options:
  --task-id <id>          task ID (required)
  --journal <text>        deletion journal (optional, default: "Deleted: T{id} {title}")
  --force                 force-delete a closed or aborted task (assigned still requires abort-task)

Examples:
  cmux-team delete-task --task-id 035
  cmux-team delete-task --task-id 035 --journal "No longer needed"
  cmux-team delete-task --task-id 035 --force                 # delete a closed/aborted task

Notes:
  - draft / ready tasks can be deleted without --force
  - closed / aborted tasks require --force (assigned must use abort-task first)
  - assigned tasks cannot be deleted with --force; use abort-task / restart-task
  - deleted tasks are terminal; re-deletion is a no-op (rejected with exit 1)
  - Sets status to deleted in task-state.json
  - A record remains in the journal
`,

  help_trace_task: `
cmux-team trace-task -- display session history for a task

Usage:
  cmux-team trace-task <task-id> [options]

Options:
  --no-metrics           hide the Token Usage / By role / By model metrics section
  --summary              show summary mode (stub for future)

Examples:
  cmux-team trace-task 141
  cmux-team trace-task 141 --no-metrics
  cmux-team trace-task 141 --summary

Output includes:
  - Base: base branch / SHA / source (when available)
  - Deliverable: recorded at close-task time (kind + details), or "-" for legacy rows
  - Token Usage: totals (requests / input / output / cache create / cache read / cache hit rate / duration)
  - By role / By model: token usage breakdown (tasks predating T305 show a single fallback line)
`,

  help_trace_hooks: `
cmux-team trace-hooks -- display hook signal history received by the daemon

Usage:
  cmux-team trace-hooks [options]

Options:
  --type <TYPE>          filter by hook type (e.g. SESSION_STARTED, SESSION_ENDED,
                         SESSION_IDLE, SESSION_CLEAR, AGENT_SPAWNED, SESSION_ASK,
                         CONDUCTOR_DONE, NOTIFICATION)
  --surface <surface>    filter by surface (accepts "surface:665", "665", "C[665]")
  --task-run <id>        filter by task_run_id (e.g. "task-217-1776294106")
  --role <ROLE>          filter by NOTIFICATION role column (master/conductor/agent/unknown)
  --task-id <id>         filter by NOTIFICATION task_id column (e.g. "265")
  --limit <N>            max rows to display (default: 50, newest first)
  --json                 emit JSON array instead of tabular output

Examples:
  cmux-team trace-hooks
  cmux-team trace-hooks --type SESSION_ENDED --limit 20
  cmux-team trace-hooks --surface C[665]
  cmux-team trace-hooks --task-run task-217-1776294106 --json
  cmux-team trace-hooks --type NOTIFICATION --role agent
  cmux-team trace-hooks --type NOTIFICATION --task-id 265

Notes:
  - Reads from .team/traces/traces.db (hook_signals table)
  - Rows are ordered by id DESC (newest first)
  - DETAIL column shows non-null source/reason/task_run_id/question
  - For NOTIFICATION rows, DETAIL shows role/task_id/agent_role/ntype/message
  - question/message is truncated to 60 chars; use --json to see full payload
`,

  help_conductor: `
cmux-team conductor -- launch Claude Code for Conductor (internal use)

Usage:
  cmux-team conductor [--model <model>]

Environment:
  CMUX_SURFACE  Conductor surface ID (optional; falls back to cmux identify caller.surface_ref)

Options:
  --model <model>   model to use (default: config.models.conductor or "{model}")

Notes:
  - Normally called by daemon at startup, but can be invoked manually
    from a cmux pane for debugging (CMUX_SURFACE will be auto-detected)
  - Dynamically resolves logging proxy port and exec's Claude Code
  - Launched with --dangerously-skip-permissions
`,

  help_spawn_master: `
cmux-team spawn-master -- launch Claude Code for Master (self-register)

Usage:
  cmux-team spawn-master [--model <model>]

Options:
  --model <model>   model to use (default: config.models.master or "{model}")

Notes:
  - Registers itself with daemon via MASTER_REGISTERED before launching Claude Code
  - Fails with exit 1 if daemon is not running (.team/proxy-port unreachable)
  - Can be invoked from any pane to add a new Master to the running daemon
  - Dynamically resolves logging proxy port and exec's Claude Code
  - Generates Master prompt then launches with --dangerously-skip-permissions
`,

  help_artifacts: `
cmux-team artifacts -- manage artifacts (add moves the file, not copy)

Usage:
  cmux-team artifacts [subcommand] [options]

Subcommands:
  (none)                  list artifacts (default)
  add <file>             move a file into .team/artifacts/ (source is removed on success)
  show <id>              show artifact content
  open <id>              open artifact in markdown viewer
  search <query>         full-text search artifacts

Options:
  --type <type>           filter by type: research / decision / session / spec / report (optional)
  --task <id>             filter by related task ID (optional)
  --sort <field>          sort by: created / updated (optional, default created)
  --validate              validate frontmatter of all artifacts
  --type <type>           (add) artifact type: research / decision / session / spec / report
  --title <title>         (add) artifact title
  --task <id>             (add) related task ID
  --tags <tag1,tag2>      (add) comma-separated tags
  --project-root <path>   (add) override project root (destination .team/artifacts/ lives under this)

Examples:
  cmux-team artifacts
  cmux-team artifacts add ./research-notes.md
  cmux-team artifacts add ./design.md --type decision --title "Auth method selection"
  cmux-team artifacts show A001
  cmux-team artifacts open A001
  cmux-team artifacts search "authentication"
  cmux-team artifacts --type research --task T038
  cmux-team artifacts --validate
`,

  help_await_task: `
cmux-team await-task -- wait for a task to complete (closed/aborted)

Usage:
  cmux-team await-task --task-id <id> [options]

Options:
  --task-id <id>          task ID (required, comma-separated for multiple: 108,109)
  --timeout <seconds>     timeout in seconds (default: 3600)

On completion:
  - closed: prints summary.md to stdout, exits 0
  - aborted: prints abort reason to stderr, exits 1
  - timeout: prints timeout message to stderr, exits 2

Examples:
  cmux-team await-task --task-id 108
  cmux-team await-task --task-id 108,109 --timeout 7200
`,

  help_get_agent_instructions: `
cmux-team get-agent-instructions -- print the project-local overlay for an overlay role

Usage:
  cmux-team get-agent-instructions --role <role>

Options:
  --role <role>           overlay role: 8 agent roles + master + conductor (required)
                          aliases: impl → implementer, reviewer → design-reviewer

Notes:
  - Reads .team/agent-instructions/<role>.md under PROJECT_ROOT
  - Prints the file content to stdout (trailing newline preserved)
  - If the overlay file does not exist, prints nothing and exits 0
  - Unknown role → exit 1 with error on stderr
  - master / conductor overlays are applied to .team/prompts/master.md and
    .team/prompts/conductor-role.md by generateMasterPrompt /
    generateConductorRolePrompt at daemon start (T342)
`,

  help_set_agent_instructions: `
cmux-team set-agent-instructions -- write the project-local overlay for an overlay role

Usage:
  cmux-team set-agent-instructions --role <role> (--body <text> | --from-file <path> | --from-stdin)

Options:
  --role <role>           overlay role: 8 agent roles + master + conductor (required)
  --body <text>           overlay body as inline text (mutually exclusive with --from-file/--from-stdin)
  --from-file <path>      read overlay body from a file (mutually exclusive)
  --from-stdin            read overlay body from stdin (mutually exclusive)

Notes:
  - Creates .team/agent-instructions/ if missing
  - Overlay body cannot exceed 100 KB (exits 1 otherwise)
  - Unknown role → exit 1 (strict; overlay writer is a user entry point)
  - Prints "OK role=<role> bytes=<n>" to stdout on success
`,

  help_delete_agent_instructions: `
cmux-team delete-agent-instructions -- remove the project-local overlay for an overlay role

Usage:
  cmux-team delete-agent-instructions --role <role>

Notes:
  - Overlay role: 8 agent roles + master + conductor
  - Prints "DELETED=true" if the file was removed, "DELETED=false" if it did not exist
  - Exits 0 in both cases (deletion is idempotent)
  - Unknown role → exit 1 with error on stderr
`,

  help_list_agent_instructions: `
cmux-team list-agent-instructions -- list all overlay roles with their overlay status

Usage:
  cmux-team list-agent-instructions

Notes:
  - Prints one line per role in OVERLAY_ROLES order (8 agent roles, then master, then conductor)
  - "<role> ✓ <n> bytes" if the overlay exists, "<role> ✗" otherwise
`,

  help_main: `cmux-team — multi-agent development orchestration

Usage:
  cmux-team --version                          show version
  cmux-team start                              launch daemon + spawn Master
  cmux-team send TASK_CREATED --task-id <id> --task-file <path>
  cmux-team send SHUTDOWN
  cmux-team status                             show status
  cmux-team spawn-conductor
  cmux-team spawn-agent --conductor-surface <surface> --role <role> --prompt <prompt>
                                              (agent roles only — master/conductor reserved for system prompt overlay)
  cmux-team agents                             list running agents
  cmux-team close-agent --surface <surface>    close an agent (normal exit)
  cmux-team kill-agent --surface <surface>     kill an agent (crash/force)
  cmux-team send-agent --surface <surface> <message>    send a message to a spawned Agent
  cmux-team create-task --title <title> [--priority <p>] [--status <s>] [--body <text>] [--depends-on <ids>] [--run-after-all] [--exclusive]
  cmux-team update-task --task-id <id> --status <status>
  cmux-team close-task --task-id <id> [--journal <text>]
  cmux-team await-task --task-id <id> [--timeout <sec>]    wait for task completion
  cmux-team abort-task --task-id <id> [--journal <text>]  abort a running task
  cmux-team restart-task --task-id <id> [--journal <text>] restart an assigned or aborted task
  cmux-team delete-task --task-id <id> [--journal <text>] delete a task
  cmux-team trace-task <task-id>              display session history for a task
  cmux-team trace-hooks                        display hook signal history
  cmux-team conductor                          launch Conductor (auto-resolves proxy)
  cmux-team spawn-master                       launch Master (auto-resolves proxy)
  cmux-team artifacts                              list artifacts
  cmux-team artifacts add <file>                   move a file into .team/artifacts/
  cmux-team artifacts show <id>                    show artifact
  cmux-team artifacts open <id>                    open in markdown viewer
  cmux-team artifacts search <query>               full-text search
  cmux-team artifacts --validate                   validate frontmatter
  cmux-team get-agent-instructions --role <role>   print project-local overlay (agent roles + master/conductor)
  cmux-team set-agent-instructions --role <role> (--body <t> | --from-file <p> | --from-stdin)  write overlay
  cmux-team delete-agent-instructions --role <role> remove overlay
  cmux-team list-agent-instructions                 list overlay status per role (10 roles)
  cmux-team pool status                            show token pool dashboard (T323)

For details on each command: cmux-team <command> --help`,

  // ── gh-cache (T272) ───────────────────────────────────────────────────────
  gh_not_a_github_repo:
    "Error: not a git repository, or origin is not GitHub / GHE.\n" +
    "  cmux-team issue/pr requires a git repo with an origin on github.com or an enterprise instance.",
  gh_auth_missing:
    "Error: No GitHub token found for host {host}.\n" +
    "  checked: {checked}\n" +
    "Run one of:\n" +
    "  gh auth login\n" +
    "  export GITHUB_TOKEN=<your token>",
  gh_rate_limit_exhausted:
    "Error: GitHub rate limit exhausted. remaining={remaining} reset_at={reset_at}\n" +
    "  Try `cmux-team issue list --stale-ok` to read from cache without syncing.",
  gh_me_not_resolved:
    "Error: @me cannot be resolved. Run `cmux-team gh sync` first so the cache knows your viewer login.",
  gh_unknown_subcommand:
    "Unknown subcommand: {sub}. Run `cmux-team gh --help`.",
  gh_cache_not_initialized:
    "Error: gh-cache.db is empty. Run `cmux-team gh sync --full` first.",
  gh_stale_warning:
    "Warning: last full sync was {days} days ago. Consider `cmux-team gh sync --full`.",
  gh_issue_empty: "(no issues / PRs matched)",
  gh_sync_success:
    "Synced {mode}: issues={issues} comments={comments} reviews={reviews} duration={duration_ms}ms",
  gh_sync_not_modified: "Not modified (304). last_sync={last_sync}",
  gh_status_header: "GitHub cache status",
  gh_status_last_full: "Last full sync:        {when}",
  gh_status_last_incremental: "Last incremental sync: {when}",
  gh_status_host: "host:                  {host}",
  gh_status_repo: "repo:                  {owner}/{repo}",
  gh_status_viewer: "viewer:                {viewer}",
  gh_status_issue_counts:
    "issue:                 {total} (open={open}, closed={closed})",
  gh_status_pr_counts:
    "PR:                    {total} (open={open}, closed={closed}, merged={merged})",
  gh_status_comments: "comments:              {count}",
  gh_status_rate: "rate limit:            {remaining} / {limit} (reset {reset})",
  gh_status_token: "token hash:            {hash}",
  gh_status_never_synced: "(never)",
  gh_tui_tab_title: "Issues",
  gh_tui_help_line:
    "[R] sync  [Enter/O] open in viewer  [B] open in browser",
  gh_tui_syncing: "Syncing...",
  gh_tui_disabled_non_git:
    "Issues tab disabled (not a git repo or origin not GitHub).",
  gh_tui_disabled_no_auth:
    "Issues tab needs authentication: run `gh auth login` or set GITHUB_TOKEN.",
  gh_help: `cmux-team gh — GitHub issue/PR cache management

Usage:
  cmux-team gh sync [--full]          sync issues/PRs into .team/gh-cache.db
  cmux-team gh status                 show cache status + rate limit

Flags:
  --full    fetch the last 500 issues/PRs (plus attachments) from scratch
            (use on first run, after token rotation, or once a month)

Without --full, sync uses If-None-Match + since= to fetch only changes.
Non-git directories / non-GitHub origins exit 2. Missing auth exits 3.
Rate-limit exhaustion exits 4.`,

  // ── T307: dashboard Metrics タブ ──────────────────────────────────────────────
  metrics_tab_title: "Metrics",
  // T354: 旧 "Rate limit (per-minute)" を Rate Limit Projection に置き換え
  metrics_section_rate_limit_projection: "Rate Limit Projection",
  metrics_section_pool_tokens: "Pool Tokens (selectable: {count})",
  metrics_long_term: "long-term",
  metrics_recent_15m: "recent 15m",
  metrics_before_reset: "before reset",
  metrics_pool_no_selectable: "(no selectable tokens)",
  metrics_pool_no_data: "no data",
  metrics_section_role: "By role (last 1h)",
  metrics_section_task: "By task (last 1h, top {limit})",
  metrics_label_risk: "RISK",
  metrics_label_no_data: "no data",
  metrics_label_idle: "idle",
  metrics_empty_role: "(no api_usage rows in window)",
  metrics_empty_task: "(no tasks in window)",
  metrics_loading: "loading metrics…",
  metrics_caption_from: "from: {role}/{surface} ({age}s ago)",
  metrics_proxy_idle: "proxy idle? last seen {age}s ago",
  metrics_header_role: "role",
  metrics_header_task: "task",
  metrics_header_requests: "reqs",
  metrics_header_input: "input",
  metrics_header_output: "output",
  metrics_header_cache: "cache",
};

const ja: typeof en = {
  // ── T247: project-local agent instructions overlay ─────────────────────────
  project_instructions_heading: "プロジェクト固有の追加指示",

  // ── エラー・ステータスメッセージ ──────────────────────────────────────────────
  not_in_cmux: "❌ cmux 環境外です。cmux 内で実行してください。",
  daemon_not_running:
    "Error: daemon が起動していません（proxy-port が見つかりません）",
  team_not_started_start: "チーム未起動。`start` で起動してください。",
  team_not_started: "チーム未起動。",
  no_running_agents: "稼働中のエージェントはありません。",
  no_artifacts: "アーティファクトが見つかりません",
  artifact_id_required:
    "Error: アーティファクト ID を指定してください\nUsage: cmux-team artifacts show <id>",
  artifact_id_required_open:
    "Error: アーティファクト ID を指定してください\nUsage: cmux-team artifacts open <id>",
  search_query_required:
    "Error: 検索クエリを指定してください\nUsage: cmux-team artifacts search <query>",
  artifact_add_file_required:
    "Error: ファイルパスを指定してください\nUsage: cmux-team artifacts add <file> [--type <type>] [--title <title>] [--task <id>] [--tags <tag1,tag2>]",
  dashboard_startup_hint:
    "ヒント: TTY 環境で cmux-team start を実行してください",
  task_section_header: "タスク",

  // ── テンプレートメッセージ ────────────────────────────────────────────────────
  artifact_not_found: "アーティファクト {id} が見つかりません",
  no_artifacts_matching: '"{query}" に一致するアーティファクトが見つかりません',
  artifact_add_file_not_found: "Error: ファイルが見つかりません: {path}",
  artifact_added: "追加しました {id} → {path}",
  dashboard_startup_failed: "❌ ダッシュボード起動失敗: {message}",
  abort_journal_default: "中断: T{id} {title}",
  restart_journal_default: "再実行: T{id} {title}",
  delete_journal_default: "削除: T{id} {title}",

  // ── テンプレートエラーメッセージ ──────────────────────────────────────────────
  template_dir_not_found:
    "Template directory not found. npm install -g @hummer98/cmux-team を実行してください",
  conductor_role_template_not_found:
    "Conductor role template not found. npm install -g @hummer98/cmux-team を実行してください",
  conductor_task_template_not_found:
    "Conductor task template not found. npm install -g @hummer98/cmux-team を実行してください",

  // ── e2e.ts ────────────────────────────────────────────────────────────────────
  e2e_daemon_not_confirmed: "  WARNING: daemon 起動未確認。テストを続行します。",
  e2e_master_not_found:
    "  WARNING: Master surface が見つかりません（Master spawn に失敗した可能性）",
  e2e_team_json_failed: "  WARNING: team.json 読み取り失敗: {message}",
  e2e_scenario1_title: "  3 つのタスクを連鎖依存で実行:",
  e2e_scenario1_tasks: "  Task 1 (調査) → Task 2 (設計) → Task 3 (実装)\n",

  // ── ヘルプテキスト ────────────────────────────────────────────────────────────
  help_start: `
cmux-team start -- daemon 起動 + Master spawn + ダッシュボード表示

Usage:
  cmux-team start [--layout=<wide|16x9>] [--no-sleep-prevention]

Options:
  --layout <wide|16x9>     レイアウトモード (デフォルト: 16x9、または config.json の layout)
                           - 16x9: 上段フル幅 + 下段 2 分割、Conductor x2（デフォルト）
                           - wide: 2x2 レイアウト、Conductor x3
  --no-sleep-prevention    macOS スリープ抑止を無効化（caffeinate -dis を使わない）
                           .team/config.json の "sleepPrevention": false でも設定可能

Notes:
  - cmux 環境内で実行する必要があります（CMUX_SOCKET_PATH が必要）
  - daemon + ロギングプロキシ + レイアウト pane + Master を起動します
  - 優先順位: --layout > .team/config.json の "layout" > "16x9"
  - CMUX_TEAM_MAX_CONDUCTORS 環境変数は layout 派生値を上書きします
    （16x9 は 2 pane のみ作成、超過分は clamp されます）
  - ダッシュボードが表示され、キーボードショートカットで操作できます
  - スリープ抑止: macOS では稼働中エージェントがある間 caffeinate -dis を実行します
    （ディスプレイスリープ・アイドルスリープ・AC 電源時のシステムスリープを抑止）
    優先順位: --no-sleep-prevention > .team/config.json の "sleepPrevention" > true
`,

  help_send: `
cmux-team send -- キューにメッセージを送信

Usage:
  cmux-team send <type> [options]

Types と必須/任意オプション:
  TASK_CREATED
    --task-id <id>          タスク ID（必須）
    --task-file <path>      タスクファイルパス（必須）

  TASK_UPDATED
    --task-id <id>          タスク ID（必須）
    --task-file <path>      タスクファイルパス（必須）

  CONDUCTOR_DONE
    --surface <surface>     Conductor の surface ID（必須）
    --success <bool>        成功/失敗（任意、デフォルト true）
    --reason <text>         理由（任意）
    --exit-code <number>    終了コード（任意）
    --session-id <id>       セッション ID（任意）
    --transcript-path <p>   トランスクリプトパス（任意）

  CONDUCTOR_REGISTERED
    --surface <surface>     Conductor の surface ID（必須）

  AGENT_SPAWNED
    --conductor-surface <s> Conductor の surface ID（必須）
    --surface <surface>     Agent の surface ID（必須）
    --role <role>           ロール名（任意）
    --task-title <title>    タスクタイトル（任意）

  SESSION_STARTED
    --surface <surface>     surface ID（必須）
    --pid <number>          プロセス ID（必須）
    --session-id <id>       セッション ID（任意）

  SESSION_ENDED
    --surface <surface>     surface ID（必須）
    --pid <number>          プロセス ID（任意）
    --reason <text>         理由（任意）

  SESSION_ACTIVE
    --surface <surface>     surface ID（必須）
    --pid <number>          プロセス ID（任意）

  SESSION_IDLE
    --surface <surface>     surface ID（必須）
    --pid <number>          プロセス ID（任意）

  SESSION_CLEAR
    --surface <surface>     surface ID（必須）
    --pid <number>          プロセス ID（任意）

  SHUTDOWN
    （オプションなし）

Examples:
  cmux-team send TASK_CREATED --task-id 035 --task-file .team/tasks/035-example.md
  cmux-team send SHUTDOWN
  cmux-team send CONDUCTOR_DONE --surface surface:210 --success true
`,

  help_status: `
cmux-team status -- チームのステータスを表示

Usage:
  cmux-team status [options]

Options:
  --log <N>     ログ末尾の表示行数（任意、デフォルト 10）

Examples:
  cmux-team status
  cmux-team status --log 20

Token Pool (T323):
  token pool 機能が有効な場合（CMUX_TEAM_TOKEN_POOL=1 / config / global yaml）、
  ヘッダー直後に pool 情報（capacity / next reset）を表示し、Master / Conductor /
  Agent 行に handle / 使用率 / cap_pct を付与します。OFF 時は既存レイアウト維持。
  全 token 一覧は: cmux-team pool status
`,

  help_spawn_conductor: `
cmux-team spawn-conductor -- 現在の surface で Conductor を起動・登録

Usage:
  cmux-team spawn-conductor

現在の surface（$CMUX_SURFACE または呼び出し元 surface）で Conductor を起動します。
`,

  help_spawn_agent: `
cmux-team spawn-agent -- サブエージェントを起動

Usage:
  cmux-team spawn-agent --conductor-surface <surface> --role <role> (--prompt <text> | --prompt-file <path>) [options]

Options:
  --conductor-surface <surface>   Conductor の surface ID（必須）
  --role <role>                   エージェントのロール名（必須）
  --prompt <text>                 インラインプロンプト（--prompt-file と排他、どちらか必須）
  --prompt-file <path>            プロンプトファイルパス（--prompt と排他、どちらか必須）
  --task-title <title>            タスクタイトル（任意、タブ名に使用）
  --model <model>                 使用するモデル（デフォルト: config.models.agent or "{model}"）

Examples:
  cmux-team spawn-agent --conductor-surface surface:210 --role researcher --prompt "調査してください"
  cmux-team spawn-agent --conductor-surface surface:210 --role implementer --prompt-file .team/prompts/task.md

Notes:
  - Conductor ペイン内にタブとして Agent を作成します
  - タブ作成に失敗した場合は new-split right にフォールバックします
  - AGENT_SPAWNED メッセージが自動的にキューに送信されます
`,

  help_agents: `
cmux-team agents -- 稼働中のエージェント一覧を表示

Usage:
  cmux-team agents

Options:
  なし
`,

  help_kill_agent: `
cmux-team kill-agent -- エージェントを停止

Usage:
  cmux-team kill-agent --surface <surface>

Options:
  --surface <surface>     停止する Agent の surface ID（必須）

Examples:
  cmux-team kill-agent --surface surface:215
`,

  help_close_agent: `
cmux-team close-agent -- Agent を正常終了

Usage:
  cmux-team close-agent --surface <surface>

Options:
  --surface <surface>     正常終了する Agent の surface ID（必須）

Notes:
  - Agent が正常完了した場合（Inspector で GO 判定済み等）に使用する。
  - kill-agent と違い、agent done マーカーに status=completed が記録される。
  - クラッシュや強制停止には kill-agent を使う（status=crashed として記録）。

Examples:
  cmux-team close-agent --surface surface:215
`,

  help_send_agent: `
cmux-team send-agent -- この Conductor が spawn した Agent にメッセージを送る

Usage:
  cmux-team send-agent --surface <agent-surface> [--no-return] <message>

Options:
  --surface <agent-surface>   送信先 Agent の surface（必須）
  --no-return                 送信後の Enter を抑制
  <message>                   メッセージ本文（シェルでクォート）

Environment:
  CMUX_SURFACE                呼び出し側 Conductor の surface（未設定時は cmux identify）

Examples:
  cmux-team send-agent --surface surface:382 "plan.md の 3 節から再開してください"
  cmux-team send-agent --surface surface:382 --no-return "途中行"

Notes:
  - 呼び出し元 Conductor が spawn した Agent のみに送信可（.team/team.json で検証）
  - 自己送信や他 Conductor の Agent は拒否
  - team.json 未反映の場合は 200ms × 5 回までリトライ
`,

  help_create_task: `
cmux-team create-task -- タスクを作成

Usage:
  cmux-team create-task --title <title> [options]

Options:
  --title <title>         タスクタイトル（必須）
  --body <text>           タスク本文（任意）
  --priority <priority>   優先度: high / medium / low（任意、デフォルト medium）
  --status <status>       初期ステータス: draft / ready（任意、デフォルト draft）
  --depends-on <ids>      依存タスク ID（カンマ区切り、例: "081,082"）（任意）
  --base-branch <branch>  マージ先ブランチ（任意、デフォルト: 指定なし → main にマージ）
  --run-after-all         全通常タスク完了後に実行（任意）
  --exclusive             排他実行: drain 後、自身が closed になるまで他の全 assignment を停止
                          （--run-after-all を暗黙に含む。リリースや移行作業向け）
  --force                 ready 昇格時の sync state チェックをバイパス（注意して使用）
  --skip-fetch            sync state チェック前の 'git fetch' を省略
  --no-auto-pull          behind-ff + <mainBranch> checkout 時の自動 'git pull --ff-only'
                          を抑止し warn 扱いで続行する

Examples:
  cmux-team create-task --title "バグ修正" --status ready --body "ログイン画面のエラー"
  cmux-team create-task --title "新機能追加" --priority high
  cmux-team create-task --title "リファクタ" --depends-on "081,082" --status ready
  cmux-team create-task --title "hotfix" --base-branch develop --status ready
  cmux-team create-task --title "リリース v3.5.0" --run-after-all --status ready
  cmux-team create-task --title "リリース v3.53.0" --exclusive --status ready

Notes:
  - status が ready の場合、TASK_CREATED メッセージが自動送信され、
    daemon が idle Conductor に割り当てます
  - draft の場合は割り当てされません。update-task --status ready で開始できます
  - --run-after-all タスクはシステム内に1つだけ存在可能です（未クローズの
    run_after_all タスクがあるとエラーになります）
  - run_after_all タスクは全通常タスクが closed になった後に自動実行されます
  - --exclusive は --run-after-all（drain）を暗黙に含み、さらに自身が assigned の間
    他の全タスク assignment を停止します（closed になると再開）
  - --exclusive タスク同士は共存可能で、ID 昇順に順次排他実行されます。
    非排他 --run-after-all と --exclusive は共存できません（どちら側から起票しても
    create-task が RUN_AFTER_ALL_CONFLICT でエラーになります）
  - status=ready で作成するとき、local <mainBranch> と origin/<mainBranch> の整合性を
    検査し、diverged / uncommitted / detached は reject されます。
    バイパスは --force または CMUX_TEAM_SKIP_SYNC_CHECK=1
  - behind-ff かつ <mainBranch> を checkout 中の場合、cmux-team が
    'git pull --ff-only origin <mainBranch>' を自動実行し、失敗すると create を reject します。
    --no-auto-pull で auto-pull を抑止して warn 扱いに切り替えられます
    （他ブランチ checkout 中 / detached の behind-ff は元から warn のみ）
`,

  help_update_task: `
cmux-team update-task -- タスクを更新

Usage:
  cmux-team update-task --task-id <id> [options]

Options:
  --task-id <id>          タスク ID（必須）
  --status <status>       新しいステータス（任意）
  --title <title>         新しいタイトル（任意）
  --body <text>           新しい本文（任意）
  --depends-on <ids>      依存タスク ID（カンマ区切り、例: "081,082"）（任意）
  --force                 ready 昇格時の sync state チェックをバイパス（注意して使用）
  --skip-fetch            sync state チェック前の 'git fetch' を省略
  --no-auto-pull          behind-ff + <mainBranch> checkout 時の自動 'git pull --ff-only'
                          を抑止し warn 扱いで続行する

  ※ --status, --title, --body, --depends-on のうち少なくとも1つが必要

Examples:
  cmux-team update-task --task-id 035 --status ready
  cmux-team update-task --task-id 035 --title "新タイトル" --body "新しい説明"
  cmux-team update-task --task-id 035 --depends-on "081,082"

Notes:
  - assigned（実行中）のタスクは更新できません
  - closed のタスクは更新できません（新しいタスクを作成してください）
  - status を ready に変更すると TASK_CREATED メッセージが自動送信されます
  - ready への遷移時に local <mainBranch> と origin/<mainBranch> の整合性を検査し、
    diverged / uncommitted / detached は reject されます。バイパスは --force
    または CMUX_TEAM_SKIP_SYNC_CHECK=1
  - behind-ff かつ <mainBranch> を checkout 中の場合、cmux-team が
    'git pull --ff-only origin <mainBranch>' を自動実行し、失敗すると update を reject します。
    --no-auto-pull で auto-pull を抑止して warn 扱いに切り替えられます
`,

  help_close_task: `
cmux-team close-task -- タスクを完了（closed）にする

Usage:
  cmux-team close-task --task-id <id> --deliverable-kind <kind> [kind 別フラグ] [--journal <text>] [--force]

Options:
  --task-id <id>                  タスク ID（必須）
  --deliverable-kind <kind>       納品方式（必須。files / merged / pr / none のいずれか）
  --deliverable <path>            ファイルパス（kind=files のとき 1 件以上必須。複数指定可）
  --merged-into <branch>          マージ先ブランチ名（kind=merged で必須）
  --merge-sha <sha>               マージコミット SHA（kind=merged で必須）
  --pr-url <url>                  Pull Request URL（kind=pr で必須）
  --journal <text>                完了ジャーナル（任意）
  --force                         assigned（実行中）タスクを強制クローズ

Examples:
  # ローカル ff-only マージ（最も多いパターン）
  cmux-team close-task --task-id 035 --deliverable-kind merged \\
    --merged-into task-035/task --merge-sha $(git rev-parse task-035/task) \\
    --journal "実装完了、テストパス"

  # GitHub PR 納品
  cmux-team close-task --task-id 036 --deliverable-kind pr \\
    --pr-url https://github.com/owner/repo/pull/42 --journal "PR を open"

  # 調査系・ドキュメントのみ（branch を残さない納品）
  cmux-team close-task --task-id 037 --deliverable-kind files \\
    --deliverable .team/artifacts/A042.md --deliverable docs/spec/01-x.md \\
    --journal "リサーチ結果納品"

  # 納品物なし（例: 既に T294 で満たされていた）
  cmux-team close-task --task-id 038 --deliverable-kind none --journal "T294 で既に充足"

Notes:
  - --deliverable-kind は必須です。未指定時は exit 1 になります
  - kind 別フラグは排他（例: kind=merged のとき --pr-url は reject されます）
  - assigned（実行中）タスクは kind を指定しても --force が必要です
  - T295 以前の旧 closed 行は読み取り時に deliverable=undefined として扱われます
    （破壊的変更は作成側のみ）
`,

  help_abort_task: `
cmux-team abort-task -- 実行中タスクを中止（aborted）にする

Usage:
  cmux-team abort-task --task-id <id> [--journal <text>]

Options:
  --task-id <id>          タスク ID（必須）
  --journal <text>        中止ジャーナル（任意、デフォルト: "中断: T{id} {title}"）

Examples:
  cmux-team abort-task --task-id 035
  cmux-team abort-task --task-id 035 --journal "方針変更のため中止"

Notes:
  - assigned（実行中）のタスクのみ中止できます
  - Conductor の sub-agent と Conductor 自体を停止します
  - worktree を削除し、タスク状態を aborted に変更します
  - Conductor は自動的に idle 状態に再起動します
`,

  help_restart_task: `
cmux-team restart-task -- assigned または aborted のタスクを再実行（ready に戻す）

Usage:
  cmux-team restart-task --task-id <id> [--journal <text>]

Options:
  --task-id <id>          タスク ID（必須）
  --journal <text>        再実行ジャーナル（任意、デフォルト: "再実行: T{id} {title}"）

Examples:
  cmux-team restart-task --task-id 035                                    # assigned / aborted どちらでも実行可
  cmux-team restart-task --task-id 035 --journal "Conductor がクラッシュしたため再実行"

Notes:
  - assigned（実行中）または aborted のタスクを再実行できます
  - assigned からは abort-task と同じクリーンアップを実行（エージェント停止、worktree 削除）
  - aborted からは abort 時に残った worktree / ブランチの残骸のみ削除します
  - ステータスを aborted ではなく ready に戻します
  - TASK_CREATED 通知により自動再割り当てされます
`,

  help_clear_conductor: `
cmux-team clear-conductor -- broken Conductor を明示的にリセットする（broken → idle）

Usage:
  cmux-team clear-conductor --surface <id>

Options:
  --surface <id>   surface ID（例: 112 または surface:112）

Examples:
  cmux-team clear-conductor --surface 112
  cmux-team clear-conductor --surface surface:112

Notes:
  - broken 状態の Conductor のみクリアできます
  - 他の状態は abort-task / restart-task を使ってください
  - worktree / branch 残骸は broken 遷移時点で既に掃除済みのため、ここでは行いません
`,

  help_delete_task: `
cmux-team delete-task -- タスクを削除（deleted）にする

Usage:
  cmux-team delete-task --task-id <id> [options]

Options:
  --task-id <id>          タスク ID（必須）
  --journal <text>        削除ジャーナル（任意、デフォルト: "削除: T{id} {title}"）
  --force                 closed / aborted のタスクを強制削除する（assigned は依然 abort-task が必要）

Examples:
  cmux-team delete-task --task-id 035
  cmux-team delete-task --task-id 035 --journal "不要になったため削除"
  cmux-team delete-task --task-id 035 --force                  # closed / aborted を強制削除

Notes:
  - draft / ready のタスクは --force なしで削除できます
  - closed / aborted のタスクは --force が必要です（assigned はまず abort-task で止めてください）
  - assigned のタスクは --force でも削除できません（abort-task / restart-task を使用）
  - deleted は終端状態で、再削除は exit 1 になります
  - task-state.json の status が deleted に設定されます
  - Journal タブに記録が残ります
`,

  help_trace_task: `
cmux-team trace-task -- タスクのセッション履歴を表示

Usage:
  cmux-team trace-task <task-id> [options]

Options:
  --no-metrics           Token Usage / By role / By model セクションを非表示にする
  --summary              要約モード（将来拡張用スタブ）

Examples:
  cmux-team trace-task 141
  cmux-team trace-task 141 --no-metrics
  cmux-team trace-task 141 --summary

Output includes:
  - Base 行: base branch / SHA / source（記録がある場合）
  - Deliverable 行: close-task 時に記録された納品方式（kind + 詳細）。旧行は "-"
  - Token Usage: 全体集計（requests / input / output / cache create / cache read / cache hit rate / duration）
  - By role / By model: role 別・model 別の内訳（T305 以前のタスクはフォールバック行 1 行のみ）
`,

  help_trace_hooks: `
cmux-team trace-hooks -- daemon が受信した hook シグナル履歴を表示

Usage:
  cmux-team trace-hooks [options]

Options:
  --type <TYPE>          hook type で絞り込み（SESSION_STARTED / SESSION_ENDED /
                         SESSION_IDLE / SESSION_CLEAR / AGENT_SPAWNED / SESSION_ASK /
                         CONDUCTOR_DONE / NOTIFICATION など）
  --surface <surface>    surface で絞り込み（"surface:665" / "665" / "C[665]" 受理）
  --task-run <id>        task_run_id で絞り込み（例: "task-217-1776294106"）
  --role <ROLE>          NOTIFICATION の role 列で絞り込み（master/conductor/agent/unknown）
  --task-id <id>         NOTIFICATION の task_id 列で絞り込み（例: "265"）
  --limit <N>            最大表示件数（デフォルト: 50、新しい順）
  --json                 tabular の代わりに JSON 配列を出力

Examples:
  cmux-team trace-hooks
  cmux-team trace-hooks --type SESSION_ENDED --limit 20
  cmux-team trace-hooks --surface C[665]
  cmux-team trace-hooks --task-run task-217-1776294106 --json
  cmux-team trace-hooks --type NOTIFICATION --role agent
  cmux-team trace-hooks --type NOTIFICATION --task-id 265

Notes:
  - .team/traces/traces.db の hook_signals テーブルから読み込みます
  - id DESC（新しい順）で並びます
  - DETAIL カラムには source/reason/task_run_id/question のうち値があるものだけ表示
  - NOTIFICATION 行では role/task_id/agent_role/ntype/message が DETAIL に出ます
  - question/message は 60 文字で truncate されます。完全なデータは --json を使用
`,

  help_conductor: `
cmux-team conductor -- Conductor 用 Claude Code を起動（内部用）

Usage:
  cmux-team conductor [--model <model>]

Environment:
  CMUX_SURFACE  Conductor の surface ID（任意。未指定時は cmux identify の caller.surface_ref から自動解決）

Options:
  --model <model>   使用するモデル（デフォルト: config.models.conductor or "{model}"）

Notes:
  - 通常は daemon が起動時に自動的に呼び出す内部コマンドですが、
    cmux ペイン内から手動で実行することもできます（CMUX_SURFACE は自動検出されます）
  - ロギングプロキシのポートを動的に解決して Claude Code を exec します
  - --dangerously-skip-permissions で起動されます
`,

  help_spawn_master: `
cmux-team spawn-master -- Master 用 Claude Code を起動（self-register）

Usage:
  cmux-team spawn-master [--model <model>]

Options:
  --model <model>   使用するモデル（デフォルト: config.models.master or "{model}"）

Notes:
  - Claude Code 起動前に MASTER_REGISTERED を daemon へ POST して自己登録します
  - daemon が起動していない場合は exit 1 で失敗します（.team/proxy-port 不在）
  - 任意のペインから実行できます — 起動中の daemon に新しい Master を追加する用途に利用可能
  - ロギングプロキシのポートを動的に解決して Claude Code を exec します
  - Master プロンプトを生成してから --dangerously-skip-permissions で起動されます
`,

  help_artifacts: `
cmux-team artifacts -- アーティファクト管理（add は move 動作）

Usage:
  cmux-team artifacts [subcommand] [options]

Subcommands:
  (なし)                  アーティファクト一覧表示（デフォルト）
  add <file>             ファイルを .team/artifacts/ に **移動** する（成功時にソース削除）
  show <id>              アーティファクトの内容を表示
  open <id>              Markdown ビューアでアーティファクトを開く
  search <query>         アーティファクトを全文検索

Options:
  --type <type>           タイプでフィルタ: research / decision / session / spec / report（任意）
  --task <id>             関連タスク ID でフィルタ（任意）
  --sort <field>          ソート基準: created / updated（任意、デフォルト created）
  --validate              全アーティファクトのフロントマターを検証
  --type <type>           (add) アーティファクトのタイプ: research / decision / session / spec / report
  --title <title>         (add) アーティファクトのタイトル
  --task <id>             (add) 関連タスク ID
  --tags <tag1,tag2>      (add) カンマ区切りのタグ
  --project-root <path>   (add) プロジェクトルートを上書き（dest の .team/artifacts/ がここ基準になる）

Examples:
  cmux-team artifacts
  cmux-team artifacts add ./research-notes.md
  cmux-team artifacts add ./design.md --type decision --title "認証方式の選定"
  cmux-team artifacts show A001
  cmux-team artifacts open A001
  cmux-team artifacts search "認証"
  cmux-team artifacts --type research --task T038
  cmux-team artifacts --validate
`,

  help_await_task: `
cmux-team await-task -- タスクの完了（closed/aborted）を待機する

Usage:
  cmux-team await-task --task-id <id> [options]

Options:
  --task-id <id>          タスク ID（必須、カンマ区切りで複数指定可: 108,109）
  --timeout <seconds>     タイムアウト秒数（デフォルト: 3600）

完了時の挙動:
  - closed: summary.md を stdout に出力して exit 0
  - aborted: abort 理由を stderr に出力して exit 1
  - timeout: タイムアウトメッセージを stderr に出力して exit 2

Examples:
  cmux-team await-task --task-id 108
  cmux-team await-task --task-id 108,109 --timeout 7200
`,

  help_get_agent_instructions: `
cmux-team get-agent-instructions -- 指定 overlay ロールの project-local overlay を表示

Usage:
  cmux-team get-agent-instructions --role <role>

Options:
  --role <role>           overlay ロール: Agent 8 ロール + master + conductor（必須）
                          エイリアス: impl → implementer, reviewer → design-reviewer

Notes:
  - PROJECT_ROOT 配下の .team/agent-instructions/<role>.md を読みます
  - 内容を stdout に出力します（末尾改行保持）
  - overlay ファイルが無い場合は何も出力せず exit 0
  - 未知 role は stderr にエラーを出して exit 1
  - master / conductor の overlay は daemon 起動時に generateMasterPrompt /
    generateConductorRolePrompt が .team/prompts/master.md /
    .team/prompts/conductor-role.md に展開する (T342)
`,

  help_set_agent_instructions: `
cmux-team set-agent-instructions -- 指定 overlay ロールの project-local overlay を書き込む

Usage:
  cmux-team set-agent-instructions --role <role> (--body <text> | --from-file <path> | --from-stdin)

Options:
  --role <role>           overlay ロール: Agent 8 ロール + master + conductor（必須）
  --body <text>           overlay 本文をインラインテキストで指定（--from-file/--from-stdin と排他）
  --from-file <path>      overlay 本文をファイルから読み取り（排他）
  --from-stdin            overlay 本文を stdin から読み取り（排他）

Notes:
  - .team/agent-instructions/ が無ければ作成します
  - overlay 本文は 100 KB を超えるとエラー（exit 1）
  - 未知 role は exit 1（strict — overlay writer はユーザー入口のため）
  - 成功時に "OK role=<role> bytes=<n>" を stdout に出力
`,

  help_delete_agent_instructions: `
cmux-team delete-agent-instructions -- 指定 overlay ロールの project-local overlay を削除

Usage:
  cmux-team delete-agent-instructions --role <role>

Notes:
  - overlay ロール: Agent 8 ロール + master + conductor
  - 削除成功時 "DELETED=true"、存在しなかった場合 "DELETED=false" を出力
  - どちらも exit 0（削除は冪等）
  - 未知 role は stderr にエラーを出して exit 1
`,

  help_list_agent_instructions: `
cmux-team list-agent-instructions -- 全 overlay ロールの overlay 有無を一覧表示

Usage:
  cmux-team list-agent-instructions

Notes:
  - OVERLAY_ROLES の順で 1 ロール 1 行ずつ出力（Agent 8 ロール → master → conductor）
  - overlay あり: "<role> ✓ <n> bytes"
  - overlay なし: "<role> ✗"
`,

  help_main: `cmux-team — マルチエージェント開発オーケストレーション

Usage:
  cmux-team --version                          バージョン表示
  cmux-team start                              daemon 起動 + Master spawn
  cmux-team send TASK_CREATED --task-id <id> --task-file <path>
  cmux-team send SHUTDOWN
  cmux-team status                             ステータス表示
  cmux-team spawn-conductor
  cmux-team spawn-agent --conductor-surface <surface> --role <role> --prompt <prompt>
                                              （Agent ロールのみ — master/conductor は overlay 専用）
  cmux-team agents                             稼働中エージェント一覧
  cmux-team close-agent --surface <surface>    Agent を正常終了
  cmux-team kill-agent --surface <surface>     Agent を強制停止（crash 扱い）
  cmux-team send-agent --surface <surface> <message>    Agent にメッセージ送信
  cmux-team create-task --title <title> [--priority <p>] [--status <s>] [--body <text>] [--depends-on <ids>] [--run-after-all] [--exclusive]
  cmux-team update-task --task-id <id> --status <status>
  cmux-team close-task --task-id <id> [--journal <text>]
  cmux-team await-task --task-id <id> [--timeout <sec>]    タスク完了待ち
  cmux-team abort-task --task-id <id> [--journal <text>] 実行中タスクを中止
  cmux-team restart-task --task-id <id> [--journal <text>] assigned または aborted のタスクを再実行
  cmux-team delete-task --task-id <id> [--journal <text>] タスクを削除
  cmux-team trace-task <task-id>              タスクのセッション履歴を表示
  cmux-team trace-hooks                        hook シグナル履歴を表示
  cmux-team conductor                          Conductor 起動（proxy 自動解決）
  cmux-team spawn-master                      Master 起動（proxy 自動解決）
  cmux-team artifacts                              アーティファクト一覧
  cmux-team artifacts add <file>                   ファイルを .team/artifacts/ に移動
  cmux-team artifacts show <id>                    アーティファクト表示
  cmux-team artifacts open <id>                    Markdown ビューアで開く
  cmux-team artifacts search <query>               全文検索
  cmux-team artifacts --validate                   フロントマター検証
  cmux-team get-agent-instructions --role <role>   project-local overlay を表示（Agent ロール + master/conductor）
  cmux-team set-agent-instructions --role <role> (--body <t> | --from-file <p> | --from-stdin)  overlay を書き込み
  cmux-team delete-agent-instructions --role <role> overlay を削除
  cmux-team list-agent-instructions                 ロールごとの overlay 有無を一覧（10 ロール）
  cmux-team pool status                            token pool ダッシュボード表示 (T323)

各コマンドの詳細: cmux-team <command> --help`,

  // ── gh-cache (T272) ───────────────────────────────────────────────────────
  gh_not_a_github_repo:
    "Error: git リポジトリ外、または origin が GitHub / GHE ではありません。\n" +
    "  cmux-team issue/pr は origin が github.com または Enterprise インスタンスである必要があります。",
  gh_auth_missing:
    "Error: host {host} の GitHub トークンが見つかりません。\n" +
    "  確認先: {checked}\n" +
    "以下のいずれかを実行してください:\n" +
    "  gh auth login\n" +
    "  export GITHUB_TOKEN=<your token>",
  gh_rate_limit_exhausted:
    "Error: GitHub API のレート制限に到達しました。remaining={remaining} reset_at={reset_at}\n" +
    "  `cmux-team issue list --stale-ok` でキャッシュから読み取れます（同期せずに表示）。",
  gh_me_not_resolved:
    "Error: @me を解決できません。先に `cmux-team gh sync` を実行して viewer login をキャッシュしてください。",
  gh_unknown_subcommand:
    "Unknown subcommand: {sub}. `cmux-team gh --help` を参照してください。",
  gh_cache_not_initialized:
    "Error: gh-cache.db が空です。先に `cmux-team gh sync --full` を実行してください。",
  gh_stale_warning:
    "Warning: 最後の full sync から {days} 日経過しています。`cmux-team gh sync --full` の実行を検討してください。",
  gh_issue_empty: "(該当する issue / PR はありません)",
  gh_sync_success:
    "同期完了 {mode}: issues={issues} comments={comments} reviews={reviews} duration={duration_ms}ms",
  gh_sync_not_modified: "変更なし (304)。last_sync={last_sync}",
  gh_status_header: "GitHub cache status",
  gh_status_last_full: "最終 full sync:        {when}",
  gh_status_last_incremental: "最終 incremental sync: {when}",
  gh_status_host: "host:                  {host}",
  gh_status_repo: "repo:                  {owner}/{repo}",
  gh_status_viewer: "viewer:                {viewer}",
  gh_status_issue_counts:
    "issue:                 {total} (open={open}, closed={closed})",
  gh_status_pr_counts:
    "PR:                    {total} (open={open}, closed={closed}, merged={merged})",
  gh_status_comments: "comments:              {count}",
  gh_status_rate: "rate limit:            {remaining} / {limit} (reset {reset})",
  gh_status_token: "token hash:            {hash}",
  gh_status_never_synced: "(未実行)",
  gh_tui_tab_title: "Issues",
  gh_tui_help_line:
    "[R] 同期  [Enter/O] ビューアで開く  [B] ブラウザで開く",
  gh_tui_syncing: "同期中...",
  gh_tui_disabled_non_git:
    "Issues タブは無効（git リポジトリでないか、origin が GitHub ではありません）。",
  gh_tui_disabled_no_auth:
    "Issues タブには認証が必要です。`gh auth login` を実行するか GITHUB_TOKEN を設定してください。",
  gh_help: `cmux-team gh — GitHub issue/PR キャッシュ管理

Usage:
  cmux-team gh sync [--full]          issue/PR を .team/gh-cache.db に同期
  cmux-team gh status                 キャッシュ状態とレート制限を表示

Flags:
  --full    直近 500 件の issue/PR（とその添付）を最初から取得する
            （初回実行・トークンローテーション後・月次メンテ時に使用）

--full なしの場合、If-None-Match + since= で差分だけを取得します。
非 git ディレクトリ / 非 GitHub origin は exit 2、認証欠如は exit 3、
レート制限到達は exit 4 で終了します。`,

  // ── T307: dashboard Metrics タブ ──────────────────────────────────────────────
  metrics_tab_title: "Metrics",
  metrics_section_rate_limit_projection: "枯渇予測",
  metrics_section_pool_tokens: "Pool Tokens (selectable: {count})",
  metrics_long_term: "long-term",
  metrics_recent_15m: "recent 15m",
  metrics_before_reset: "リセットまで",
  metrics_pool_no_selectable: "(selectable な token なし)",
  metrics_pool_no_data: "データなし",
  metrics_section_role: "ロール別（直近 1 時間）",
  metrics_section_task: "タスク別（直近 1 時間、上位 {limit}）",
  metrics_label_risk: "RISK",
  metrics_label_no_data: "データなし",
  metrics_label_idle: "idle",
  metrics_empty_role: "(ウィンドウ内に api_usage レコードなし)",
  metrics_empty_task: "(ウィンドウ内にタスクなし)",
  metrics_loading: "メトリクスを読み込み中…",
  metrics_caption_from: "from: {role}/{surface} ({age}秒前)",
  metrics_proxy_idle: "proxy idle? last seen {age}秒前",
  metrics_header_role: "ロール",
  metrics_header_task: "タスク",
  metrics_header_requests: "件数",
  metrics_header_input: "入力",
  metrics_header_output: "出力",
  metrics_header_cache: "キャッシュ",
};

const messages = { en, ja };

/**
 * ロケールに応じたメッセージを返す。
 * vars を渡すと {key} プレースホルダーを置換する。
 */
export function t(key: keyof typeof en, vars?: Record<string, string>): string {
  const str = messages[locale][key] ?? messages.en[key] ?? key;
  if (!vars) return str;
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), str);
}

/**
 * 明示 locale 指定版の `t()`。`t()` がプロセス起動時の `locale` に固定されるのに対し、
 * こちらは locale を引数で受け取るため、locale 切替のテスト・overlay 展開時の
 * 明示指定などに使う（T247）。
 */
export function tFor(loc: Locale, key: keyof typeof en, vars?: Record<string, string>): string {
  const str = messages[loc][key] ?? messages.en[key] ?? key;
  if (!vars) return str;
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), str);
}
