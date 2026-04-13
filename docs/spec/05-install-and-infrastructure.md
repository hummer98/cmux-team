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

### 2. Claude Code Plugin

`.claude-plugin/plugin.json`（npm パッケージ内に同梱）で定義。`postinstall` で自動登録される。

```json
{
  "name": "cmux-team",
  "version": "3.31.0",
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

Conductor・Agent・Master 起動時は環境変数 `CMUX_CLAUDE_HOOKS_DISABLED=1` で cmux ラッパー側の hook を無効化し、Manager が生成する `conductor-settings.json` を `claude --settings` 経由で動的に注入する（hook 設定の優先順位問題への対応）。Agent spawn 時は `spawn-agent` CLI 内で、Master 起動時は `spawn-master` CLI 内でそれぞれ設定される。

---

## npm パッケージ構成

### package.json

```json
{
  "name": "@hummer98/cmux-team",
  "version": "3.31.0",
  "bin": { "cmux-team": "bin/cmux-team.js" },
  "scripts": {
    "postinstall": "node bin/postinstall.js",
    "prepublishOnly": "cd skills/cmux-team/manager && bun test"
  },
  "engines": { "node": ">=18" }
}
```

### bin/cmux-team.js

CLI ラッパー。Bun で `skills/cmux-team/manager/main.ts` を実行する。

- `bun` の存在を確認（未インストール時はエラー）
- `start` コマンドの場合: exit code 42 による自動再起動をサポート（最大10回）
- その他のコマンド: 引数を透過して `bun run main.ts` に渡す

### bin/postinstall.js

npm postinstall スクリプト。

1. `bun install` で manager/ の依存関係を解決（bun 未インストール時は手動実行を案内）
2. `claude plugin add hummer98/cmux-team` で Plugin を登録（claude 未インストール時は手動実行を案内）

---

## Manager Daemon（TypeScript）

### ディレクトリ構成

```
skills/cmux-team/manager/
├── main.ts          # CLI エントリーポイント（17サブコマンド）
├── daemon.ts        # イベント駆動ステートマシン + メインループ
├── master.ts        # Master surface 起動
├── conductor.ts     # Conductor ライフサイクル管理
├── task.ts          # タスクファイルパース + 依存解決
├── proxy.ts         # API ロギングプロキシ
├── trace-store.ts   # SQLite FTS5 トレースDB
├── artifact.ts      # アーティファクト管理
├── schema.ts        # Zod 型定義
├── template.ts      # プロンプトテンプレート検索・生成
├── logger.ts        # 追記型ログ
├── cmux.ts          # cmux CLI ラッパー
├── dashboard.tsx    # React (ink) TUI ダッシュボード
├── e2e.ts           # E2E テストランナー
├── *.test.ts        # ユニットテスト（daemon / proxy / task など）
├── package.json     # 依存: ink, react, zod, @rezi-ui/core, @rezi-ui/node
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
| `close-task` | タスクを closed にマーク + journal 保存 + CONDUCTOR_DONE 送信（`--force` で実行中も強制クローズ可能） |
| `abort-task` | 実行中タスクの中止（sub-agent 停止 → Conductor 停止 → worktree 削除 → `aborted` 遷移 → Conductor 再起動） |
| `delete-task` | draft/ready タスクの削除（`deleted` 遷移、journal 記録）。`assigned` のタスクは `abort-task` を使う |
| `trace` | トレースDB 検索・表示（`--task`, `--search`, `--show`, `--conductor`, `--role`, `--limit`） |
| `conductor` | Conductor 情報表示 |
| `spawn-master` | Master surface 起動 |
| `artifacts` | アーティファクト一覧・検索・追加（`add`）・表示（`show`）・Markdown ビューア（`open`） |
| `resume` | assigned タスクの Conductor セッションを `claude --resume` で再開 |

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
ソースファイル mtime 監視によりコード変更時は自動再起動（exit code 42）。auto-restart 後に proxy ポートが変わった場合は Master を自動再接続する。

daemon は起動時に呼び出し元の workspace を `state.workspace` に記録し、`cmux tree` / `validateSurface` には常に workspace を渡して別ワークスペースの surface ID と混同しないようにする。起動時にワークスペース名を `basename(PROJECT_ROOT)`（起動フォルダ名）に自動設定する（`cmux rename-workspace`）。

Conductor が worktree を初期化する際には `.claude/settings.local.json` をワークツリー側にコピーし（`skills/cmux-team/manager/conductor.ts` の worktree 作成フロー）、サブエージェントが同じローカル設定で動作するようにする。また、プロジェクトルートに `.envrc` が存在する場合、worktree 内に `source_up` の `.envrc` を自動生成し、direnv による OAuth トークン等の環境変数を worktree に継承する。

#### assigned タスクの resume

daemon 起動時（boot 完了後）に `task-state.json` で `status: assigned` のタスクを検出し、以下の条件を満たす場合は idle Conductor に割り当てて `cmux-team resume <task-id>` で再開する:

1. `sessionId` が記録されている
2. `worktreePath` が存在する
3. `taskRunId` が記録されている

条件を満たさない場合は `ready` に戻して通常の再割り当てにフォールバックする。既に同じタスクを実行中の Conductor がいる場合はスキップ（多重実行防止）。

`resume` コマンドは `claude --resume <sessionId>` でセッションを再開する。設定は `cmdConductor` と同等（`--dangerously-skip-permissions`, `--settings`, `--model`）。作業ディレクトリは `worktreePath` を使用。

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

- Bun.serve ベースの HTTP プロキシ
- Anthropic API へのリクエスト/レスポンスを SQLite FTS5 データベースに記録
- ストリーミング対応（`text/event-stream` の tee）
- ポートは `.team/proxy-port` に保存
- 既存プロセスが生きていれば再利用
- daemon の auto-restart 後にポートが変わった場合は Master セッションを自動再接続
- レート制限ヘッダー（`anthropic-ratelimit-unified-5h-utilization`, `anthropic-ratelimit-unified-7d-utilization`, `anthropic-ratelimit-unified-status` など）を記録し、TUI に使用率と reset 時刻を反映
- デバッグエンドポイント: `GET /state`, `GET /tasks`, `GET /conductors`

#### 5h レート制限スロットリング

5h unified utilization が閾値（`THROTTLE_5H_THRESHOLD = 0.90`、90%）以上になると、`scanTasks()` で新規タスクの Conductor への割り当てを一時停止する。既に実行中のタスクは影響を受けない。TUI ダッシュボードにもスロットリング状態とリセット残り時間を表示する。

### TUI ダッシュボード

- React + ink ベースのフルスクリーン TUI
- セクション: ヘッダー（ステータス・PID・稼働時間・proxy ポート・5h/7d unified 使用率）、Conductor 一覧、タスクリスト、ログ/Journal タブ
- 起動時は `bootPhase` を導入してプロキシ起動直後から TUI を表示
- キーボードショートカット: `r` = リロード、`q` = 終了、Tasks タブで Enter = タスクドキュメントをフルスクリーン表示
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
- メッセージ種別: `TASK_CREATED`, `CONDUCTOR_REGISTERED`, `CONDUCTOR_DONE`, `AGENT_SPAWNED`, `SESSION_STARTED`, `SESSION_ENDED`, `SESSION_ACTIVE`, `SESSION_IDLE`, `SESSION_CLEAR`, `SHUTDOWN`
- Zod バリデーション（不正メッセージはスキップ）
- `task_completed` の二重記録は CONDUCTOR_DONE ハンドラのステータスガードで防止

`SESSION_CLEAR` は Conductor が `/clear` を実行したときに送信される。Conductor が `running` 状態のときに `SESSION_CLEAR` を受信すると、ユーザーの手動 `/clear` とみなしてタスクを `aborted` に遷移させ、Conductor を idle にリセットする（`forceCloseDisconnectedConductor` と同パターン）。`idle` 状態の場合は何もしない（TUI チラつき防止）。

### タスク状態の拡張フィールド（resume 用）

`task-state.json` の各タスクエントリに、タスク割り当て時（`assignTask`）に以下のフィールドが記録される:

| フィールド | 説明 |
|-----------|------|
| `worktreePath` | git worktree の絶対パス |
| `taskRunId` | タスク実行 ID（`task-NNN-TIMESTAMP` 形式） |
| `conductorSlot` | Conductor の surface ID（例: `"surface:5"`） |
| `sessionId` | Conductor の Claude セッション ID |

これらは daemon 再起動時の resume ロジックで使用される。`sessionId` は Conductor 初回起動時に `crypto.randomUUID()` で発行され、タスク割り当てやリセットで変更されない（常駐セッションのため）。

### テンプレート検索順序

1. daemon 自身の `../templates/`（ローカル開発）
2. プラグインキャッシュ: `~/.claude/plugins/cache/hummer98-cmux-team/.../templates/`
3. プロジェクトローカル: `skills/cmux-team/templates/`
4. 手動インストール: `~/.claude/skills/cmux-team/templates/`

---

## レイアウトモード

`cmux-team start` は起動時に固定のペイン構成を作成する。モードは `--layout` オプションまたは `.team/config.json` の `layout` フィールドで指定する。

### モード一覧

| モード | ペイン構成 | 既定 Conductor 数 |
|--------|-----------|-------------------|
| `wide`（デフォルト） | 2x2（Manager\|Master + Conductor x3） | 3 |
| `16x9` | 上段フル幅（Manager\|Master）+ 下段 2 分割（Conductor x2） | 2 |

#### wide

```
[Manager|Master] | [Conductor-1]
[Conductor-2   ] | [Conductor-3]
```

左上に Manager/Master がタブとして同居し、残り 3 ペインを Conductor に割り当てる。最大 3 タスク並列、4 つ目以降はキューイング。

#### 16x9

```
[ Manager | Master (上段フル幅) ]
[ Conductor-1 | Conductor-2    ]
```

上段フル幅に Manager/Master（タブ同居）、下段を左右 2 分割して Conductor を配置。最大 2 タスク並列、3 つ目以降はキューイング。16:9 ディスプレイで Conductor ペインの横幅を最大化する用途。

### 切り替え方法

1. **CLI**: `cmux-team start --layout=16x9`
2. **設定ファイル**: `.team/config.json` に `{ "layout": "16x9" }` を記述

### 優先順位

CLI 引数 > `.team/config.json` > デフォルト（`wide`）。

`CMUX_TEAM_MAX_CONDUCTORS` 環境変数で Conductor 数を上書きできるが、`16x9` で 2 を超える値を指定すると警告ログを出力して 2 にクランプされる（下段は 2 ペイン固定のため）。

### 再起動時の挙動

`.team/team.json` に記録された `layout` が起動時の指定と異なる場合、新しい layout で再初期化される（`layout_mismatch_on_resume` をログ記録）。古い team.json に `layout` フィールドがない場合は `wide` とみなす。

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
output/
prompts/
docs-snapshot/
logs/
queue/
conductors/
master.surface
task-state.json
tasks/*.status.json
```

`output/`, `prompts/`, `queue/` はタスク中心フォルダ集約への移行で実体としては未使用だが、過去バージョンとの互換のため引き続き ignore に列挙されている。

追跡するもの:
- `team.json` — チーム構成
- `tasks/` — タスクディレクトリ集約（`TNNN-slug/task.md` ＋ `runs/<taskRunId>/`）
- `specs/` — 要件・設計ドキュメント
- `artifacts/` — 知見の記録
