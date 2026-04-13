/**
 * i18n — 国际化支持
 *
 * 语言检测优先级: CMUX_TEAM_LANG > LC_ALL > LC_MESSAGES > LANG
 * 默认: 英语 (en)
 */

export type Locale = "zh" | "en";

function detectLocale(): Locale {
  const envVars = [
    process.env.CMUX_TEAM_LANG,
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
  ];
  for (const v of envVars) {
    if (v?.startsWith("zh")) return "zh";
  }
  return "en";
}

export const locale: Locale = detectLocale();

// --- 消息定义 ---

const en = {
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

  // ── Conductor 待機プロンプト ───────────────────────────────────────────────────
  conductor_wait_prompt:
    "You are a Conductor slot. Wait at the ❯ prompt without doing anything until the Manager assigns a task via /clear + prompt. Do NOT search, read, or execute any tasks.",

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
  cmux-team start

Options:
  (none)

Notes:
  - Must be run inside a cmux session (CMUX_SOCKET_PATH is required)
  - Starts daemon + logging proxy + 2x2 layout (3 Conductors) + Master
  - Dashboard is displayed with keyboard shortcuts for interaction
`,

  help_init: `
cmux-team init -- initialize agent configuration

Usage:
  cmux-team init [options]

Options:
  --agent <type>              Default agent CLI (claude, gemini, codex, opencode, ft-claude)
  --roles <role=type,...>     Role-specific agent overrides (e.g., researcher=gemini,implementer=claude)

Interactive mode (when stdin is TTY):
  Prompts for default agent and optional role-specific overrides.

Non-interactive mode (piped stdin or CI):
  Uses --agent and --roles flags. Defaults to "claude" if neither is specified.

Notes:
  - Creates .team/ directory if it does not exist
  - Merges agents section into existing .team/config.json
  - Safe to re-run: asks before overwriting existing agent config
`,

  // 対話プロンプト文字列
  init_default_agent_prompt: "Default agent for this project?",
  init_add_roles_prompt: "Add role-specific agent overrides?",
  init_role_name_prompt: "Role name (empty to finish)",
  init_role_agent_prompt: "Agent for this role?",
  init_reconfigure_prompt: "Agent config already exists. Reconfigure?",
  init_config_saved: "Config saved to .team/config.json",
  init_agent_default: "  default: {agent}",
  init_agent_role: "  {role}: {agent}",
  create_task_agent_prompt: "Which agent should handle this task?",

  help_send: `
cmux-team send -- send a message to the queue

Usage:
  cmux-team send <type> [options]

Types and required/optional options:
  TASK_CREATED
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
    --pane-id <pane-id>     pane ID (optional)

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
    --conductor-id <id>     Conductor ID (optional)
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
`,

  help_stop: `
cmux-team stop -- gracefully shut down daemon

Usage:
  cmux-team stop

Options:
  (none)

Notes:
  - Sends a SHUTDOWN message to the queue; daemon receives it and stops
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
  --agent <type>                  agent CLI: claude / ft-claude / codex / gemini / opencode (default: from config)

Examples:
  cmux-team spawn-agent --conductor-surface surface:210 --role researcher --prompt "Research the API endpoints"
  cmux-team spawn-agent --conductor-surface surface:210 --role implementer --prompt-file .team/prompts/task.md
  cmux-team spawn-agent --conductor-surface surface:210 --role researcher --agent gemini --prompt "Investigate caching"

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
  --agent <type>          agent CLI override: claude / ft-claude / codex / gemini / opencode (optional)
  --run-after-all         run after all regular tasks complete (optional)

Examples:
  cmux-team create-task --title "Fix bug" --status ready --body "Login screen error"
  cmux-team create-task --title "Add feature" --priority high
  cmux-team create-task --title "Refactor" --depends-on "081,082" --status ready
  cmux-team create-task --title "hotfix" --base-branch develop --status ready
  cmux-team create-task --title "Release v3.5.0" --run-after-all --status ready
  cmux-team create-task --title "Research competitors" --agent gemini --status ready

Notes:
  - If status is ready, a TASK_CREATED message is automatically sent
    and the daemon assigns it to an idle Conductor
  - If draft, it will not be assigned. Use update-task --status ready to start
  - Only one --run-after-all task may exist at a time (error if one already exists unclosed)
  - The run_after_all task runs automatically after all regular tasks are closed
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

  * At least one of --status, --title, --body, or --depends-on is required

Examples:
  cmux-team update-task --task-id 035 --status ready
  cmux-team update-task --task-id 035 --title "New title" --body "New description"
  cmux-team update-task --task-id 035 --depends-on "081,082"

Notes:
  - Tasks in assigned (running) state cannot be updated
  - Closed tasks cannot be updated (create a new task instead)
  - Changing status to ready automatically sends a TASK_CREATED message
`,

  help_close_task: `
cmux-team close-task -- mark a task as complete (closed)

Usage:
  cmux-team close-task --task-id <id> [options]

Options:
  --task-id <id>          task ID (required)
  --journal <text>        completion journal (optional, recorded on success)
  --force                 force-close a running task (optional flag)

Examples:
  cmux-team close-task --task-id 035 --journal "Implementation complete, tests passed"
  cmux-team close-task --task-id 035 --force

Notes:
  - Tasks in assigned (running) state require --journal or --force
  - Sets status to closed in task-state.json
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
cmux-team restart-task -- restart a running task (re-queues as ready)

Usage:
  cmux-team restart-task --task-id <id> [--journal <text>]

Options:
  --task-id <id>          task ID (required)
  --journal <text>        restart journal (optional, default: "Restarted: T{id} {title}")

Examples:
  cmux-team restart-task --task-id 035
  cmux-team restart-task --task-id 035 --journal "Conductor crashed, retrying"

Notes:
  - Only tasks in assigned (running) state can be restarted
  - Performs the same cleanup as abort-task (stops agents, removes worktree)
  - Sets status back to ready instead of aborted
  - Sends TASK_CREATED notification for automatic re-assignment
`,

  help_delete_task: `
cmux-team delete-task -- delete a task (sets to deleted)

Usage:
  cmux-team delete-task --task-id <id> [options]

Options:
  --task-id <id>          task ID (required)
  --journal <text>        deletion journal (optional, default: "Deleted: T{id} {title}")

Examples:
  cmux-team delete-task --task-id 035
  cmux-team delete-task --task-id 035 --journal "No longer needed"

Notes:
  - Only draft/ready tasks can be deleted (use abort-task for assigned tasks)
  - Sets status to deleted in task-state.json
  - A record remains in the journal
`,

  help_trace_task: `
cmux-team trace-task -- display session history for a task

Usage:
  cmux-team trace-task <task-id> [options]

Options:
  --summary              show summary mode (stub for future)

Examples:
  cmux-team trace-task 141
  cmux-team trace-task 141 --summary
`,

  help_conductor: `
cmux-team conductor -- launch Claude Code for Conductor (internal use)

Usage:
  cmux-team conductor [--model <model>]

Environment:
  CMUX_SURFACE  Conductor surface ID (required, set by daemon)

Options:
  --model <model>   model to use (default: config.models.conductor or "{model}")

Notes:
  - Internal command called automatically by daemon at startup
  - Dynamically resolves logging proxy port and exec's Claude Code
  - Launched with --dangerously-skip-permissions
`,

  help_spawn_master: `
cmux-team spawn-master -- launch Claude Code for Master (internal use)

Usage:
  cmux-team spawn-master [--model <model>]

Options:
  --model <model>   model to use (default: config.models.master or "{model}")

Notes:
  - Internal command called automatically by daemon at startup
  - Dynamically resolves logging proxy port and exec's Claude Code
  - Generates Master prompt then launches with --dangerously-skip-permissions
`,

  help_artifacts: `
cmux-team artifacts -- manage artifacts

Usage:
  cmux-team artifacts [subcommand] [options]

Subcommands:
  (none)                  list artifacts (default)
  add <file>             add a file as an artifact
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

  help_main: `cmux-team — multi-agent development orchestration

Usage:
  cmux-team start                              launch daemon + spawn Master
  cmux-team send TASK_CREATED --task-id <id> --task-file <path>
  cmux-team send SHUTDOWN
  cmux-team status                             show status
  cmux-team stop                               graceful shutdown
  cmux-team spawn-conductor
  cmux-team spawn-agent --conductor-surface <surface> --role <role> --prompt <prompt>
  cmux-team agents                             list running agents
  cmux-team kill-agent --surface <surface>
  cmux-team send-agent --surface <surface> <message>    send a message to a spawned Agent
  cmux-team create-task --title <title> [--priority <p>] [--status <s>] [--body <text>] [--depends-on <ids>] [--run-after-all]
  cmux-team update-task --task-id <id> --status <status>
  cmux-team close-task --task-id <id> [--journal <text>]
  cmux-team await-task --task-id <id> [--timeout <sec>]    wait for task completion
  cmux-team abort-task --task-id <id> [--journal <text>]  abort a running task
  cmux-team restart-task --task-id <id> [--journal <text>] restart a running task
  cmux-team delete-task --task-id <id> [--journal <text>] delete a task
  cmux-team trace-task <task-id>              display session history for a task
  cmux-team conductor                          launch Conductor (auto-resolves proxy)
  cmux-team spawn-master                       launch Master (auto-resolves proxy)
  cmux-team artifacts                              list artifacts
  cmux-team artifacts add <file>                   add a file as an artifact
  cmux-team artifacts show <id>                    show artifact
  cmux-team artifacts open <id>                    open in markdown viewer
  cmux-team artifacts search <query>               full-text search
  cmux-team artifacts --validate                   validate frontmatter

For details on each command: cmux-team <command> --help`,
};

const zh: typeof en = {
  // ── 错误与状态消息 ──────────────────────────────────────────────
  not_in_cmux: "❌ 不在 cmux 环境中。请在 cmux 内执行此命令。",
  daemon_not_running:
    "Error: daemon 未启动（未找到 proxy-port 文件）",
  team_not_started_start: "团队未启动。请运行 `start` 来启动。",
  team_not_started: "团队未启动。",
  no_running_agents: "没有正在运行的 Agent。",
  no_artifacts: "未找到 Artifact",
  artifact_id_required:
    "Error: 请指定 Artifact ID\nUsage: cmux-team artifacts show <id>",
  artifact_id_required_open:
    "Error: 请指定 Artifact ID\nUsage: cmux-team artifacts open <id>",
  search_query_required:
    "Error: 请指定搜索关键词\nUsage: cmux-team artifacts search <query>",
  artifact_add_file_required:
    "Error: 请指定文件路径\nUsage: cmux-team artifacts add <file> [--type <type>] [--title <title>] [--task <id>] [--tags <tag1,tag2>]",
  dashboard_startup_hint:
    "提示: 请在 TTY 环境中运行 cmux-team start",
  task_section_header: "任务",

  // ── 模板消息 ────────────────────────────────────────────────────
  artifact_not_found: "未找到 Artifact {id}",
  no_artifacts_matching: '未找到匹配 "{query}" 的 Artifact',
  artifact_add_file_not_found: "Error: 未找到文件: {path}",
  artifact_added: "已添加 {id} → {path}",
  dashboard_startup_failed: "❌ 仪表盘启动失败: {message}",
  abort_journal_default: "中止: T{id} {title}",
  restart_journal_default: "重启: T{id} {title}",
  delete_journal_default: "删除: T{id} {title}",

  // ── 模板错误消息 ──────────────────────────────────────────────
  template_dir_not_found:
    "未找到模板目录。请运行: npm install -g @hummer98/cmux-team",
  conductor_role_template_not_found:
    "未找到 Conductor 角色模板。请运行: npm install -g @hummer98/cmux-team",
  conductor_task_template_not_found:
    "未找到 Conductor 任务模板。请运行: npm install -g @hummer98/cmux-team",

  // ── Conductor 待机提示 ───────────────────────────────────────────────────
  conductor_wait_prompt:
    "你是一个 Conductor 槽位。在 Manager 通过 /clear + 提示词分配任务之前，请在 ❯ 提示符处等待，不要执行任何操作。不要搜索、读取或执行任何任务。",

  // ── e2e.ts ────────────────────────────────────────────────────────────────────
  e2e_daemon_not_confirmed: "  WARNING: daemon 启动未确认，继续执行测试。",
  e2e_master_not_found:
    "  WARNING: 未找到 Master surface（Master spawn 可能已失败）",
  e2e_team_json_failed: "  WARNING: team.json 读取失败: {message}",
  e2e_scenario1_title: "  执行 3 个带链式依赖的任务:",
  e2e_scenario1_tasks: "  Task 1 (调研) → Task 2 (设计) → Task 3 (实现)\n",

  // ── 帮助文本 ────────────────────────────────────────────────────────────
  help_start: `
cmux-team start -- 启动 daemon + 生成 Master + 显示仪表盘

Usage:
  cmux-team start

Options:
  无

Notes:
  - 必须在 cmux 环境内运行（需要 CMUX_SOCKET_PATH）
  - 启动 daemon + 日志代理 + 2x2 布局（Conductor x3）+ Master
  - 显示仪表盘，可通过键盘快捷键进行操作
`,

  help_init: `
cmux-team init -- 初始化 Agent 配置

Usage:
  cmux-team init [options]

Options:
  --agent <type>              默认 Agent CLI (claude, gemini, codex, opencode, ft-claude)
  --roles <role=type,...>     按角色指定 Agent（例: researcher=gemini,implementer=claude）

交互模式（stdin 为 TTY 时）:
  以交互方式选择默认 Agent 和按角色指定的 Agent。

非交互模式（管道输入或 CI）:
  使用 --agent 和 --roles 参数。未指定时默认为 "claude"。

Notes:
  - 如果 .team/ 目录不存在则自动创建
  - 将 agents 配置合并到现有的 .team/config.json 中
  - 可重复运行: 如果已有配置会先确认再覆盖
`,

  // 交互提示字符串
  init_default_agent_prompt: "此项目的默认 Agent 是？",
  init_add_roles_prompt: "是否添加按角色指定的 Agent？",
  init_role_name_prompt: "角色名称（留空结束）",
  init_role_agent_prompt: "此角色使用哪个 Agent？",
  init_reconfigure_prompt: "Agent 配置已存在，是否重新配置？",
  init_config_saved: "配置已保存到 .team/config.json",
  init_agent_default: "  默认: {agent}",
  init_agent_role: "  {role}: {agent}",
  create_task_agent_prompt: "此任务使用哪个 Agent？",

  help_send: `
cmux-team send -- 向队列发送消息

Usage:
  cmux-team send <type> [options]

Types 及必填/可选参数:
  TASK_CREATED
    --task-id <id>          任务 ID（必填）
    --task-file <path>      任务文件路径（必填）

  CONDUCTOR_DONE
    --surface <surface>     Conductor 的 surface ID（必填）
    --success <bool>        成功/失败（可选，默认 true）
    --reason <text>         原因（可选）
    --exit-code <number>    退出码（可选）
    --session-id <id>       会话 ID（可选）
    --transcript-path <p>   日志路径（可选）

  CONDUCTOR_REGISTERED
    --surface <surface>     Conductor 的 surface ID（必填）
    --pane-id <pane-id>     面板 ID（可选）

  AGENT_SPAWNED
    --conductor-surface <s> Conductor 的 surface ID（必填）
    --surface <surface>     Agent 的 surface ID（必填）
    --role <role>           角色名（可选）
    --task-title <title>    任务标题（可选）

  SESSION_STARTED
    --surface <surface>     surface ID（必填）
    --pid <number>          进程 ID（必填）
    --session-id <id>       会话 ID（可选）

  SESSION_ENDED
    --surface <surface>     surface ID（必填）
    --pid <number>          进程 ID（可选）
    --reason <text>         原因（可选）

  SESSION_ACTIVE
    --surface <surface>     surface ID（必填）
    --pid <number>          进程 ID（可选）

  SESSION_IDLE
    --surface <surface>     surface ID（必填）
    --pid <number>          进程 ID（可选）

  SESSION_CLEAR
    --surface <surface>     surface ID（必填）
    --conductor-id <id>     Conductor ID（可选）
    --pid <number>          进程 ID（可选）

  SHUTDOWN
    （无参数）

Examples:
  cmux-team send TASK_CREATED --task-id 035 --task-file .team/tasks/035-example.md
  cmux-team send SHUTDOWN
  cmux-team send CONDUCTOR_DONE --surface surface:210 --success true
`,

  help_status: `
cmux-team status -- 显示团队状态

Usage:
  cmux-team status [options]

Options:
  --log <N>     显示日志末尾行数（可选，默认 10）

Examples:
  cmux-team status
  cmux-team status --log 20
`,

  help_stop: `
cmux-team stop -- 优雅关闭 daemon

Usage:
  cmux-team stop

Options:
  无

Notes:
  - 向队列发送 SHUTDOWN 消息，daemon 接收后停止
`,

  help_spawn_conductor: `
cmux-team spawn-conductor -- 在当前 surface 上启动并注册 Conductor

Usage:
  cmux-team spawn-conductor

在当前 surface（$CMUX_SURFACE 或调用方 surface）上启动 Conductor。
`,

  help_spawn_agent: `
cmux-team spawn-agent -- 启动子 Agent

Usage:
  cmux-team spawn-agent --conductor-surface <surface> --role <role> (--prompt <text> | --prompt-file <path>) [options]

Options:
  --conductor-surface <surface>   Conductor 的 surface ID（必填）
  --role <role>                   Agent 角色名（必填）
  --prompt <text>                 内联提示词（与 --prompt-file 互斥，二选一必填）
  --prompt-file <path>            提示词文件路径（与 --prompt 互斥，二选一必填）
  --task-title <title>            任务标题（可选，用于标签页名称）
  --model <model>                 使用的模型（默认: config.models.agent or "{model}"）
  --agent <type>                  Agent CLI: claude / ft-claude / codex / gemini / opencode（默认: 从 config 读取）

Examples:
  cmux-team spawn-agent --conductor-surface surface:210 --role researcher --prompt "请调研相关内容"
  cmux-team spawn-agent --conductor-surface surface:210 --role implementer --prompt-file .team/prompts/task.md
  cmux-team spawn-agent --conductor-surface surface:210 --role researcher --agent gemini --prompt "调研缓存策略"

Notes:
  - 在 Conductor 面板内以标签页形式创建 Agent
  - 标签页创建失败时回退到 new-split right
  - AGENT_SPAWNED 消息会自动发送到队列
`,

  help_agents: `
cmux-team agents -- 显示正在运行的 Agent 列表

Usage:
  cmux-team agents

Options:
  无
`,

  help_kill_agent: `
cmux-team kill-agent -- 停止 Agent

Usage:
  cmux-team kill-agent --surface <surface>

Options:
  --surface <surface>     要停止的 Agent 的 surface ID（必填）

Examples:
  cmux-team kill-agent --surface surface:215
`,

  help_send_agent: `
cmux-team send-agent -- 向此 Conductor 生成的 Agent 发送消息

Usage:
  cmux-team send-agent --surface <agent-surface> [--no-return] <message>

Options:
  --surface <agent-surface>   目标 Agent 的 surface（必填）
  --no-return                 发送后不发送 Enter 键
  <message>                   消息正文（需用引号括起）

Environment:
  CMUX_SURFACE                调用方 Conductor 的 surface（未设置时使用 cmux identify）

Examples:
  cmux-team send-agent --surface surface:382 "请从 plan.md 第 3 节继续"
  cmux-team send-agent --surface surface:382 --no-return "部分内容"

Notes:
  - 仅允许向调用方 Conductor 生成的 Agent 发送（通过 .team/team.json 验证）
  - 自发送和其他 Conductor 的 Agent 会被拒绝
  - 如果 Agent 尚未在 team.json 中注册，将重试最多 5 次（每次间隔 200ms）
`,

  help_create_task: `
cmux-team create-task -- 创建任务

Usage:
  cmux-team create-task --title <title> [options]

Options:
  --title <title>         任务标题（必填）
  --body <text>           任务正文（可选）
  --priority <priority>   优先级: high / medium / low（可选，默认 medium）
  --status <status>       初始状态: draft / ready（可选，默认 draft）
  --depends-on <ids>      依赖任务 ID（逗号分隔，例: "081,082"）（可选）
  --base-branch <branch>  合并目标分支（可选，默认: 未指定 → 合并到 main）
  --agent <type>          Agent CLI 指定: claude / ft-claude / codex / gemini / opencode（可选）
  --run-after-all         在所有常规任务完成后运行（可选）

Examples:
  cmux-team create-task --title "修复 Bug" --status ready --body "登录页面错误"
  cmux-team create-task --title "新增功能" --priority high
  cmux-team create-task --title "重构" --depends-on "081,082" --status ready
  cmux-team create-task --title "hotfix" --base-branch develop --status ready
  cmux-team create-task --title "发布 v3.5.0" --run-after-all --status ready
  cmux-team create-task --title "竞品调研" --agent gemini --status ready

Notes:
  - 如果 status 为 ready，将自动发送 TASK_CREATED 消息，
    daemon 会将其分配给空闲的 Conductor
  - 如果为 draft，则不会被分配。使用 update-task --status ready 启动
  - --run-after-all 任务在系统中只能存在一个（如果已有未关闭的
    run_after_all 任务则报错）
  - run_after_all 任务会在所有常规任务 closed 后自动执行
`,

  help_update_task: `
cmux-team update-task -- 更新任务

Usage:
  cmux-team update-task --task-id <id> [options]

Options:
  --task-id <id>          任务 ID（必填）
  --status <status>       新状态（可选）
  --title <title>         新标题（可选）
  --body <text>           新正文（可选）
  --depends-on <ids>      依赖任务 ID（逗号分隔，例: "081,082"）（可选）

  ※ --status, --title, --body, --depends-on 至少需要指定一个

Examples:
  cmux-team update-task --task-id 035 --status ready
  cmux-team update-task --task-id 035 --title "新标题" --body "新描述"
  cmux-team update-task --task-id 035 --depends-on "081,082"

Notes:
  - assigned（运行中）的任务无法更新
  - closed 的任务无法更新（请创建新任务）
  - 将 status 改为 ready 时会自动发送 TASK_CREATED 消息
`,

  help_close_task: `
cmux-team close-task -- 将任务标记为完成（closed）

Usage:
  cmux-team close-task --task-id <id> [options]

Options:
  --task-id <id>          任务 ID（必填）
  --journal <text>        完成日志（可选，正常完成时记录）
  --force                 强制关闭运行中的任务（可选标志）

Examples:
  cmux-team close-task --task-id 035 --journal "实现完成，测试通过"
  cmux-team close-task --task-id 035 --force

Notes:
  - assigned（运行中）的任务需要 --journal 或 --force
  - task-state.json 中的 status 将设为 closed
`,

  help_abort_task: `
cmux-team abort-task -- 中止运行中的任务（设为 aborted）

Usage:
  cmux-team abort-task --task-id <id> [--journal <text>]

Options:
  --task-id <id>          任务 ID（必填）
  --journal <text>        中止日志（可选，默认: "中止: T{id} {title}"）

Examples:
  cmux-team abort-task --task-id 035
  cmux-team abort-task --task-id 035 --journal "因方向变更而中止"

Notes:
  - 仅 assigned（运行中）的任务可以中止
  - 停止 Conductor 的子 Agent 和 Conductor 本身
  - 删除 worktree 并将任务状态改为 aborted
  - Conductor 会自动重启为 idle 状态
`,

  help_restart_task: `
cmux-team restart-task -- 重启运行中的任务（恢复为 ready）

Usage:
  cmux-team restart-task --task-id <id> [--journal <text>]

Options:
  --task-id <id>          任务 ID（必填）
  --journal <text>        重启日志（可选，默认: "重启: T{id} {title}"）

Examples:
  cmux-team restart-task --task-id 035
  cmux-team restart-task --task-id 035 --journal "Conductor 崩溃，重新执行"

Notes:
  - 仅 assigned（运行中）的任务可以重启
  - 执行与 abort-task 相同的清理操作（停止 Agent、删除 worktree）
  - 将状态恢复为 ready 而非 aborted
  - 通过 TASK_CREATED 通知自动重新分配
`,

  help_delete_task: `
cmux-team delete-task -- 删除任务（设为 deleted）

Usage:
  cmux-team delete-task --task-id <id> [options]

Options:
  --task-id <id>          任务 ID（必填）
  --journal <text>        删除日志（可选，默认: "删除: T{id} {title}"）

Examples:
  cmux-team delete-task --task-id 035
  cmux-team delete-task --task-id 035 --journal "不再需要，予以删除"

Notes:
  - 仅 draft/ready 的任务可以删除（assigned 任务请使用 abort-task）
  - task-state.json 中的 status 将设为 deleted
  - 日志中会保留记录
`,

  help_trace_task: `
cmux-team trace-task -- 显示任务的会话历史

Usage:
  cmux-team trace-task <task-id> [options]

Options:
  --summary              摘要模式（未来扩展预留）

Examples:
  cmux-team trace-task 141
  cmux-team trace-task 141 --summary
`,

  help_conductor: `
cmux-team conductor -- 启动 Conductor 用 Claude Code（内部命令）

Usage:
  cmux-team conductor [--model <model>]

Environment:
  CMUX_SURFACE  Conductor 的 surface ID（必填，由 daemon 设置）

Options:
  --model <model>   使用的模型（默认: config.models.conductor or "{model}"）

Notes:
  - daemon 启动时自动调用的内部命令
  - 动态解析日志代理端口并 exec Claude Code
  - 以 --dangerously-skip-permissions 启动
`,

  help_spawn_master: `
cmux-team spawn-master -- 启动 Master 用 Claude Code（内部命令）

Usage:
  cmux-team spawn-master [--model <model>]

Options:
  --model <model>   使用的模型（默认: config.models.master or "{model}"）

Notes:
  - daemon 启动时自动调用的内部命令
  - 动态解析日志代理端口并 exec Claude Code
  - 生成 Master 提示词后以 --dangerously-skip-permissions 启动
`,

  help_artifacts: `
cmux-team artifacts -- Artifact 管理

Usage:
  cmux-team artifacts [subcommand] [options]

Subcommands:
  （无）                  显示 Artifact 列表（默认）
  add <file>             将文件添加为 Artifact
  show <id>              显示 Artifact 内容
  open <id>              在 Markdown 查看器中打开 Artifact
  search <query>         全文搜索 Artifact

Options:
  --type <type>           按类型筛选: research / decision / session / spec / report（可选）
  --task <id>             按关联任务 ID 筛选（可选）
  --sort <field>          排序方式: created / updated（可选，默认 created）
  --validate              验证所有 Artifact 的 frontmatter
  --type <type>           (add) Artifact 类型: research / decision / session / spec / report
  --title <title>         (add) Artifact 标题
  --task <id>             (add) 关联任务 ID
  --tags <tag1,tag2>      (add) 逗号分隔的标签

Examples:
  cmux-team artifacts
  cmux-team artifacts add ./research-notes.md
  cmux-team artifacts add ./design.md --type decision --title "认证方式选型"
  cmux-team artifacts show A001
  cmux-team artifacts open A001
  cmux-team artifacts search "认证"
  cmux-team artifacts --type research --task T038
  cmux-team artifacts --validate
`,

  help_await_task: `
cmux-team await-task -- 等待任务完成（closed/aborted）

Usage:
  cmux-team await-task --task-id <id> [options]

Options:
  --task-id <id>          任务 ID（必填，逗号分隔可指定多个: 108,109）
  --timeout <seconds>     超时秒数（默认: 3600）

完成时的行为:
  - closed: 将 summary.md 输出到 stdout，退出码 0
  - aborted: 将中止原因输出到 stderr，退出码 1
  - timeout: 将超时消息输出到 stderr，退出码 2

Examples:
  cmux-team await-task --task-id 108
  cmux-team await-task --task-id 108,109 --timeout 7200
`,

  help_main: `cmux-team — 多 Agent 开发编排系统

Usage:
  cmux-team start                              启动 daemon + 生成 Master
  cmux-team send TASK_CREATED --task-id <id> --task-file <path>
  cmux-team send SHUTDOWN
  cmux-team status                             显示状态
  cmux-team stop                               优雅关闭
  cmux-team spawn-conductor
  cmux-team spawn-agent --conductor-surface <surface> --role <role> --prompt <prompt>
  cmux-team agents                             运行中 Agent 列表
  cmux-team kill-agent --surface <surface>
  cmux-team send-agent --surface <surface> <message>    向 Agent 发送消息
  cmux-team create-task --title <title> [--priority <p>] [--status <s>] [--body <text>] [--depends-on <ids>] [--run-after-all]
  cmux-team update-task --task-id <id> --status <status>
  cmux-team close-task --task-id <id> [--journal <text>]
  cmux-team await-task --task-id <id> [--timeout <sec>]    等待任务完成
  cmux-team abort-task --task-id <id> [--journal <text>] 中止运行中的任务
  cmux-team restart-task --task-id <id> [--journal <text>] 重启运行中的任务
  cmux-team delete-task --task-id <id> [--journal <text>] 删除任务
  cmux-team trace-task <task-id>              显示任务会话历史
  cmux-team conductor                          启动 Conductor（自动解析 proxy）
  cmux-team spawn-master                      启动 Master（自动解析 proxy）
  cmux-team artifacts                              Artifact 列表
  cmux-team artifacts add <file>                   将文件添加为 Artifact
  cmux-team artifacts show <id>                    显示 Artifact
  cmux-team artifacts open <id>                    在 Markdown 查看器中打开
  cmux-team artifacts search <query>               全文搜索
  cmux-team artifacts --validate                   验证 frontmatter

各命令详情: cmux-team <command> --help`,
};

const messages = { en, zh };

/**
 * 根据语言环境返回对应消息。
 * 传入 vars 时将替换 {key} 占位符。
 */
export function t(key: keyof typeof en, vars?: Record<string, string>): string {
  const str = messages[locale][key] ?? messages.en[key] ?? key;
  if (!vars) return str;
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), str);
}
