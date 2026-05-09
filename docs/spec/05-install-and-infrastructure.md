# Seed: Install & Infrastructure

---

## 配布方法

### 1. npm パッケージ（推奨）

```bash
npm install -g @hummer98/cmux-team
```

`postinstall` スクリプトにより:
1. `bun install` で manager/ の依存関係を解決
2. `claude plugin add hummer98/cmux-team` で Plugin を登録
3. `skills/cmux-team/manager/statusline.sh` を `~/.claude/statusline.sh` にコピー（proxy `POST /statusline` に stdin を転送する curl ラッパー、T211）

### 2. Claude Code Plugin

`.claude-plugin/plugin.json`（npm パッケージ内に同梱）で定義。`postinstall` で自動登録される。

```json
{
  "name": "cmux-team",
  "version": "3.45.0",
  "description": "Multi-agent development orchestration with Claude Code + cmux.",
  "skills": "./skills/",
  "commands": "./commands/",
  "hooks": {
    "SessionStart": [...],
    "PreToolUse": [...]
  }
}
```

**Plugin hooks:**
- **SessionStart**: cmux 環境外での起動時にタブ名をリネーム
- **PreToolUse (Write|Edit)**: `team.json` と `task-state.json` への直接編集をブロック（daemon 管理ファイルの保護）

Conductor・Agent・Master 起動時は環境変数 `CMUX_CLAUDE_HOOKS_DISABLED=1` で cmux ラッパー側の hook を無効化し、Manager が生成する `conductor-settings.json` を `claude --settings` 経由で動的に注入する（hook 設定の優先順位問題への対応）。Agent spawn 時は `spawn-agent` CLI 内で、Master 起動時は `spawn-master` CLI 内でそれぞれ設定される。これが authoritative な注入経路であり、`cmux-team` 経由の spawn では `.envrc` / `direnv` への依存は不要。

### 3. オプション依存ツール

| ツール | 用途 | 未インストール時の挙動 |
|---|---|---|
| `mado` | `cmux-team artifacts open` の Markdown viewer (T439)。Electrobun ベース GUI viewer (yamamoto/mado) | `cat` にフォールバック（TUI 一時停止）。dashboard の Artifacts タブから `Enter` でも同経路 |
| `pbcopy` | Artifacts タブの `c c` チョードによる絶対パスコピー (T439)。macOS 標準ツール | dashboard 上で失敗 toast `✗ pbcopy not available` を表示。Linux 環境では未対応 |

`CMUX_TEAM_MD_VIEWER` env を設定すると `mado` 検出をバイパスして任意のコマンドを viewer として使える（GUI 想定で detached 起動。TUI viewer を使いたい場合は `cat` を指定する）。

---

## npm パッケージ構成

### package.json

```json
{
  "name": "@hummer98/cmux-team",
  "version": "3.45.0",
  "bin": { "cmux-team": "bin/cmux-team" },
  "scripts": {
    "postinstall": "node bin/postinstall.js",
    "prepublishOnly": "cd skills/cmux-team/manager && bun test"
  },
  "engines": { "node": ">=18" }
}
```

### bin/cmux-team

CLI ラッパー（bash）。`bun run skills/cmux-team/manager/main.ts` を `exec` で起動する。

- `bun` の存在を確認（未インストール時はエラー）
- 全サブコマンド共通で `exec bun run main.ts "$@"`（bash 自身を bun に置換し、node 親プロセスを介さない）
- `manager/main.ts` を絶対パスで解決（symlink 経由のグローバルインストールに対応。macOS の `readlink -f` 非対応のため while ループで手動辿り）

### bin/postinstall.js

npm postinstall スクリプト。

1. `bun install` で manager/ の依存関係を解決（bun 未インストール時は手動実行を案内）
2. `claude plugin add hummer98/cmux-team` で Plugin を登録（claude 未インストール時は手動実行を案内）

---

## Manager Daemon（TypeScript）

### ディレクトリ構成

```
skills/cmux-team/manager/
├── main.ts          # CLI エントリーポイント（多数のサブコマンド、cmux-team --help 参照）
├── daemon.ts        # イベント駆動ステートマシン + メインループ
├── master.ts        # Master surface 起動 + `.team/masters/<normalized>.json` の永続化（T229）
├── conductor.ts     # Conductor ライフサイクル管理
├── task.ts          # タスクファイルパース + 依存解決
├── proxy.ts         # API ロギングプロキシ
├── trace-store.ts   # SQLite FTS5 トレースDB
├── artifact.ts      # アーティファクト管理
├── schema.ts        # Zod 型定義
├── template.ts      # プロンプトテンプレート検索・生成
├── logger.ts        # 追記型ログ
├── cmux.ts          # cmux CLI ラッパー
├── eventBus.ts      # state mutation → TUI refresh の EventEmitter ラッパー
├── exec-error.ts    # execFile エラーの正規化（stderr/stdout 保存）
├── envrc-prompt.ts  # 初回起動時の .envrc 追記対話
├── preflight.ts     # 起動前チェック（bun / cmux / claude 等）
├── i18n.ts          # 日英ロケール切替
├── dashboard.tsx    # React (ink) TUI ダッシュボード
├── e2e.ts           # E2E テストランナー
├── statusline.sh    # statusline curl wrapper（postinstall で ~/.claude/ に配置、proxy POST /statusline に転送）
├── statusline.ts    # statusline フォーマッタ本体（T211、proxy から呼び出される純関数群）
├── *.test.ts        # ユニットテスト（daemon / proxy / task / cmux / eventBus など）
├── package.json     # 依存: ink, react, zod, update-notifier, @rezi-ui/core, @rezi-ui/node
└── tsconfig.json
```

メッセージキューはファイルベースから HTTP API（プロキシ経由）に移行済みのため、`queue.ts` は廃止されている。

### CLI サブコマンド

| コマンド | 説明 |
|---------|------|
| `start` | daemon 起動 + Master spawn + Conductor スロット初期化 + TUI + プロキシ（`--layout=<wide\|16x9>` でレイアウト指定） |
| `send <TYPE>` | メッセージ投入（TASK_CREATED, CONDUCTOR_DONE, SHUTDOWN 等） |
| `status` | daemon ステータス表示（conductor、タスク数、ログ末尾） |
| `stop` | グレースフルシャットダウン |
| `spawn-conductor` | 単一 Conductor の起動・登録 |
| `spawn-agent` | Agent タブ作成 + Claude 起動 + プロキシ設定 + Trust 承認 |
| `agents` | 稼働中エージェント一覧 |
| `kill-agent` | Agent surface close + AGENT_DONE メッセージ |
| `create-task` | タスクファイル作成 + task-state.json 初期エントリー（`--depends-on`, `--base-branch`, `--run-after-all` をサポート） |
| `update-task` | タスク更新（`--status` / `--title` / `--body` / `--depends-on`、draft → ready で TASK_CREATED トリガー） |
| `close-task` | タスクを closed にマーク + deliverable（納品方式）保存 + journal 保存 + CONDUCTOR_DONE 送信。T295 以降 `--deliverable-kind <files\|merged\|pr\|none>` が必須で、kind ごとに付随フラグが異なる（`--deliverable <path>` / `--merged-into <branch> --merge-sha <sha>` / `--pr-url <url>`）。`--force` で実行中も強制クローズ可能 |
| `abort-task` | 実行中タスクの中止（sub-agent 停止 → Conductor 停止 → worktree 削除 → `aborted` 遷移 → Conductor 再起動） |
| `delete-task` | draft/ready タスクの削除（`deleted` 遷移、journal 記録）。`assigned` のタスクは `abort-task` を使う |
| `trace` | トレースDB 検索・表示（`--task`, `--search`, `--show`, `--conductor`, `--role`, `--limit`） |
| `trace-hooks` | `hook_signals` テーブル検索・表示（`--type`, `--surface`, `--task-run`, `--limit`（デフォルト 50）, `--json`）。T217 |
| `conductor` | Conductor 情報表示 |
| `spawn-master` | Master surface 起動 + `MASTER_REGISTERED` self-register POST（T230、daemon 未起動時は fail-fast exit 1） |
| `artifacts` | アーティファクト一覧・検索・追加（`add`）・表示（`show`）・Markdown ビューア（`open`） |
| `resume` | assigned タスクの Conductor セッションを `claude --resume` で再開 |
| `restart-task` | `assigned` / `aborted` タスクの Conductor セッションを再起動（T204 で `aborted` からの再開にも対応。status は `ready` に戻され、worktree / taskRunId / sessionId 等の割り当て情報はクリアされる。`aborted` の場合は残存 worktree も強制削除） |
| `await-task` | タスク完了を fs.watch で待機（カンマ区切りで複数指定可、`--timeout` サポート） |
| `await-agent` | Agent 完了/ask/crash を done マーカーの fs.watch で待機（T181、Conductor から使用） |
| `send-agent` | Agent/Conductor surface へメッセージ送信（`--surface`, positional message, `--no-return`）。Conductor → 他 surface 操作の唯一の入口 |
| `trace-task` | 特定タスクのセッション履歴を分析 |

### Project root 解決（Task 440）

すべての CLI コマンドは module-level で project root を解決してから dispatch する。
解決順位は次の 4 段で、上位ほど strict（不在で exit 1）になる。

| 優先 | source | 振る舞い |
|------|--------|---------|
| 1 | `--project-root <path>` flag | 最優先 + strict。path 不在 → exit 1 (`error: project root not found: <path>`)。`<path>/.team/` 不在 → exit 1 (`error: not a cmux-team project: <path>`)。flag が指定されたら env は無視される |
| 2 | `PROJECT_ROOT` env | 後方互換。path 不在は黙ってフォールバック（warn のみ）。throw しない |
| 3 | cwd up-walk（最大 10 階層） | `.team/` を含む最近接 dir を採用 |
| 4 | `process.cwd()` fallback | 最後の手段 |

flag 経由で resolve した場合、`process.env.PROJECT_ROOT` も flag 由来値で再上書きされ、
子プロセス（spawn-conductor / spawn-master / spawn-agent）にも継承される。

#### Write gate（cross-project 書き込み防止）

`--project-root` で指定した root が cwd-walk 結果と異なる状態で write 系コマンド
（`start`, `create-task`, `update-task`, `close-task`, `abort-task`, `restart-task`, `delete-task`,
`spawn-conductor`, `spawn-agent`, `spawn-master`, `send`, `send-agent`, `kill-agent`, `close-agent`,
`clear-conductor`, `set-agent-instructions`, `delete-agent-instructions`, `artifacts add`,
`token add|remove|rotate|set-plan|promote|migrate-subscription`）を実行すると、
事故防止の確認 gate が発火する。

判定: target / cwd を `realpathSync` で正規化した strict 文字列比較（symlink 差を吸収）。

| 状況 | 振る舞い |
|------|---------|
| TTY なし（pipe stdin / CI） | exit 1 + stderr に `error: --project-root differs from cwd` |
| TTY あり | `WARNING: writing to <target> (different from cwd). continue? (y/N)` を表示 |

bypass 経路:
- `--project-root-confirm` flag（一回限り、shell 履歴で意図的と判定可能）
- `CMUX_TEAM_PROJECT_ROOT_CONFIRM=1` env（CI / 自動化向け、子プロセスに継承される）

read 系コマンド（`status`, `agents`, `events`, `metrics`, `trace-task`, `trace-hooks`,
`await-task`, `await-agent`, `get-agent-instructions`, `list-agent-instructions`,
`pool status`, `gh`, `issue`, `pr` 等）は gate 対象外。

### メインループ

```
while (state.running):
  1. processQueue()          # キューメッセージ処理
  2. scanTasks()             # ready タスクを検出 → idle Conductor に割り当て
  3. monitorConductors()     # done マーカー検出、クラッシュ検出
  4. updateTeamJson()        # team.json を最新状態に同期
  5. updateSidebarStatus()   # cmux サイドバーにステータスを反映
  6. sleep(pollInterval)     # デフォルト10秒
```

ファイルシステム監視（tasks/）と HTTP メッセージ通知により変更検出時は即時 tick を実行。
proxy ポートが変わった場合は Master を再接続する。

daemon は起動時に呼び出し元の workspace を `state.workspace` に記録し、`cmux tree` / `validateSurface` には常に workspace を渡して別ワークスペースの surface ID と混同しないようにする。起動時にワークスペース名を `basename(PROJECT_ROOT)`（起動フォルダ名）に自動設定する（`cmux rename-workspace`）。

Conductor が worktree を初期化する際には `.claude/settings.local.json` をワークツリー側にコピーし（`skills/cmux-team/manager/conductor.ts` の worktree 作成フロー）、サブエージェントが同じローカル設定で動作するようにする。`CMUX_CLAUDE_HOOKS_DISABLED=1` は Conductor / Agent / Master の spawn 時に explicit な `export` として注入されるため、worktree 側での `.envrc` 生成や `direnv` 実行は行わない。

#### assigned タスクの resume（T421 以降）

T421 以降、Conductor は「pane に常駐し `/clear` で再利用」する旧方式から「タスク開始時に kill+spawn される」新方式に変更された。daemon 起動時（boot 完了後）に `task-state.json` で `status: assigned` のタスクを検出し、以下の条件を満たす場合は Manager が該当 Conductor ペインの shell 側で直接 `cmux-team spawn-conductor --resume <session-id>` を実行する（Conductor ペインに該当文字列を `cmux send` で打ち込む方式は禁止。既に Claude が起動していると chat 入力として扱われてしまうため）:

1. `sessionId` が記録されている
2. `worktreePath` が存在する
3. `taskRunId` が記録されている

条件を満たさない場合は `ready` に戻して通常の再割り当てにフォールバックする。既に同じタスクを実行中の Conductor がいる場合はスキップ（多重実行防止）。

`spawn-conductor --resume <session-id>` は `claude --resume <sessionId>` でセッションを再開する。設定は通常起動と同等（`--dangerously-skip-permissions`, `--settings`, `--model`）。作業ディレクトリは `worktreePath` を使用。

#### launch command 不変条件（task 446）

Master / Conductor を spawn する際に shell に投入する文字列は、**ペイン shell の現在 cwd に依らず project root から `cmux-team spawn-{master,conductor} [args]` を実行する**形に構造的に保証される。

```
cd '<PROJECT_ROOT>' && cmux-team spawn-{master,conductor} [args]
```

**背景**: cmux で split した新ペインの初期 cwd は親ペインのカレントディレクトリに依存する。親ペインが `~/git` など project root の外にいると、ペイン側の `direnv` が別の `.envrc` をロードし `PROJECT_ROOT` 環境変数が汚染される。これにより `findProjectRoot()` が誤った path を返し daemon 接続に失敗する（`carta` workspace で確認された障害）。

**実装**: `skills/cmux-team/manager/util.ts` の `buildLaunchCommand(projectRoot, command)` が `cd '<root>' && <command>` 形式の文字列を生成する。`projectRoot` は絶対パス必須（非絶対パスは throw）。`shellQuote` により path 中の `'` は POSIX `'\''` escape で安全に処理される。

**適用箇所**: `master.ts:spawnMaster` / `conductor.ts:launchConductor` (resume + 新規 2 経路) / `conductor.ts:assignTask` / `main.ts:cmdAbortTask` / `main.ts:cmdRestartTask` の全送信経路が `buildLaunchCommand` を経由する。`claude-code-backend.ts` は launchCmd を透過する adapter であり project root を持たない（責務分離）。

#### サイドバーステータスのリアルタイム更新

メインループの各 tick で `cmux set-status` / `cmux clear-status` を通じてサイドバーにステータスを表示する。差分抑制（前回値と同一なら API 呼び出しスキップ）を行う。

| カテゴリ | 条件 | 表示 | アイコン | 色 |
|---------|------|------|---------|-----|
| error | disconnected Conductor あり | `! attention` | exclamationmark.triangle | 赤 |
| throttled | 5h utilization ≥ 90% or rate_limited | `⏸ reset Xm` | pause.circle.fill | 赤 |
| running | Conductor 稼働中 | `N running` (+pending) | bolt.fill | 青 |
| done | 全タスク完了（直前が idle/done 以外） | `done` | checkmark.circle.fill | 緑 |
| idle | デフォルト | `idle` | pause.circle.fill | グレー |

daemon 停止時に `cmux clear-status` でクリアする。

### プロキシサーバー

- Bun.serve ベースの HTTP プロキシ（`idleTimeout: 255s` で長時間の SSE ストリームを維持）
- Anthropic API へのリクエスト/レスポンスを SQLite FTS5 データベースに記録
- ストリーミング対応（`text/event-stream` の tee）
- ポートは `.team/proxy-port` に保存
- 既存プロセスが生きていれば再利用
- daemon 起動時に proxy を再利用し、前回ポートと異なる場合は Master セッションを自動再接続
- レート制限ヘッダー（`anthropic-ratelimit-unified-5h-utilization`, `anthropic-ratelimit-unified-7d-utilization`, `anthropic-ratelimit-unified-status` など）を記録し、TUI に使用率と reset 時刻を反映
- デバッグエンドポイント: `GET /state`, `GET /tasks`, `GET /conductors`, `GET /rate-limit`（最新のレート制限状態）, `POST /master-state`（Master の稼働ステータス受信。T229 以降は optional `surface` を body に受け付ける。未指定時は Master が 1 個の場合のみ自動解決、2 個以上は `master_state_surface_ambiguous` をログして 400 を返す）, `POST /statusline`（T211、Claude Code の statusline 描画。`X-Cmux-Surface` ヘッダーで対象 surface を識別し、DaemonState から master/conductor/agent のロールを逆引きして 1 行文字列を返す）

#### 5h レート制限スロットリング

5h unified utilization が閾値（`THROTTLE_5H_THRESHOLD = 0.90`、90%）以上になると、`scanTasks()` で新規タスクの Conductor への割り当てを一時停止する。既に実行中のタスクは影響を受けない。TUI ダッシュボードにもスロットリング状態（THROTTLED 点滅表示）とリセット残り時間を表示する。

スロットル中は `cmux-team spawn-agent` が `/rate-limit` API でブロックされ exit code 75 を返す。これを受け取った Conductor は自分で再試行する仕組み。

### TUI ダッシュボード

- React + ink ベースのフルスクリーン TUI
- セクション: ヘッダー（ステータス・PID・稼働時間・proxy ポート・5h/7d unified 使用率）、Conductor 一覧、タスクリスト、ログ/Journal タブ
- 起動時は `bootPhase` を導入してプロキシ起動直後から TUI を表示
- キーボードショートカット (T435 で Vim ベースに統一): `?` = ヘルプ overlay、`Ctrl+r` = リロード、`q` = 終了、`Ctrl+q` = 完全終了、`Esc` = キャンセル / グローバル focus に戻る、Tab 切替 = `1`-`6` (journal/artifacts/log/settings/issues/metrics) または `Tab`/`gt`/`gp`、ナビ = `↑/↓` / `j/k`、上下端 = `gg`/`ge` (Vim chord)、半画面 = `Ctrl+d`/`Ctrl+u`、開く = `Enter`/`o`、ブラウザで開く = `Ctrl+o`、issues 同期 = `Ctrl+s`。詳細は help overlay (`?`) を参照。
- 旧キー (`T J L A I M B O`) は v.next で削除予定の deprecated alias として残置 (T435)
- 単発 `g` (旧 top jump) と `Ctrl+G` (旧 bottom jump) は **alias なしの完全廃止**。理由: 単発 `g` は rezi-ui C5 制約 (chord prefix conflict) により `gg`/`ge`/`gt`/`gp` と共存不可、`Ctrl+G` は本リファクタで `ge` に統一 (T435)
- フォーカスシステム / カーソル / フッターを備え、Tasks 行はクリック可能（行全体がボタン）
- 5h レート制限スロットリング時にダッシュボードにリセット残り時間を表示
- Tasks の並び順は open 上位 + createdAt 降順、5件制限は撤廃
- Tasks に `assignedAt` を記録し、running は経過時間、closed/aborted は総実行時間を表示
- ブランチアイコン・GitHub issue リンク（OSC 8 ハイパーリンク）・Nerd Font アイコンを表示
- Journal/Log は最新を一番上に逆順表示し、スクロール追従ロジックを改善
- レート制限のリセット時間は色分け（5h/7d 個別色）し、ダッシュボード全体はダーク基調
- Master idle スピナーを `spinnerInterval` で `DaemonState` に同期
- 2秒間隔でデータ更新

### メッセージング

- daemon の HTTP プロキシが受け口を兼ね、CLI（`cmux-team send <TYPE>`）から POST されたメッセージを受信
- メッセージ種別: `TASK_CREATED`, `TASK_UPDATED`, `CONDUCTOR_REGISTERED`, `CONDUCTOR_DONE`, `AGENT_SPAWNED`, `SESSION_STARTED`, `SESSION_ENDED`, `SESSION_ACTIVE`, `SESSION_IDLE`, `SESSION_ASK`, `SESSION_STOP`, `SESSION_CLEAR`, `SHUTDOWN`
- Zod バリデーション（不正メッセージはスキップ）
- `task_completed` の二重記録は CONDUCTOR_DONE ハンドラのステータスガードで防止

`CONDUCTOR_REGISTERED` は **Conductor 実行プロセス自身**（`cmdSpawnConductor`）が起動時に POST する self-register 方式（T228）。`launchConductor`（Manager 起動経路）からは POST しない。daemon ハンドラは idempotent merge で、既存 state があれば `conductor_register_skipped` ログを出して skip する（resume 時の taskId/taskRunId/worktreePath を破壊しないため）。`state.conductors.size >= state.maxConductors` を超過した新規登録では `conductor_register_over_cap` warning ログを出すが登録自体は成功する（soft cap）。

`SESSION_CLEAR` は Conductor が `/clear` を実行したときに送信される。Conductor が `running` 状態のときに `SESSION_CLEAR` を受信すると、ユーザーの手動 `/clear` とみなしてタスクを `aborted` に遷移させ、Conductor を `reserved` にリセットする（claude プロセスを kill して token を解放し、pane は保持して次の assign を待つ — T421/D5）。`idle` / `reserved` 状態の場合は何もしない（TUI チラつき防止）。

`SESSION_ASK` は Stop hook が AskUserQuestion による停止を検出したときに送信される（T181）。Conductor が `running` 状態で受信すると status を `asking` に遷移させ、ユーザー入力待ちであることを TUI に反映する。Agent 側で発火した場合は Conductor の `await-agent` が STATUS=ASK を受け取り再開判断を行う。

### Conductor status enum

| status | 意味 |
|--------|------|
| `starting` | 起動直後（Claude 初期化中） |
| `idle` | タスク待機中（done マーカー解消済み） |
| `running` | タスク実行中 |
| `asking` | AskUserQuestion で停止中（ユーザー入力待ち、T181） |
| `disconnected` | 監視失敗または surface 消失 |

### タスク状態の拡張フィールド（resume 用）

`task-state.json` の各タスクエントリに、タスク割り当て時（`assignTask`）に以下のフィールドが記録される:

| フィールド | 説明 |
|-----------|------|
| `worktreePath` | git worktree の絶対パス |
| `taskRunId` | タスク実行 ID（`task-NNN-TIMESTAMP` 形式） |
| `conductorSlot` | Conductor の surface ID（例: `"surface:5"`） |
| `sessionId` | Conductor の Claude セッション ID |

これらは daemon 再起動時の resume ロジックで使用される。`sessionId` は Claude Code の SessionStart hook（`source: startup|resume|clear|compact`）から `SESSION_STARTED` メッセージとして daemon に push され、`/clear` 等で session が切り替わるたびに最新値で更新される（T203）。

### テンプレート検索順序

1. daemon 自身の `../templates/`（ローカル開発）
2. プラグインキャッシュ: `~/.claude/plugins/cache/hummer98-cmux-team/.../templates/`
3. プロジェクトローカル: `skills/cmux-team/templates/`
4. 手動インストール: `~/.claude/skills/cmux-team/templates/`

### Event Catalog（eventBus.ts）

daemon プロセス内の **実 state mutation** → TUI refresh を疎結合に接続するための EventEmitter ラッパー。

| event | payload | emitter（実 mutation 点） | subscriber |
|---|---|---|---|
| state-changed | source: string | conductor.ts (assignTask L481, resetConductor L572), daemon.ts (handleMessage 各 case の実 mutation 直後, scanTasks 差分あり時, monitorConductors/pidWatcher の status 遷移) | dashboard.tsx (scheduleRefresh 経由で 100ms debounce 描画) |

**追跡性ガイドライン**:

- `bus.emit` / `bus.on` の直接呼び出しは eventBus.ts 外では禁止（`rg "bus\.(emit|on)\b" skills/cmux-team/manager | rg -v eventBus.ts` で 0 件になることを確認）
- emit は必ず `notifyStateChanged(source)` ラッパー経由。source には `"<ファイル>:<関数>:<理由>"` 形式の文字列を渡す
- emit は **実際に state が mutate した直後のみ**。中間処理完了点（外部コマンド終了、ローカル変数更新）では emit しない
- `CMUX_TEAM_TRACE_EVENTS=1` で起動すると `manager.log` に `event_emit event=state-changed source=...` が記録される（デバッグ用）
- 新 event を追加する場合は `Event` discriminated union を導入し、専用 `notify*` ラッパーを export する
- `logger.ts` は `eventBus.ts` を import してはならない（循環依存禁止）

---

## レイアウトモード

`cmux-team start` は起動時に固定のペイン構成を作成する。モードは `--layout` オプションまたは `.team/config.json` の `layout` フィールドで指定する。

### モード一覧

| モード | ペイン構成 | 既定 Conductor 数 |
|--------|-----------|-------------------|
| `16x9`（デフォルト） | 上段フル幅（Manager\|Master）+ 下段 2 分割（Conductor x2） | 2 |
| `wide` | 2x2（Manager\|Master + Conductor x3） | 3 |

#### 16x9

```
[ Manager | Master (上段フル幅) ]
[ Conductor-1 | Conductor-2    ]
```

上段フル幅に Manager/Master（タブ同居）、下段を左右 2 分割して Conductor を配置。最大 2 タスク並列、3 つ目以降はキューイング。16:9 ディスプレイで Conductor ペインの横幅を最大化する用途。

#### wide

```
[Manager|Master] | [Conductor-1]
[Conductor-2   ] | [Conductor-3]
```

左上に Manager/Master がタブとして同居し、残り 3 ペインを Conductor に割り当てる。最大 3 タスク並列、4 つ目以降はキューイング。

### 切り替え方法

1. **CLI**: `cmux-team start --layout=wide`
2. **設定ファイル**: `.team/config.json` に `{ "layout": "wide" }` を記述

### 優先順位

CLI 引数 > `.team/config.json` > デフォルト（`16x9`）。

`CMUX_TEAM_MAX_CONDUCTORS` 環境変数で Conductor 数を上書きできるが、`16x9` で 2 を超える値を指定すると警告ログを出力して 2 にクランプされる（下段は 2 ペイン固定のため）。

### 再起動時の挙動

`.team/team.json` に記録された `layout` が起動時の指定と異なる場合、新しい layout で再初期化される（`layout_mismatch_on_resume` をログ記録）。古い team.json に `layout` フィールドがない場合は `16x9` とみなす。

---

## CLAUDE.md

プロジェクト開発用の規約ファイル。主要セクション:
- プロジェクトミッション・設計原則
- 判断基準と優先順位
- GitHub issue 作成ガイドライン
- リポジトリ構造
- スキル・コマンド・テンプレートの追加方法
- テンプレート変数仕様
- インストール方法（npm）
- テスト方法（E2E 手動テスト）
- コーディング規約
- ロギングポリシー
- プロンプト編集ルール（テンプレートがソースオブトゥルース）
- Manager プロトコル（内部実装）
- 通信プロトコル
- 既知の注意点（Trust 確認、レート制限、トレーサビリティ 等）

---

## .team/.gitignore（initInfra で自動生成）

```
# セッション固有（追跡不要）
team.json
masters/
proxy-port
rate-limit.json
logs/
output/
prompts/
queue/
traces/
sessions/
conductors/
docs-snapshot/
e2e-results/

# 追跡すべき（上記以外）
# tasks/        — タスク定義・runs の成果物
# artifacts/    — 知見の記録
# specs/        — 要件・設計
# task-state.json — タスク状態（resume に必要）
```

`output/`, `prompts/`, `queue/` はタスク中心フォルダ集約への移行で実体としては未使用だが、過去バージョンとの互換のため引き続き ignore に列挙されている。`team.json` は daemon が自動更新する派生物のため追跡しない（以前は追跡対象だったが v3.41 以降で無視に変更）。`task-state.json` は resume に必要なため追跡する。

**`team.json` の主要フィールド** (T414): `manager` / `masters[]` / `conductors[]` / `phase` / `layout` に加え、daemon が internal Web ダッシュボード起動時に `dashboardServer: { url: "http://127.0.0.1:<ephemeral>", schemaVersion: 1 }` を atomic write する（外部から read-only で参照する公開チャネル）。詳細は [`12-web-dashboard.md`](12-web-dashboard.md) §2.3。

`rate-limit.json` は T227 で追加された RateLimitInfo スナップショット（下記参照）。`initInfra` は既存 `.team/.gitignore` に `rate-limit.json` 行が無ければ自動で追記し（`team_gitignore_migrated` をログ）、二重追記は行わない（冪等）。

追跡するもの:
- `tasks/` — タスクディレクトリ集約（`TNNN-slug/task.md` ＋ `runs/<taskRunId>/`）
- `specs/` — 要件・設計ドキュメント
- `artifacts/` — 知見の記録
- `task-state.json` — タスク状態（resume で参照）

### .team/masters/（T229 — 複数 Master 基盤）

`.team/masters/<normalized>.json` は個々の Master インスタンスの永続状態。旧 `.team/master.surface`（surface 文字列のみの単一マーカー）は廃止され、Master の登録・PID・ステータスを **per-surface の JSON ファイル** に分解して保存する。

- **ファイル名**: `<normalizeSurfaceForPath(surface)>.json`。`normalizeSurfaceForPath` は surface 中のコロン `:` のみを `_` に置換する（ハイフン等はそのまま保持）。空文字入力は throw
- **ファイル内容**: `MasterStateSchema`（Zod 検証）。`surface` / `pid?` / `status: "idle"|"running"|"disconnected"` / `startedAt: ISO8601` / `disconnectedAt?` / `prompt?`
- **真のソース**: ファイル名は一意キーとしてのみ扱い、`surface` フィールド本体は JSON 内容から取得する。ファイル名の衝突は後勝ち（`master_file_conflict` ログ）
- **ライフサイクル**（T230 — self-register に統一）:
  - `cmdLaunchMaster`（`cmux-team spawn-master`）が `registerSelfAsMaster(surface)` で `MASTER_REGISTERED` を daemon に POST（daemon の proxy 未起動時は fail-fast exit 1）
  - daemon の `handleMessage` が `MASTER_REGISTERED` を受信して `state.masters.set` + `persistMasterFile`（status: `"starting"`、pid: 未確定）
  - `SESSION_STARTED` 受信時に pid を確定し、`persistMasterFile` で再書き込み（status: `"idle"`）
  - 取りこぼし対策: `SESSION_STARTED` 受信時に対応する Master エントリが state に無ければ、fallback として `state.masters.set`（status: `"starting"`）＋ `persistMasterFile` ＋ PID watcher 起動（Design Review F1）
  - `removeMaster(state, surface, reason)` で `state.masters` から削除すると同時に `deleteMasterFile` でファイルも削除
- **daemon 再起動時の復元**: `startMaster` が `.team/masters/*.json` を列挙して PID 生存を `process.kill(pid, 0)` で確認し、生きているものだけを `state.masters` に登録。pid 欠落 / dead / JSON 破損のファイルは `unlink` して `master_restore_discarded` / `master_file_corrupted` をログ。一件も復元できなかった場合（proxy-port 変更で全 Master を kill した場合、初回起動時を含む）は `spawnMaster(daemonSurface)` で 1 つだけ自動起動する（残りは pane から手動で `cmux-team spawn-master`）
- **旧形式からのマイグレーション**: `initInfra` の末尾で `migrateMasterLayout` が `.team/master.surface` と `team.json.master.pid` を読み、`.team/masters/<normalized>.json` に統合する（1 回限り、冪等）。`.team/.gitignore` の `master.surface` 行も `masters/` に自動書き換えられる

### .team/rate-limit.json（T227）

daemon の `state.rateLimit`（最後に観測した Anthropic API の 5h/7d 使用率）を永続化するスナップショット。再起動直後の dashboard に前回値を復元し、次の API 応答が来るまでの空白を埋めるために使う。

- **書き込み**: `proxy.ts` が Anthropic レスポンスヘッダーから `RateLimitInfo` を抽出したタイミングで、`.team/rate-limit.json.tmp` に書き出して `rename` する atomic write（fire-and-forget）。失敗時は `rate_limit_persist_failed` ログを残して続行し、API レスポンスは絶対にブロックしない。
- **shutdown 時**: SIGINT/SIGTERM で最後にもう一度 flush（ブロック許容、失敗はログのみ）。
- **読み込み**: `cmux-team start` の `initInfra` 直後に `loadRateLimit()` が `RateLimitInfoSchema.safeParse()` で検証し、失敗（ファイル不在 / 破損 JSON / 型不一致 / 必須欠落）は null フォールバック。成功時は `rate_limit_restored unified5h=<pct> unified7d=<pct> stale=<bool>`、失敗時は `rate_limit_restored empty` をログに記録。
- **stale 概念**: `unified5hReset` / `unified7dReset` のいずれかが未来にある間は non-stale、両方過去 or 両方 null or 片方過去+片方 null は stale と判定する（OR 判定）。stale なデータではスロットル判定を無効化し、dashboard は該当行を GRAY 化して末尾に `(stale)` ラベルを付与する。
- **対象ファイル**: スロットル判定が入る 5 箇所（`dashboard.tsx` の isThrottled / forceRed、`proxy.ts` の `/rate-limit` エンドポイント、`daemon.ts` の tick スロットルガードとサイドバーステータス）すべてで `isStale()` ガードが適用される。
- **`.gitignore` 管理**: 新規生成時は `rate-limit.json` を含めて書き込み。既存 `.gitignore` は `initInfra` が行単位でチェックして不足時のみ追記する（冪等）。

### .team/config.json（初回起動時に自動生成）

```json
{
  "models": { "master": "opus", "conductor": "opus", "agent": "opus" },
  "envrcHookPromptSkipped": false,
  "autoUpdate": "off",
  "mainBranch": "main"
}
```

- `models` — Master / Conductor / Agent のデフォルトモデル（`--model` CLI フラグで上書き可）
- `envrcHookPromptSkipped` — `.envrc` への `CMUX_CLAUDE_HOOKS_DISABLED=1` 追記提案をスキップ済みかどうかのフラグ（`claude` 直接起動時向けの optional 機能。`cmux-team` 経由の spawn には不要）
- `autoUpdate` — auto-update モード（`"off" | "notify"`、デフォルト `off`）。env `CMUX_TEAM_AUTO_UPDATE` で上書き可。**T294 (v4.5.0) 破壊的変更:** `"task"` モードと boolean 後方互換（`true` / `false`）を削除した。旧値が残る config / env は起動時に exit 1 で reject される。移行は "notify" または "off" に書き換える
- `mainBranch` — プロジェクトの主開発ブランチ名（T213）。Conductor が worktree のベース・マージ先として使用する。解決順位は env `CMUX_TEAM_MAIN_BRANCH` > `config.mainBranch` > `git symbolic-ref refs/remotes/origin/HEAD` による自動検出。**T253 破壊的変更:** 全て失敗した場合は `cmux-team start` が `MainBranchResolutionError` を throw → console.error に解決手段（env / config / `--main-branch`）を案内した上で `process.exit(1)` する（旧: `"main"` へのサイレントフォールバック）。`cmux-team start` は解決結果を `main_branch_resolved branch=<name> source=<config|detected>` としてログ出力し、source が `detected` の場合のみ `.team/config.json` に書き戻す（初回起動後は常に `config` 経路）。**worktree 作成時の start-point** は `worktree-base.ts:resolveWorktreeBase` が以下の順で解決する（T242 / T275）: (1) task.md `base_branch:` 明示（`explicit`）→ (2) local `<mainBranch>` が `origin/<mainBranch>` より strict ahead（`config-local-ahead`、T275）→ (3) `origin/<mainBranch>` 存在（`config-origin`）→ (4) local `<mainBranch>` 存在（`config-local`）→ (5) HEAD フォールバック（`head-fallback`）。`config-local-ahead` は local `<main>` が `origin/<main>` より strict ahead（同一 SHA でない・origin が local の ancestor）のときのみ採用される。push しない運用や origin が古いケースで、stale な origin から worktree が切られるのを防ぐ（T275）。ログは `worktree_created branch=<new> base=<ref> source=<...> path=<...>`。`CMUX_TEAM_FETCH_BEFORE_WORKTREE`（T283 でデフォルト ON に反転）: worktree 作成前に `git fetch --quiet origin <mainBranch>`（タイムアウト 30 秒、失敗はログのみで継続）を実行するかを制御する。デフォルト ON は stale origin 起点で worktree が切られる事故を防ぐため。offline 環境・rate limit 対策で OFF にしたい場合は `CMUX_TEAM_FETCH_BEFORE_WORKTREE=0` を設定する。起動時に `cmdStart` が `fetch_before_worktree enabled=<on|off> source=<env|default>` を `manager.log` に 1 回 emit する。

### auto-update（update-notifier ベース、T187 / T294）

daemon は `update-notifier` v7 で新バージョンを検出するのみで、install は行わない。`notify` モードは検出結果を dashboard の TUI バナー（`⬆ update available: vX → vY  (upgrade: npm i -g @hummer98/cmux-team@Y)`）として表示するだけで、install はユーザーが手動で実行する。`off` は registry アクセスすら行わない。`NO_UPDATE_NOTIFIER=1` で無効化可能。

**T294 (v4.5.0) 破壊的変更:** `task` モード（update タスクの自動起票）と `cmux-team self-update` CLI を削除した。`CMUX_TEAM_AUTO_UPDATE=task|1|true` / `.team/config.json: autoUpdate: "task" | true | false` は起動時に exit 1 で reject される。移行は `autoUpdate` を `"notify"` または `"off"` に書き換える。手動更新は `npm install -g @hummer98/cmux-team@latest` を直接実行する。旧アーカイブ内のタスク frontmatter に残る `kind: cmux-team-update` は読み取りのみ維持（実行経路なし）。

### .envrc 対話提案（初回起動、optional）

**この機能は `claude` を直接起動するユーザー向けの optional な親切機能であり、`cmux-team start` 経由の spawn 経路には不要である。** `cmux-team` は Conductor / Agent / Master spawn 時に `CMUX_CLAUDE_HOOKS_DISABLED=1` を explicit な `export` として直接注入するため、`.envrc` / `direnv` に依存しない。

`claude` コマンドを自分で直接起動する場合（cmux-team 外での利用）は、プロジェクトルートに `.envrc` が存在し、かつ `CMUX_CLAUDE_HOOKS_DISABLED=1` が未設定の場合に限り、初回 `cmux-team start` 時にユーザーへ追記を提案する。承諾すると `.envrc` 末尾にエントリーを追記し、`direnv allow` の実行と再起動を促す。断る場合は `config.json` の `envrcHookPromptSkipped: true` で以降スキップする。worktree 内の `.envrc` 自動生成（`source_up`）は T212 で廃止済み。

### 自動 GC（T416）

`cmux-team start` は起動直後（boot trigger）と 24 時間周期（periodic trigger）に `.team/` 配下の派生物・trace DB の古い行を自動削除する。`runTeamGC()` (`skills/cmux-team/manager/team-gc.ts`) が単一プロセス内 mutex (`state.gcInFlight`) で直列化し、daemon 多重起動は既存 `pidfile.ts` の lock で構造的に防止される。

#### 保持期間（`.team/config.json` の `gc.retention.*` で上書き可能）

| 項目 | 設定キー | default |
|---|---|---|
| `.team/logs/traces/bodies/<file>` | `bodiesDays` | 14 日 |
| `.team/prompts/<file>` | `promptsDays` | 14 日（active taskRunId 紐付き名 + mtime 24h 以内は二重保護） |
| `.team/queue/processed/<file>` | `queueProcessedDays` | 7 日 |
| `.team/output/<taskRunId>/` | `outputDays` | 14 日（active taskRunId は保護） |
| `.team/conductors/<surface>/` | `conductorsDays` | 14 日（`normalizeSurfaceForPath` 適用後の active surface 名で保護） |
| `.team/e2e-results/<run-id>/` | `e2eResultsDays` | 7 日（active 保護なし） |
| `hook_signals` / `api_usage` 行 | `dbDays` | 30 日（`timestamp < cutoff` で DELETE） |

#### ローテート（`gc.rotation.*`）

- `.team/logs/traces/api-trace.jsonl` / `.team/logs/manager.log`
- 発火閾値 `sizeBytes` default 10 MB、世代 `keep` default 5（`.1` 〜 `.5`、それ以降は unlink）
- `appendFile` の短命 fd 仮定（proxy.ts:905 / proxy.ts:1184）に依存し、rename 後の write は新 inode に向かう

#### 領域回収（boot trigger 限定）

- `traces.db` の `VACUUM` を boot trigger でのみ実行する（writer 不在で SQLITE_BUSY を構造的に回避）。periodic では行わないため 24h 毎の長時間ブロックは発生しない
- `~/.cmux-team/tokens.db` は boot trigger で `PRAGMA wal_checkpoint(TRUNCATE)` を 1 回実行する

#### 設定例（`.team/config.json`）

```json
{
  "gc": {
    "runOnStart": true,
    "periodic": true,
    "intervalMs": 86400000,
    "dryRun": false,
    "retention": {
      "bodiesDays": 14,
      "promptsDays": 14,
      "queueProcessedDays": 7,
      "outputDays": 14,
      "conductorsDays": 14,
      "e2eResultsDays": 7,
      "dbDays": 30
    },
    "rotation": {
      "sizeBytes": 10485760,
      "keep": 5
    }
  }
}
```

- `runOnStart` / `periodic` を `false` にすると当該 trigger をスキップ（テスト・運用調整用）
- `intervalMs` の clamp は `[3_600_000 (1h), 604_800_000 (1week)]`、範囲外は default に倒す
- `dryRun: true` は削除を行わず `team_gc_deleted` イベントだけ出す（事前確認用）
- `retention.*Days = 0` は active 保護 race の安全網を破る構成のため起動時に `team_gc_warn reason=retention_zero_active_protection_unsafe` を 1 行 emit する

#### log event

| event 名 | 出るタイミング | detail |
|---|---|---|
| `team_gc_started` | runTeamGC 入口 | `trigger=<boot\|periodic\|manual> dry_run=<bool>` |
| `team_gc_skipped` | gcInFlight true で弾いた | `reason=in_flight trigger=<...>` |
| `team_gc_deleted` | category 単位で集計（dryRun でも emit） | `category=<...> count=<N> bytes=<B> dry_run=<bool>` |
| `team_gc_rotated` | log rotation 発火 | `file=<...> from_bytes=<...> rotated_to=<.1,.2,...>` |
| `team_gc_db` | DB GC 結果 | `hook_signals_deleted=<N> api_usage_deleted=<N> retention_days=<D>` |
| `team_gc_db_vacuum` | traces.db VACUUM 完了（boot trigger のみ） | `duration_ms=<N> freed_bytes=<B>` |
| `team_gc_wal_checkpoint` | tokens.db checkpoint（boot trigger のみ） | `frames_checkpointed=<N> ok=<bool>` |
| `team_gc_completed` | 出口 | `trigger=<...> duration_ms=<N> total_deletions=<N> total_bytes=<B>` |
| `team_gc_failed` | 例外 | `trigger=<...> error=<message>` |

> 個別ファイルパスは log に出さない（数千件で `manager.log` が膨張するため）。詳細を追いたいときは `gc.dryRun=true` で再実行する。`hook_signals` / `api_usage` 自体が GC 対象なので GC 実行ログは trace DB ではなく `manager.log` のみが情報源となる。
