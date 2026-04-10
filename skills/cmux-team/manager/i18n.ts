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
  search_query_required:
    "Error: search query is required\nUsage: cmux-team artifacts search <query>",
  dashboard_startup_hint:
    "Hint: Run 'cmux-team start' in a TTY environment",
  task_section_header: "Task",

  // ── テンプレートメッセージ（tf() で変数展開） ────────────────────────────────
  artifact_not_found: "Artifact {id} not found",
  no_artifacts_matching: 'No artifacts matching "{query}"',
  dashboard_startup_failed: "❌ Dashboard startup failed: {message}",
  abort_journal_default: "Aborted: T{id} {title}",
  restart_journal_default: "Restarted: T{id} {title}",
  delete_journal_default: "Deleted: T{id} {title}",

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

Examples:
  cmux-team create-task --title "Fix bug" --status ready --body "Login screen error"
  cmux-team create-task --title "Add feature" --priority high
  cmux-team create-task --title "Refactor" --depends-on "081,082" --status ready
  cmux-team create-task --title "hotfix" --base-branch develop --status ready
  cmux-team create-task --title "Release v3.5.0" --run-after-all --status ready

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

  * At least one of --status, --title, or --body is required

Examples:
  cmux-team update-task --task-id 035 --status ready
  cmux-team update-task --task-id 035 --title "New title" --body "New description"

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

  help_trace: `
cmux-team trace -- search and display API traces

Usage:
  cmux-team trace [options]

Options:
  --task <id>             filter by task ID (optional)
  --conductor <surface>   filter by Conductor surface (optional)
  --role <role>           filter by role name (optional)
  --search <query>        FTS5 full-text search (optional)
  --show <id>             show details for a trace ID (optional)
  --limit <N>             number of results to show (optional, default 20)

Examples:
  cmux-team trace --task 035
  cmux-team trace --search "error"
  cmux-team trace --show 42
  cmux-team trace --role researcher --limit 50
`,

  help_conductor: `
cmux-team conductor -- launch Claude Code for Conductor (internal use)

Usage:
  cmux-team conductor <slot-id> [--model <model>]

Arguments:
  <slot-id>     Conductor slot ID (required)

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
  show <id>              show artifact content
  search <query>         full-text search artifacts

Options:
  --type <type>           filter by type: research / decision / session / spec / report (optional)
  --task <id>             filter by related task ID (optional)
  --sort <field>          sort by: created / updated (optional, default created)
  --validate              validate frontmatter of all artifacts

Examples:
  cmux-team artifacts
  cmux-team artifacts show A001
  cmux-team artifacts search "authentication"
  cmux-team artifacts --type research --task T038
  cmux-team artifacts --validate
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
  cmux-team create-task --title <title> [--priority <p>] [--status <s>] [--body <text>] [--depends-on <ids>] [--run-after-all]
  cmux-team update-task --task-id <id> --status <status>
  cmux-team close-task --task-id <id> [--journal <text>]
  cmux-team abort-task --task-id <id> [--journal <text>]  abort a running task
  cmux-team restart-task --task-id <id> [--journal <text>] restart a running task
  cmux-team delete-task --task-id <id> [--journal <text>] delete a task
  cmux-team trace --task <id>                  filter traces by task ID
  cmux-team trace --search <query>             FTS5 full-text search
  cmux-team trace --show <id>                  show trace details
  cmux-team conductor <slot-id>                launch Conductor (auto-resolves proxy)
  cmux-team spawn-master                       launch Master (auto-resolves proxy)
  cmux-team artifacts                              list artifacts
  cmux-team artifacts show <id>                    show artifact
  cmux-team artifacts search <query>               full-text search
  cmux-team artifacts --validate                   validate frontmatter

For details on each command: cmux-team <command> --help`,
};

const ja: typeof en = {
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
  search_query_required:
    "Error: 検索クエリを指定してください\nUsage: cmux-team artifacts search <query>",
  dashboard_startup_hint:
    "ヒント: TTY 環境で cmux-team start を実行してください",
  task_section_header: "タスク",

  // ── テンプレートメッセージ ────────────────────────────────────────────────────
  artifact_not_found: "アーティファクト {id} が見つかりません",
  no_artifacts_matching: '"{query}" に一致するアーティファクトが見つかりません',
  dashboard_startup_failed: "❌ ダッシュボード起動失敗: {message}",
  abort_journal_default: "中断: T{id} {title}",
  restart_journal_default: "再実行: T{id} {title}",
  delete_journal_default: "削除: T{id} {title}",

  // ── Conductor 待機プロンプト ───────────────────────────────────────────────────
  conductor_wait_prompt:
    "あなたは Conductor スロットです。Manager が /clear + プロンプト送信でタスクを割り当てるまで、何もせず ❯ プロンプトで待機してください。タスクの検索・読み取り・実行は一切行わないこと。",

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
  cmux-team start

Options:
  なし

Notes:
  - cmux 環境内で実行する必要があります（CMUX_SOCKET_PATH が必要）
  - daemon + ロギングプロキシ + 2x2 レイアウト（Conductor x3）+ Master を起動します
  - ダッシュボードが表示され、キーボードショートカットで操作できます
`,

  help_send: `
cmux-team send -- キューにメッセージを送信

Usage:
  cmux-team send <type> [options]

Types と必須/任意オプション:
  TASK_CREATED
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
    --pane-id <pane-id>     ペイン ID（任意）

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
    --conductor-id <id>     Conductor ID（任意）
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
`,

  help_stop: `
cmux-team stop -- daemon を graceful shutdown する

Usage:
  cmux-team stop

Options:
  なし

Notes:
  - SHUTDOWN メッセージをキューに送信し、daemon が受信して停止します
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

Examples:
  cmux-team create-task --title "バグ修正" --status ready --body "ログイン画面のエラー"
  cmux-team create-task --title "新機能追加" --priority high
  cmux-team create-task --title "リファクタ" --depends-on "081,082" --status ready
  cmux-team create-task --title "hotfix" --base-branch develop --status ready
  cmux-team create-task --title "リリース v3.5.0" --run-after-all --status ready

Notes:
  - status が ready の場合、TASK_CREATED メッセージが自動送信され、
    daemon が idle Conductor に割り当てます
  - draft の場合は割り当てされません。update-task --status ready で開始できます
  - --run-after-all タスクはシステム内に1つだけ存在可能です（未クローズの
    run_after_all タスクがあるとエラーになります）
  - run_after_all タスクは全通常タスクが closed になった後に自動実行されます
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

  ※ --status, --title, --body のうち少なくとも1つが必要

Examples:
  cmux-team update-task --task-id 035 --status ready
  cmux-team update-task --task-id 035 --title "新タイトル" --body "新しい説明"

Notes:
  - assigned（実行中）のタスクは更新できません
  - closed のタスクは更新できません（新しいタスクを作成してください）
  - status を ready に変更すると TASK_CREATED メッセージが自動送信されます
`,

  help_close_task: `
cmux-team close-task -- タスクを完了（closed）にする

Usage:
  cmux-team close-task --task-id <id> [options]

Options:
  --task-id <id>          タスク ID（必須）
  --journal <text>        完了ジャーナル（任意、正常完了時に記録）
  --force                 実行中のタスクを強制クローズ（任意フラグ）

Examples:
  cmux-team close-task --task-id 035 --journal "実装完了、テストパス"
  cmux-team close-task --task-id 035 --force

Notes:
  - assigned（実行中）のタスクは --journal または --force が必要です
  - task-state.json の status が closed に設定されます
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
cmux-team restart-task -- 実行中タスクを再実行（ready に戻す）

Usage:
  cmux-team restart-task --task-id <id> [--journal <text>]

Options:
  --task-id <id>          タスク ID（必須）
  --journal <text>        再実行ジャーナル（任意、デフォルト: "再実行: T{id} {title}"）

Examples:
  cmux-team restart-task --task-id 035
  cmux-team restart-task --task-id 035 --journal "Conductor がクラッシュしたため再実行"

Notes:
  - assigned（実行中）のタスクのみ再実行できます
  - abort-task と同じクリーンアップを実行（エージェント停止、worktree 削除）
  - ステータスを aborted ではなく ready に戻します
  - TASK_CREATED 通知により自動再割り当てされます
`,

  help_delete_task: `
cmux-team delete-task -- タスクを削除（deleted）にする

Usage:
  cmux-team delete-task --task-id <id> [options]

Options:
  --task-id <id>          タスク ID（必須）
  --journal <text>        削除ジャーナル（任意、デフォルト: "削除: T{id} {title}"）

Examples:
  cmux-team delete-task --task-id 035
  cmux-team delete-task --task-id 035 --journal "不要になったため削除"

Notes:
  - draft/ready のタスクのみ削除できます（assigned は abort-task を使用）
  - task-state.json の status が deleted に設定されます
  - Journal タブに記録が残ります
`,

  help_trace: `
cmux-team trace -- API トレースの検索・表示

Usage:
  cmux-team trace [options]

Options:
  --task <id>             タスク ID でフィルタ（任意）
  --conductor <surface>   Conductor surface でフィルタ（任意）
  --role <role>           ロール名でフィルタ（任意）
  --search <query>        FTS5 全文検索（任意）
  --show <id>             トレース ID の詳細表示（任意）
  --limit <N>             表示件数（任意、デフォルト 20）

Examples:
  cmux-team trace --task 035
  cmux-team trace --search "エラー"
  cmux-team trace --show 42
  cmux-team trace --role researcher --limit 50
`,

  help_conductor: `
cmux-team conductor -- Conductor 用 Claude Code を起動（内部用）

Usage:
  cmux-team conductor <slot-id> [--model <model>]

Arguments:
  <slot-id>     Conductor のスロット ID（必須）

Options:
  --model <model>   使用するモデル（デフォルト: config.models.conductor or "{model}"）

Notes:
  - daemon が起動時に自動的に呼び出す内部コマンドです
  - ロギングプロキシのポートを動的に解決して Claude Code を exec します
  - --dangerously-skip-permissions で起動されます
`,

  help_spawn_master: `
cmux-team spawn-master -- Master 用 Claude Code を起動（内部用）

Usage:
  cmux-team spawn-master [--model <model>]

Options:
  --model <model>   使用するモデル（デフォルト: config.models.master or "{model}"）

Notes:
  - daemon が起動時に自動的に呼び出す内部コマンドです
  - ロギングプロキシのポートを動的に解決して Claude Code を exec します
  - Master プロンプトを生成してから --dangerously-skip-permissions で起動されます
`,

  help_artifacts: `
cmux-team artifacts -- アーティファクト管理

Usage:
  cmux-team artifacts [subcommand] [options]

Subcommands:
  (なし)                  アーティファクト一覧表示（デフォルト）
  show <id>              アーティファクトの内容を表示
  search <query>         アーティファクトを全文検索

Options:
  --type <type>           タイプでフィルタ: research / decision / session / spec / report（任意）
  --task <id>             関連タスク ID でフィルタ（任意）
  --sort <field>          ソート基準: created / updated（任意、デフォルト created）
  --validate              全アーティファクトのフロントマターを検証

Examples:
  cmux-team artifacts
  cmux-team artifacts show A001
  cmux-team artifacts search "認証"
  cmux-team artifacts --type research --task T038
  cmux-team artifacts --validate
`,

  help_main: `cmux-team — マルチエージェント開発オーケストレーション

Usage:
  cmux-team start                              daemon 起動 + Master spawn
  cmux-team send TASK_CREATED --task-id <id> --task-file <path>
  cmux-team send SHUTDOWN
  cmux-team status                             ステータス表示
  cmux-team stop                               graceful shutdown
  cmux-team spawn-conductor
  cmux-team spawn-agent --conductor-surface <surface> --role <role> --prompt <prompt>
  cmux-team agents                             稼働中エージェント一覧
  cmux-team kill-agent --surface <surface>
  cmux-team create-task --title <title> [--priority <p>] [--status <s>] [--body <text>] [--depends-on <ids>] [--run-after-all]
  cmux-team update-task --task-id <id> --status <status>
  cmux-team close-task --task-id <id> [--journal <text>]
  cmux-team abort-task --task-id <id> [--journal <text>] 実行中タスクを中止
  cmux-team restart-task --task-id <id> [--journal <text>] 実行中タスクを再実行
  cmux-team delete-task --task-id <id> [--journal <text>] タスクを削除
  cmux-team trace --task <id>                  トレースをタスクIDでフィルタ
  cmux-team trace --search <query>             FTS5 全文検索
  cmux-team trace --show <id>                  トレース詳細表示
  cmux-team conductor <slot-id>                Conductor 起動（proxy 自動解決）
  cmux-team spawn-master                      Master 起動（proxy 自動解決）
  cmux-team artifacts                              アーティファクト一覧
  cmux-team artifacts show <id>                    アーティファクト表示
  cmux-team artifacts search <query>               全文検索
  cmux-team artifacts --validate                   フロントマター検証

各コマンドの詳細: cmux-team <command> --help`,
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
