![cmux-team](banner.jpeg)

# cmux-team

[![npm version](https://img.shields.io/npm/v/@hummer98/cmux-team.svg)](https://www.npmjs.com/package/@hummer98/cmux-team)
[![npm downloads](https://img.shields.io/npm/dm/@hummer98/cmux-team.svg)](https://www.npmjs.com/package/@hummer98/cmux-team)
[![npm total downloads](https://img.shields.io/npm/dt/@hummer98/cmux-team.svg)](https://www.npmjs.com/package/@hummer98/cmux-team)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Claude Code + cmux によるマルチエージェント開発オーケストレーション。

**[English README](README.md)**

## デモ

https://github.com/user-attachments/assets/1d402a69-f48c-4a43-b52d-9c80f0f90ea1

## なぜ cmux-team?

Claude Code の組み込みサブエージェントは便利ですが、**中で何をしているか見えません**。結果だけが返ってきて、途中経過はブラックボックスです。

これは見た目以上に重要な問題です。エージェントが見えない状態で動くと、2つの問題が重なります：

- **異常検知が遅れる**: 何か間違っていても、作業が終わるまでわかりません。途中で介入できず、無駄なコンピューティングと時間が失われます
- **改善サイクルが回せない**: 途中の挙動が見えないと、なぜ結果が良かった・悪かったかがわからず、プロンプトやタスク設計を改善するための情報が得られません

cmux-team は **AI 観察箱** です。自動化ブラックボックスではありません。ターミナルペインは飾りではなく、それ自体がプロダクトです。Conductor ペインを 10 秒斜め読みするだけで、最終結果まで気づけなかった問題をその場で検出できます。

設計原則：認知負荷を下げるのは「プロセスを隠す」ことではなく、**「プロセスを見やすくする」** ことで。

**あなたがやること**: Claude に自然言語で指示するだけ。
**Claude がやること**: cmux でペインを分割し、サブエージェントを起動・監視・統合 — すべて目の前で。

## 前提条件

- [Claude Code](https://claude.ai/claude-code) がインストール済み
- [cmux](https://github.com/manaflow-ai/cmux) がインストール済み
- [bun](https://bun.sh/) がインストール済み（Manager daemon に必要）
- cmux 内で Claude Code を実行していること
- [Nerd Font](https://www.nerdfonts.com/)（推奨）— TUI ダッシュボードのアイコン表示が向上します
  ```bash
  brew install --cask font-hack-nerd-font
  ```
  Nerd Font がなくても動作します（Unicode シンボルにフォールバック）。`CMUX_NERD_FONT=0` を設定するとフォールバックアイコンを明示的に使用できます。

## インストール

```bash
npm install -g @hummer98/cmux-team
```

### auto-update について

daemon は `update-notifier` で新バージョンを**検出**し、TUI バナーに表示するだけです。install は常に手動で、ユーザー自身が `npm i -g @hummer98/cmux-team@<latest>` を実行します（複数 Node 環境での予期しない上書きを避けるため）。

2モード（デフォルト: `off`）:

| mode | 挙動 |
|------|------|
| `off` | 何もしない（registry アクセスなし） |
| `notify` | 12h 周期で検出 → TUI バナー表示のみ |

設定（優先順位: **env > config > default**）:

- `CMUX_TEAM_AUTO_UPDATE=off|notify`（`0|false` は off として扱う）
- `.team/config.json`: `{ "autoUpdate": "off" | "notify" }`

関連:
- `NO_UPDATE_NOTIFIER=1` で無効化（update-notifier 標準の環境変数）
- 起動時ログ: `auto_update_config mode=<mode> source=<env|config|default>`

**破壊的変更（v4.5.0、T294）:**
- `task` モード（update タスクの自動起票）を削除しました。`CMUX_TEAM_AUTO_UPDATE=task|1|true` および `.team/config.json: autoUpdate: "task" | true | false` は起動時に exit 1 で reject されます。
- `cmux-team self-update` サブコマンドを削除しました。
- 移行: `autoUpdate` を `notify`（または `off`）に変更し、バナーが表示されたら `npm install -g @hummer98/cmux-team@latest` を実行してください。

### 設定ファイル（`.team/config.json`）

`cmux-team start` がプロジェクトごとに自動生成します。全キーは任意で、手動編集も可能（次回 start 時に再読込されます）。共通の優先順位: **CLI フラグ > 環境変数 > `.team/config.json` > 組み込みデフォルト**。

| キー | 型 | デフォルト | 用途 |
|-----|---|----------|------|
| `mainBranch` | string | `origin/HEAD` から自動検出 | 主開発ブランチ。worktree のデフォルト起点・マージ先として使用。上書き: 環境変数 `CMUX_TEAM_MAIN_BRANCH`、CLI `--main-branch`、タスク単位の `--base-branch`。 |
| `layout` | `"wide"` \| `"16x9"` | `"16x9"` | 起動時のペインレイアウト。上書き: CLI `--layout`。 |
| `sleepPrevention` | `"off"` \| `"idle"` \| `"aggressive"` \| boolean | `"aggressive"` | macOS スリープ抑止モード。`aggressive` = `caffeinate -dis`（display + idle + system sleep を全抑止、T256 以降のデフォルト）、`idle` = `caffeinate -i`（user idle のみ抑止、display sleep は許可）、`off` = caffeinate を起動しない。boolean も後方互換で受理（`true` → `aggressive`、`false` → `off`）。上書き: CLI `--sleep-prevention <mode>` または `--no-sleep-prevention`。 |
| `autoUpdate` | `"off"` \| `"notify"` | `"off"` | バージョン検出モード（上記参照）。上書き: 環境変数 `CMUX_TEAM_AUTO_UPDATE`。 |
| `models.master` / `models.conductor` / `models.agent` | string | Claude デフォルト | ロール別モデル指定（例: `"claude-sonnet-4-6"`）。 |
| `envrcHookPromptSkipped` | boolean | `false` | direnv hook プロンプトをスキップした際の内部フラグ。通常手動編集しません。 |

例:

```json
{
  "mainBranch": "develop",
  "layout": "16x9",
  "sleepPrevention": "idle",
  "autoUpdate": "notify",
  "models": { "conductor": "claude-sonnet-4-6" }
}
```

解決順や自動検出の詳細は `docs/spec/05-install-and-infrastructure.md` を参照してください。

## 使い方

### 基本的な流れ

cmux を起動し、その中で Claude Code を起動します。

```
$ cmux-team start
  → daemon が起動し、ダッシュボードを表示
  → Manager / Master ペインが作成され、Conductor も起動される
  → Master ペインに切り替えてタスクを伝える

あなた: React で TODO アプリを作って
Claude: タスクを作成しました。
  → daemon がタスクを検出 → idle Conductor に割り当て
  → Conductor が Agent を同じペインのタブとして起動
  → 各エージェントの作業がリアルタイムで見える

あなた: 状況は？
Claude: （manager.log・cmux tree を確認して報告）
        Conductor-1: 実装中（Agent 2/3 完了）

あなた: あと worktree を整理して
Claude: → cmux-team create-task --title "..." --status ready
       → daemon が別の idle Conductor に割り当てて並列実行
```

### コマンド一覧

#### CLI コマンド（ターミナルで実行）

完全なリストは `cmux-team --help` を参照。主要なコマンド:

**ライフサイクル**
| コマンド | やること |
|---------|---------|
| `cmux-team start` | daemon 起動 + Master + Conductor spawn（レイアウト消失時は自己修復） |
| `cmux-team status` | チーム状態表示 |
| `cmux-team --version` | バージョン表示 |

> 注記: `cmux-team stop` は v4.3.0 で廃止されました。cmux セッション終了時に daemon が自動停止します（pidfile が release される）。手動停止したい場合は `kill <pid>`（PID は `.team/daemon.pid`）。

**タスク管理**
| コマンド | やること |
|---------|---------|
| `cmux-team create-task --title <t> [--status ready] [--body <b>] [--depends-on <ids>] [--base-branch <branch>] [--run-after-all] [--exclusive]` | タスク作成（`--base-branch`: worktree の起点・マージ先ブランチ、デフォルト: main。`--exclusive`: drain 後に単独実行、`--run-after-all` を含む） |
| `cmux-team update-task --task-id <id> --status <s>` | タスク状態更新 |
| `cmux-team close-task --task-id <id> --deliverable-kind <files|merged|pr|none> [kind 別フラグ] [--journal <text>]` | タスク close |
| `cmux-team abort-task --task-id <id>` | 実行中タスクを中止 |
| `cmux-team restart-task --task-id <id>` | assigned タスクの Conductor を再起動 |
| `cmux-team delete-task --task-id <id>` | draft / ready タスクを削除 |
| `cmux-team await-task --task-id <id> [--timeout <sec>]` | タスク完了待ち |

> **ベースブランチ (`--base-branch`)**: デフォルトでは各タスクの worktree は `mainBranch`（解決順: 環境変数 `CMUX_TEAM_MAIN_BRANCH` → `config.mainBranch` → `origin/HEAD`）から切られ、Conductor はそれをマージ先として扱います。`--base-branch develop` を渡すと代わりに `develop` から切って `develop` に戻します — hotfix や main 以外の feature ブランチに対する作業向け。起点の解決順位: 明示指定 `--base-branch` → local `<mainBranch>`（origin より ahead）→ `origin/<mainBranch>` → local `<mainBranch>` → `HEAD`（詳細は `docs/spec/05-install-and-infrastructure.md`）。

**Agent / Conductor**
| コマンド | やること |
|---------|---------|
| `cmux-team spawn-conductor` | 単一 Conductor を起動・登録 |
| `cmux-team spawn-agent --conductor-surface <s> --role <r> --prompt <p>` | Agent タブを起動 |
| `cmux-team agents` | 稼働中エージェント一覧 |
| `cmux-team close-agent --surface <s>` | Agent を正常終了 |
| `cmux-team kill-agent --surface <s>` | Agent を強制停止（crash 扱い） |
| `cmux-team send-agent --surface <s> <message>` | Agent / Conductor にメッセージ送信 |
| `cmux-team conductor` | Conductor 起動（proxy 自動解決） |
| `cmux-team spawn-master` | Master 起動（proxy 自動解決） |

**トークンプール**
| コマンド | やること |
|---------|---------|
| `cmux-team token add` | Claude OAuth トークンを対話式で登録 |
| `cmux-team token list` | 登録済みトークンと 5h/7d 使用率を表示 |
| `cmux-team token remove --handle <h>` | トークンを削除 |
| `cmux-team token rotate --handle <h>` | credential を再取得して auth hash を更新 |
| `cmux-team token set-plan --handle <h> --plan <p>` | plan / ratio を手動設定 |
| `cmux-team token promote --handle <h>` | auto-discover トークンを selectable に昇格 |
| `cmux-team pool status` | pool capacity ダッシュボードを表示 |

**診断・補助**
| コマンド | やること |
|---------|---------|
| `cmux-team trace-task <task-id>` | タスクのセッション履歴を表示 |
| `cmux-team trace-hooks` | hook シグナル履歴を表示 |
| `cmux-team artifacts [add\|show\|open\|search]` | アーティファクト管理 |
| `cmux-team metrics [--since <range>] [--group-by day]` | タスク lifecycle / tool call / token の集計サマリ（詳細は `docs/spec/11-metrics.md`） |
| `cmux-team metrics snapshot\|compare\|health\|query` | daily snapshot / cohort 比較 / health check / DuckDB ad-hoc query |
| `cmux-team events [--follow] [--types <names>] [--format json\|tsv]` | events stream（`.team/logs/events.jsonl`）を tail / filter |

#### スラッシュコマンド（Claude 内で実行）

| コマンド | やること | いつ使う |
|---------|---------|---------|
| `/master` | Master ロール再読み込み | `/clear` 後 |
| `/cmux-team:watch` | events stream を監視して PR merge / conflict resolve / pull を自動処理（opt-in） | 完了した PR の自動 merge と介入要 event のエスカレーションを Master に任せたい時 |
| `/team-spec [概要]` | 要件をブレスト | 何を作るか決める時 |
| `/team-task [操作]` | タスク管理 | タスクの作成・一覧・クローズ |
| `/team-archive [範囲]` | 完了タスクのアーカイブ | タスク整理時 |
| `/artifact [type] "タイトル"` | 知見をアーティファクトとして保存 | 調査・判断の記録 |
| `/docs-sync [--dry-run\|--auto]` | `docs/spec/` を実装と同期 | ドキュメント整備 |
| `/trace-task <task-id>` | タスクのセッション履歴を分析 | デバッグ・レビュー |

## アーキテクチャ

### 概要

```
┌─────────────────────────────────────────┐
│  cmux-team daemon (TypeScript/bun)      │
│  ┌───────────────────────────────────┐  │
│  │  TUI Dashboard                    │  │
│  │  Tasks: 2 open | Conductors: 1/3  │  │
│  └───────────────────────────────────┘  │
│  Queue ← Master/Hook が CLI で書き込み   │
│  Loop  → タスクスキャン → Conductor spawn │
│  Monitor → 完了検出 → 結果回収          │
└───────────┬────────────┬────────────────┘
            │            │
     [Master]    [Conductor-035]
     Claude Code  Claude Code
     (Opus)       → [Agent] Claude Code
```

### daemon（TypeScript プロセス）

Manager は Claude Code セッションではなく、**TypeScript の決定論的ループ**で動作します。

- **HTTP メッセージキュー**（内蔵 proxy 経由、`cmux-team send <TYPE>`）— イベント駆動
- **ファイルベースのタスク状態**（`.team/tasks/` + `task-state.json`）
- **zod** によるメッセージスキーマ検証
- **ink** ベースの TUI ダッシュボード
- **タスク依存解決** (`depends_on` フィールド)
- **優先度ソート** (high > medium > low)
- **Agent 完了は fs.watch**（Agent の Stop / SessionEnd hook が done マーカーを書き、Conductor が `cmux-team await-agent` で待機。busy polling 不要、T181）

```bash
# daemon 操作
cmux-team start                                          # 起動 + Master spawn + ダッシュボード
cmux-team send TASK_CREATED --task-id 035 --task-file .team/tasks/035-xxx/task.md
cmux-team status                                         # ステータス表示
# daemon は cmux 終了で自動停止。手動停止は `kill <pid>` で（PID は `.team/daemon.pid`）
```

### タスクの依存関係

タスクファイルの YAML frontmatter で依存を宣言できます:

```yaml
---
id: 13
title: 統合レポート作成
status: ready
depends_on: [10, 11, 12]  # 10, 11, 12 が全て完了するまで待機
---
```

daemon は依存が解決されたタスクのみ Conductor に割り当てます。

### 通信モデル

| 方向 | 手段 |
|------|------|
| Master → daemon | `cmux-team send <TYPE>` → proxy 経由の HTTP メッセージ |
| daemon → Conductor | `cmux send`（`/clear` + 新プロンプト。Conductor ペインは常駐） |
| daemon ← Conductor | done マーカーファイル（`.team/conductors/<id>/done`）+ SESSION_* hook メッセージ |
| Conductor → Agent | `cmux-team send-agent` / `spawn-agent`（`cmux send` の直接呼び出しは hook でブロック） |
| Conductor ← Agent | `cmux-team await-agent`（Agent done マーカーを fs.watch） |
| daemon → Master | なし（Master が `manager.log` / `task-state.json` を直接参照） |
| daemon → 外部 reader | events stream（`.team/logs/events.jsonl`、JSONL append-only）— opt-in。`cmux-team events --follow` / Master `/cmux-team:watch` が購読 |

### エージェントロール

| ロール | 担当 | 出力例 |
|--------|-----|--------|
| Conductor | タスクオーケストレーション、Agent 管理 | summary.md |
| Researcher | 技術調査・事実収集 | 比較表、推奨事項 |
| Architect | 技術設計 | 設計書、Mermaid 図 |
| Reviewer | 品質チェック | Approved / Changes Requested |
| Implementer | コーディング | コード、変更ファイル一覧 |
| Tester | テスト作成・実行 | テストコード、実行結果 |

## プロジェクト内に作られるもの

`cmux-team start` を実行すると、プロジェクトに `.team/` ディレクトリが作られます：

```
.team/
├── team.json          # チーム構成（daemon が自動更新）
├── task-state.json    # タスク状態（status: draft/ready/assigned/closed）
├── tasks/             # タスクファイル（TNNN-slug/ にタスク本体と runs/）
│   └── archived/      # アーカイブ済み（closed → archived）
├── artifacts/         # 知見の記録（Axxx 番号付き、直接ファイル作成可）
├── agent-instructions/ # Agent ロール別の project-local overlay
├── specs/             # 仕様書（git tracked）
├── conductors/        # Conductor 状態ファイル + agent-done/ マーカー
├── sessions/          # セッション情報
├── output/            # エージェント出力（taskRunId 別、gitignore）
├── prompts/           # プロンプト監査証跡（gitignore）
├── logs/              # manager.log + traces/bodies/（gitignore）
├── traces/            # SQLite FTS5 トレース DB
└── proxy-port         # プロキシポート番号
```

## プロジェクト固有の追加指示

10 個の overlay 対応ロール（researcher / architect / planner / design-reviewer / implementer / inspector / dockeeper / task-manager / **master / conductor**）に対してプロジェクト固有の追加指示を `.team/agent-instructions/<role>.md` に置くと、対応するプロンプトに自動的に組み込まれます:

- **Agent ロール (8)** — `cmux-team spawn-agent` 実行時に Agent prompt-file 内の `{{PROJECT_INSTRUCTIONS}}` を置換します。
- **master / conductor (T342)** — daemon 起動時に `generateMasterPrompt` / `generateConductorRolePrompt` が `.team/prompts/master.md` / `.team/prompts/conductor-role.md` 生成時に展開する shared system prompt overlay として機能します。`cmux-team spawn-agent --role master` / `--role conductor` は exit 1（"reserved" エラー）となり、agent としては spawn できません。

```bash
# overlay を書き込む
cmux-team set-agent-instructions --role implementer --from-file ./my-impl-notes.md
cmux-team set-agent-instructions --role researcher --body "調査対象は 2025 年以降の論文に限る"
cmux-team set-agent-instructions --role master --body "進捗は常に 3 行でまとめること"
cmux-team set-agent-instructions --role conductor --from-file ./conductor-overlay.md

# 内容確認 / 一覧
cmux-team get-agent-instructions --role implementer
cmux-team list-agent-instructions

# 削除
cmux-team delete-agent-instructions --role implementer
```

overlay の最大サイズは 100 KB。dashboard TUI の `Settings` タブ（`4` キー）で全 10 ロールの overlay 状況と config をプレビューできます。

## Hooks 設定（推奨）

`~/.claude/settings.json` に以下を追加すると、エージェントの完了時に cmux の通知リングが光ります：

```json
{
  "hooks": {
    "Notification": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "command -v cmux >/dev/null 2>&1 && cmux claude-hook notification || true"
      }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "command -v cmux >/dev/null 2>&1 && cmux claude-hook stop || true"
      }]
    }]
  }
}
```

## トークンプール

複数の Claude アカウントを持っている場合、Agent spawn を自動的に振り分けてレート制限を回避できます。

**有効化**（opt-in、プロジェクト単位）:

```json
// .team/config.json
{ "tokenPool": { "enabled": true } }
```

または環境変数: `CMUX_TEAM_TOKEN_POOL=1`。

**トークン登録**（macOS Keychain 必須）:

```bash
cmux-team token add      # 対話式 — ~/.claude/.credentials.json を読むか手動入力
cmux-team token list     # 5h/7d 使用率とともに全トークンを表示
```

**選択アルゴリズム**（Agent spawn ごと）:

1. `policy.exclude` に含まれる handle を除外
2. lease 中（120 秒）または `util_5h > 95%` のトークンを除外
3. 以下の順で admit: `projectDefault` 一致 → `include` リスト → `isOss` フラグ → tag マッチ（`"any"`）
4. スコア = `0.3 × util_5h + 0.7 × util_7d` — 最小値を選択

TUI dashboard ヘッダーには **7 日 forecast スパークライン**（Day 0..6 の日次割当、100% = sustainable pace）と次に spawn-agent が選ぶ **next 候補** を表示します:

```
pool 7d  ██▇▅▅▆█   next: @kddi 5h:65%
```

per-surface decoration（`@handle <5h:X%/7d:Y%> cap:Z%`）は撤去し、ヘッダー集約に一本化しました。アカウント別の詳細は `cmux-team pool status` で確認してください。

詳細（tag フィルタ・exclude/include ポリシー・plan ratio）は `docs/spec/09-token-pool.md` を参照。

## トレーサビリティ

daemon 起動中、組み込みプロキシを通じて全 API リクエストが自動記録されます。

### タスクのセッション履歴

```bash
# 特定タスクのセッション一覧（Conductor + Agent）
cmux-team trace-task 035
```

トレースは `.team/traces/traces.db` に、リクエスト/レスポンス本文は `.team/logs/traces/bodies/` に保存されます。メタデータヘッダー（`x-cmux-task-id`, `x-cmux-conductor-surface`, `x-cmux-role`）が伝播されるため、API リクエストを起票元タスクと紐付けられます。

## トラブルシューティング

### daemon が起動しない

**bun がインストールされていない**: `brew install oven-sh/bun/bun` でインストール。

**cmux 環境外**: cmux 内で実行してください。`CMUX_SOCKET_PATH` 環境変数が必要です。

### ペインが狭くなって動作しない

ペイン数が多すぎると cmux コマンドが失敗します。cmux セッションを終了（daemon は自動停止）してから `CMUX_TEAM_MAX_CONDUCTORS=1` を設定して再起動してください。

### Conductor が自分で作業してしまう

Conductor テンプレートに「自分でコードを書かない」ルールがありますが、守られない場合があります。テンプレートを更新するか、`cmux-team start` を再実行してプロンプトを再生成してください。

### Conductor のセッションログを見たい

```bash
# manager.log から session_id を取得
grep conductor-xxx .team/logs/manager.log
# → task_completed ... session=abc-123

# セッションを参照
claude --resume abc-123
```

## 制約・既知の問題

- **API レート制限**: 複数エージェント同時実行で過負荷になりやすい。Claude Max 推奨。`CMUX_TEAM_MAX_CONDUCTORS` で同時実行数を制限可能（デフォルト: 3）。
- **ペイン幅**: ペイン数が多すぎると cmux コマンドが失敗する。
- **初回 Trust 確認**: 新しいディレクトリで Claude を起動すると信頼確認が表示される。Conductor が自動承認を試みるが、失敗する場合は手動承認が必要。

## テスト

> **⚠️ manager ディレクトリ全体への `bun test` は実行しないでください。**
> 全件実行は O(N²) 級に劣化し、30 分以上ハングします
> （詳細は `.team/artifacts/A021-research.md`）。代わりに個別ファイル iteration を使ってください:
>
> ```bash
> cd skills/cmux-team/manager
> for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do
>   bun test --timeout 30000 "$f" || echo "FAIL: $f"
> done
> ```
>
> CI (`.github/workflows/test.yml`) は PR と main push 時に同じループを実行します。
> 根本原因（module-level singleton の累積）が修正されたら通常実行に戻す予定です。

## 開発への貢献

テスト方法、リポジトリ構造、コーディング規約については [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## ライセンス

MIT License - 詳細は [LICENSE](LICENSE) を参照。
