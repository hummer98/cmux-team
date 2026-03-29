---
name: cmux-team
description: >
  Use when orchestrating multi-agent development via cmux.
  Triggers: .team/ directory exists, user says "team", "spawn agents",
  "parallel", "sub-agent", or any /team-* command is invoked.
  Provides: agent spawning, monitoring, result collection, synchronization protocols.
---

# cmux-team: マルチエージェントオーケストレーション

4層アーキテクチャ（Master → Manager → Conductor → Agent）による
自律的マルチエージェント開発オーケストレーションスキル。

## 0. アーキテクチャ概要

### 4層構造

```
[ユーザー] ↔ [Master] → [Manager (daemon)] → [Conductor (常駐)] → [Agent (実作業)]
    │            │              │                       │                      │
    │            │              │                       │                      ├─ コード実装
    │            │              │                       │                      ├─ テスト実行
    │            │              │                       │                      └─ 完了→停止
    │            │              │                       │
    │            │              │                       ├─ git worktree 内で作業
    │            │              │                       ├─ Agent 起動・監視（タブとして作成）
    │            │              │                       ├─ 結果統合
    │            │              │                       ├─ タスクを close（cmux-team close-task）
    │            │              │                       └─ done マーカー作成→idle に戻る
    │            │              │
    │            │              ├─ タスク検出→idle Conductor にタスク割り当て
    │            │              ├─ done マーカーで完了検出（pull 型）
    │            │              └─ Journal 読み取り + ログ記録 + Conductor リセット
    │            │
    │            ├─ タスク作成
    │            ├─ 真のソース直接参照→報告
    │            └─ Manager 健全性確認
    │
    └─ 指示・確認
```

### 各層の責務

| 層 | 責務 | 特徴 |
|----|------|------|
| **Master** | ユーザー対話。タスク作成。真のソース直接参照で進捗報告。 | 作業しない。ポーリングしない。 |
| **Manager** | daemon として常駐。[TASK_CREATED] 通知で起床→タスク検出→idle Conductor にタスク割り当て→done マーカーで完了検出→ログ記録→Conductor リセット→アイドル化。 | アイドル時停止、イベント駆動。 |
| **Conductor** | 常駐。タスクを割り当てられると自律実行。git worktree 隔離。Agent spawn（タブ）→結果統合→タスクを close（`cmux-team close-task`）→done マーカー作成→idle に戻る。 | 常駐。タスク完了後も停止しない。 |
| **Agent** | 実作業（実装・テスト・リサーチ等）。 | 完了したら停止。上位が見に来る。 |

### 通信方式

| 方向 | 手段 |
|------|------|
| Master → Manager | `.team/tasks/` + `task-state.json` + `cmux send` 通知（イベント駆動） |
| Manager → Conductor | `cmux send`（`/clear` + 新プロンプト送信） |
| Manager ← Conductor | done マーカーファイル（`.team/output/conductor-N/done`）の存在確認（pull 型） |
| Conductor → Agent | `cmux send`（プロンプト送信） |
| Conductor ← Agent | pull（`cmux list-status` で Idle/Running 検出） |
| Manager → Master | `.team/logs/manager.log` + `cmux list-status`（直接参照） |

## 1. Master の行動原則

**あなたは Master です。** 以下の原則を厳守すること。

### やること

- ユーザーの指示を解釈し `cmux-team create-task` でタスクを作成（`.team/tasks/` に配置、状態は `task-state.json` で管理）
- 真のソースを直接参照してユーザーに進捗を報告（`cmux-team status`, `ls .team/tasks/`, `manager.log`）
- Manager の健全性を確認（`cmux-team status` で daemon 状態を確認）

### やらないこと

- コードの読解・実装・テスト・レビュー
- Conductor / Agent の直接起動・監視
- ポーリング・ループ実行
- `.team/` 管理ファイル以外のファイル操作

### タスクファイル形式

`.team/tasks/<task-id>.md`（状態は `.team/task-state.json` で管理）:

```markdown
---
id: task-001
title: ログイン機能の実装
priority: high
---

## 要件
ユーザーがメールアドレスとパスワードでログインできるようにする。

## 受け入れ基準
- ...
```

## 2. Manager プロトコル

Manager は **TypeScript daemon** (`skills/cmux-team/manager/main.ts`) として動作する。Sonnet の Claude セッションではなく、Bun で実行される Node/Bun プロセスとして常駐し、キューベースのイベント駆動でタスク検出・Conductor 割り当て・完了検出を行う。

### 2.1 タスク検出

```bash
# タスクファイル一覧
ls .team/tasks/*.md 2>/dev/null

# タスクの状態を確認（status は task-state.json で管理）
cat .team/task-state.json
```

`task-state.json` で `status: ready` のタスクが存在すれば Conductor に割り当てる。なければ待機して再チェック。

### 2.2 Conductor へのタスク割り当て

Conductor は起動時に固定ペインとして常駐している。新しいタスクがある場合、daemon が idle 状態の Conductor を見つけてタスクを割り当てる:

1. daemon が idle Conductor を見つける（done マーカーなし + surface 生存 + `❯` 表示中）
2. worktree 作成・プロンプト生成
3. Conductor の surface に `/clear` + 新プロンプトを送信
4. Conductor がタスク実行開始

```bash
# daemon の assignTask() が以下を実行:
# 1. git worktree 作成
# 2. Conductor プロンプト生成（.team/prompts/conductor-N.md）
# 3. Conductor surface に /clear + プロンプト送信
cmux send --surface surface:C "/clear\n"
sleep 1
cmux send --surface surface:C "${PROMPT}"
sleep 0.5
cmux send-key --surface surface:C "return"
```

**Conductor は spawn しない。** 起動時に作成された固定ペインに対してタスクを送信するだけ。

### 2.3 Conductor 監視（pull 型）

done マーカーファイル（`.team/output/conductor-N/done`）の存在で Conductor の状態を判定する:

```bash
# 主要な判定方法: done マーカーファイル
if [ -f .team/output/conductor-N/done ]; then
  # → 完了
elif cmux tree 2>&1 | grep -q "surface:C"; then
  # done ファイルなし + surface 生存 → 実行中
  echo "Conductor-N: 実行中"
else
  # surface 消失 → クラッシュ
  echo "WARNING: Conductor-N がクラッシュ"
fi
```

**フォールバック:** done マーカーが確認できない場合は `cmux list-status` で Idle 検出を使用する:

```bash
STATUS=$(cmux list-status --workspace workspace:C 2>&1)
# Idle → 完了（アイドル状態）
# Running → 実行中
```

**重要: push ではなく pull 型。Conductor は完了したら done マーカーを作成して idle に戻る。Manager が見に来る。**

### 2.4 結果回収

Conductor 完了（done マーカー検出）後、Manager は以下のみを行う:

```bash
# 1. 完了タスクの Journal を確認（task-state.json で closed のタスクを特定）
cat .team/task-state.json | grep -A5 '"closed"'

# 2. ログ記録
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] task_completed id=<task-id> conductor=conductor-N" >> .team/logs/manager.log

# 3. Conductor リセット（/clear 送信で次のタスクに備える）
cmux send --surface surface:C "/clear\n"

# 4. done マーカーを削除
rm -f .team/output/conductor-N/done
```

**Manager がやらないこと:**
- タスクの close（Conductor が `cmux-team close-task` を実行）
- Conductor ペインの close（persistent — 閉じない）
- worktree の削除（Conductor の責務）
- マージ処理（Conductor が納品方法を判断する）

### 2.5 ループ継続・アイドル化

結果回収後、タスクを再スキャンする。タスクがあれば Conductor を起動、なければアイドル化して Master からの通知を待機。

- **Conductor 稼働中**: 30秒間隔で pull 型監視を実行
- **アイドル時（open tasks ゼロ）**: Manager は停止して待機。`.team/logs/manager.log` に `idle_start` を記録
- **起床トリガー**: Master が新規 issue を作成すると、システムが `[TASK_CREATED]` 通知をユーザーに表示。ユーザーが新しいセッションで Manager を再 spawn するか、既存 Manager ペインで restart コマンドを実行

## 3. Conductor プロトコル

Conductor は **常駐 Claude セッション** として固定ペインに配置される。タスクを割り当てられると自律的に完遂し、完了後は idle 状態に戻って daemon から次のタスクの割り当てを待つ。テンプレート `templates/conductor.md` 参照。

### 3.1 タスク受領

```bash
# Manager が書き出したタスク定義を読む
cat .team/tasks/conductor-N.md
```

### 3.2 git worktree 内で作業

**すべての作業は `.worktrees/conductor-N/` 内で行う。main ブランチは無傷。**

```bash
cd .worktrees/conductor-N
# 以降すべてここで作業
```

### 3.3 Agent 起動

**Agent は必ず `spawn-agent` CLI で起動すること。** 直接 `cmux new-surface` + `cmux send` で起動してはならない。CLI がプロキシ設定・タブ作成・Trust 承認・ログ記録を一括で行う。

```bash
# MAIN_TS のパスを取得（Conductor プロンプトに記載）
MAIN_TS="$PROJECT_ROOT/skills/cmux-team/manager/main.ts"

# 1. プロンプトファイルを作成
PROMPT_FILE="$PROJECT_ROOT/.team/prompts/${CONDUCTOR_ID}-agent-N.md"
cat > "$PROMPT_FILE" << 'AGENT_PROMPT'
# Agent タスク
## 作業内容
<ここにサブタスクの指示を記述>
## 完了条件
<完了条件を記述>
## 完了時
作業が完了したら停止してください。
AGENT_PROMPT

# 2. spawn-agent CLI で起動
RESULT=$(bun run "$MAIN_TS" spawn-agent \
  --conductor-id $CONDUCTOR_ID \
  --role impl \
  --task-title "<サブタスクの簡潔な説明>" \
  --prompt-file "$PROMPT_FILE")
AGENT_SURFACE=$(echo "$RESULT" | grep -o 'SURFACE=surface:[0-9]*' | cut -d= -f2)
```

**禁止事項:**
- `cmux new-surface` で直接タブを作成してはならない
- `cmux send` で直接 `claude` コマンドを送信してはならない
- Claude Code の Agent ツール（サブエージェント）を使ってはならない

**1体ずつ確実に起動すること。** 起動確認（`cmux list-status` で Running 検出）してから次を起動する。

### 3.4 Agent 監視（pull 型）

Manager と同じ判定ロジック:

```bash
STATUS=$(cmux list-status --workspace workspace:A 2>&1)
# Idle → 完了
# Running → 実行中
```

### 3.5 結果統合

- Agent の出力ファイルを確認
- 問題があれば修正指示を追加で `cmux send`
- テストを実行し全パスを確認

### 3.6 完了

Conductor は停止しない。以下の手順で完了処理を行い、idle 状態に戻る:

```bash
# 1. Agent タブをすべて close
cmux send --surface surface:A "/exit\n"
cmux close-surface --surface surface:A

# 2. worktree を削除
cd {{PROJECT_ROOT}}
git worktree remove {{WORKTREE_PATH}} --force 2>/dev/null || true
git branch -d {{CONDUCTOR_ID}}/task 2>/dev/null || true

# 3. タスクを close（task-state.json の status を closed に更新）
cmux-team close-task --task-id <TASK_ID> --journal "タスク完了サマリー"

# 4. done マーカーを作成
touch {{OUTPUT_DIR}}/done

# 5. ❯ プロンプトに戻る（idle 状態）
# daemon がリセット処理（/clear + done マーカー削除）を行う
```

## 4. Agent プロトコル

Agent は実作業を担当する。`cmux-agent-role` スキル参照。

- 割り当てられたタスクを実行する
- 指定された出力ファイルに結果を書く
- **完了したら停止する。報告は不要。** 上位（Conductor）が `cmux list-status` で検出する
- worktree 内で作業すること（Conductor から指定されたディレクトリ）

## 5. 通信プロトコル

### ファイルベース通信

`.team/` ディレクトリ構造:

```
.team/
├── tasks/             # タスクファイル（フラット構造）
├── task-state.json    # タスク状態管理（status: draft/ready/assigned/closed）
├── output/
│   └── conductor-N/   # Conductor が書く、Manager が読む
│       └── summary.md
├── prompts/           # 各層がプロンプト生成時に書き出す（監査証跡）
├── specs/             # 要件・設計ドキュメント
├── traces/            # SQLite トレースDB + JSONL ログ
│   └── traces.db      # FTS5 全文検索対応
└── team.json          # チーム構成（Master が初期化）
```

### cmux コマンド通信

| コマンド | 用途 |
|---------|------|
| `cmux send` | 上位→下位のプロンプト送信 |
| `cmux send-key return` | 複数行プロンプトの送信確定 |
| `cmux list-status` | 上位が下位の状態を取得する（pull 型監視、hooks ベース） |
| `cmux read-screen` | 上位が下位の画面テキストを読む（Trust 確認・エラー確認） |
| `cmux close-surface` | 完了した Agent タブの終了 |
| `cmux-team spawn-agent` | Agent 起動（タブ作成・プロキシ設定・Trust 承認を一括実行） |

### 複数行テキスト送信の注意

**単一行テキスト**（シェルコマンドなど）は末尾 `\n` で送信可能。
**複数行テキスト**（プロンプトなど）は `\n` では送信されない。以下の手順を使うこと:

```bash
# 1. テキストを送信（\n を付けない）
cmux send --surface surface:M "${PROMPT}"
# 2. 明示的に Enter を送信
sleep 0.5
cmux send-key --surface surface:M "return"
```

## 6. チーム状態管理

### team.json（daemon が自動管理）

team.json は daemon の `updateTeamJson()` が定期的に自動更新する。Master、Conductor、手動コマンドから直接書き込んではならない。

```json
{
  "project": "project-name",
  "description": "",
  "phase": "init",
  "architecture": "4-tier",
  "created_at": "2026-03-23T00:00:00Z",
  "manager": {
    "pid": 12345,
    "surface": "surface:N",
    "status": "running"
  },
  "master": {
    "surface": "surface:M"
  },
  "conductors": [],
  "completed_outputs": []
}
```

### 進捗情報の取得方法（Master 向け）

status.json は廃止。Master は以下の真のソースから直接情報を取得する:

| 情報 | 真のソース | 取得方法 |
|------|-----------|---------|
| Manager の状態 | Manager workspace | `cmux list-status --workspace MANAGER_WS` |
| 稼働中 Conductor | cmux ペイン構成 | `cmux tree` |
| open task 数 | task-state.json | `cat .team/task-state.json`（status で絞り込み） |
| 完了タスク履歴 | ログ | `cat .team/logs/manager.log` |

## 7. レイアウト戦略

### 基本方針: 固定2x2レイアウト

起動時に固定の2x2レイアウト（4ペイン、5 surface）を作成し、セッション終了まで変更しない。

```
[Manager|Master] | [Conductor-1]
[Conductor-2   ] | [Conductor-3]
```

- **左上**: Manager（daemon）| Master（ユーザーセッション）— 2つの surface がタブとして同居
- **右上**: Conductor-1（常駐 Claude セッション）
- **左下**: Conductor-2（常駐 Claude セッション）
- **右下**: Conductor-3（常駐 Claude セッション）

### レイアウトの特徴

- **4ペイン（5 surface）は不動** — close しない
- **サブエージェント**は `spawn-agent` CLI で Conductor ペイン内にタブとして作成（直接 `cmux new-surface` を使わない）
- **最大3タスク並列**、4つ目以降はキューイング
- **タスク完了時**: Conductor が `cmux-team close-task` でタスクを close、done マーカー作成

### サブエージェントの配置

サブエージェントは `spawn-agent` CLI で起動する。CLI が Conductor ペイン内にタブを作成し、プロキシ設定・Trust 承認を自動処理する:

```bash
bun run "$MAIN_TS" spawn-agent \
  --conductor-id $CONDUCTOR_ID \
  --role impl \
  --task-title "サブタスク名" \
  --prompt-file "$PROMPT_FILE"
```

タブはペインのスペースを消費しないため、レイアウトが崩れない。Conductor はタブを切り替えて Agent の画面を確認できる。

### 注意事項

- ペイン幅・高さが狭すぎると `cmux send` や `cmux read-screen` が正常に動作しない
- Agent のタブはタスク完了時に close する（ペインは残す）
- Conductor ペインは常に残る — 異常終了時もレイアウトは維持される

## 8. git worktree プロトコル

### 作成

```bash
git worktree add .worktrees/conductor-N -b conductor-N/task
```

### ブートストラップ（作成直後に必ず実行）

git worktree は tracked files のみチェックアウトする。`.gitignore` されたディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）は手動で再構築する必要がある。

```bash
cd .worktrees/conductor-N

# 依存関係のインストール
npm install  # or yarn install, pnpm install

# プロジェクト固有の初期化（例: scaffold からのコピー）
# 各プロジェクトの README や CLAUDE.md を参照して必要な手順を確認

# 環境変数
direnv allow  # .envrc がある場合
```

**重要**: 必要な初期化手順はプロジェクトごとに異なる。worktree 作成後、作業開始前に以下を確認すること:
- `package.json` があれば `npm install`
- `.gitignore` に記載されたビルド成果物やランタイムディレクトリの有無
- `.envrc` や環境変数の設定

### 作業

Agent はすべて worktree 内で作業する。main ブランチは常に無傷。

### 成功時

```bash
# Conductor が worktree 内で commit
cd .worktrees/conductor-N
git add -A
git commit -m "conductor-N: タスク完了"

# Manager が main にマージ
cd /path/to/project
git merge conductor-N/task

# worktree を削除
git worktree remove .worktrees/conductor-N
git branch -D conductor-N/task
```

### 失敗時

```bash
git worktree remove --force .worktrees/conductor-N
git branch -D conductor-N/task
```

## 9. エラーリカバリ

| 障害 | 検出者 | 対応 |
|------|--------|------|
| Agent クラッシュ | Conductor | `cmux list-status` で cN 消失検出 → ペイン閉じて再 spawn |
| Conductor クラッシュ | Manager | `cmux list-status` で Idle のまま done マーカーなし → ペイン閉じて再 spawn、または abort してタスクを reopen |
| Manager クラッシュ | Master | `cmux list-status` で Manager が応答なし → ペイン閉じて再 spawn |
| API レート制限 | 各層 | 待機して再試行。同時 Agent 数を減らす |

### 異常検出の基準

```bash
STATUS=$(cmux list-status --workspace workspace:X 2>&1)

# 正常パターン:
# - Running → 実行中
# - Idle → アイドル（完了）

# 異常パターン（list-status で検出できない場合は read-screen にフォールバック）:
SCREEN=$(cmux read-screen --surface surface:X 2>&1)
# - シェルプロンプト ($, %) が見える → Claude が終了した
# - エラーメッセージが見える → クラッシュ
# - 画面が空 → ペインが消えた
```

## 10. コマンド一覧

### スラッシュコマンド（Claude 内）

| コマンド | 説明 |
|---------|------|
| `/master` | Master ロール再読み込み（`/clear` 後の復帰用） |
| `/team-spec` | 要件ブレスト（Master が直接ユーザーと対話） |
| `/team-task` | タスク管理（タスクの作成・一覧・クローズ） |
| `/team-archive` | 完了タスクのアーカイブ（closed → archived） |

### CLI サブコマンド

チーム体制の構築・管理はすべて CLI 経由で行う:

| コマンド | 説明 |
|---------|------|
| `cmux-team start` | daemon 起動 + Master spawn + レイアウト構築 |
| `cmux-team status` | ステータス表示（team.json + ログ末尾） |
| `cmux-team stop` | graceful shutdown（SHUTDOWN メッセージ送信） |
| `cmux-team send TASK_CREATED` | タスク作成通知（`--task-id`, `--task-file` 必須） |
| `cmux-team send TODO` | TODO 通知（`--content` 必須） |
| `cmux-team send SHUTDOWN` | シャットダウン通知 |
| `cmux-team spawn-agent` | Agent spawn（`--conductor-id`, `--role`, `--prompt` or `--prompt-file`） |
| `cmux-team agents` | 稼働中エージェント一覧 |
| `cmux-team kill-agent` | Agent 終了（`--surface` 必須、`--conductor-id` 任意） |
| `cmux-team create-task` | タスク作成（`--title` 必須、`--priority`, `--status`, `--body` 任意） |
| `cmux-team update-task` | タスク状態更新（`--task-id`, `--status` 必須） |
| `cmux-team close-task` | タスククローズ（`--task-id` 必須、`--journal` 任意） |
| `cmux-team trace` | API トレース検索（`--task`, `--search`, `--show`） |

## 11. トレーサビリティ

daemon 起動時に API Proxy が自動起動し、全 API リクエストを SQLite FTS5 データベースに記録する。Master が過去の作業ログを検索・分析する際に活用できる。

### 自動プロキシ設定

daemon が起動すると Proxy が自動で立ち上がり、Master および Conductor に `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` を設定する。これにより全 API リクエストが Proxy 経由になり、リクエスト/レスポンスが自動記録される。

### メタデータ伝播

リクエストヘッダーからメタデータを動的に抽出し、トレースに紐付ける:

| ヘッダー | 内容 |
|---------|------|
| `x-cmux-task-id` | タスクID |
| `x-cmux-conductor-id` | Conductor ID |
| `x-cmux-role` | エージェントロール |
| `x-claude-code-session-id` | Claude Code セッションID |

### trace CLI

`cmux-team trace` コマンドでトレースを検索・表示できる:

```bash
# タスクIDでフィルタ
cmux-team trace --task 035

# 全文検索（SQLite FTS5）
cmux-team trace --search "error"

# 特定トレースの詳細表示（リクエスト/レスポンス本文含む）
cmux-team trace --show 42

# Conductor IDでフィルタ
cmux-team trace --conductor conductor-1

# ロールでフィルタ
cmux-team trace --role impl

# 結果数制限（デフォルト20）
cmux-team trace --limit 50
```

### 活用例

Master がユーザーに進捗報告する際、過去の API リクエスト履歴を参照できる:

```bash
# あるタスクでどんな API リクエストが行われたか確認
cmux-team trace --task 035

# エラーに関連するリクエストを全文検索
cmux-team trace --search "rate_limit"
```
