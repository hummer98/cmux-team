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
    │            │              │                       ├─ タスクファイルを closed/ に移動
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
| **Conductor** | 常駐。タスクを割り当てられると自律実行。git worktree 隔離。Agent spawn（タブ）→結果統合→タスクファイルを closed/ に移動→done マーカー作成→idle に戻る。 | 常駐。タスク完了後も停止しない。 |
| **Agent** | 実作業（実装・テスト・リサーチ等）。 | 完了したら停止。上位が見に来る。 |

### 通信方式

| 方向 | 手段 |
|------|------|
| Master → Manager | `.team/tasks/open/` + `cmux send` 通知（イベント駆動） |
| Manager → Conductor | `cmux send`（`/clear` + 新プロンプト送信） |
| Manager ← Conductor | done マーカーファイル（`.team/output/conductor-N/done`）の存在確認（pull 型） |
| Conductor → Agent | `cmux send`（プロンプト送信） |
| Conductor ← Agent | pull（`cmux read-screen` で `❯` 検出） |
| Manager → Master | `.team/logs/manager.log` + `cmux read-screen`（直接参照） |

## 1. Master の行動原則

**あなたは Master です。** 以下の原則を厳守すること。

### やること

- ユーザーの指示を解釈し `.team/tasks/open/` にタスクファイルを作成
- `/team-init` で Manager を spawn
- 真のソースを直接参照してユーザーに進捗を報告（`cmux tree`, `ls .team/tasks/`, `manager.log`, `cmux read-screen`）
- Manager の健全性を `cmux read-screen` で確認（Manager が止まっていたら再 spawn）

### やらないこと

- コードの読解・実装・テスト・レビュー
- Conductor / Agent の直接起動・監視
- ポーリング・ループ実行
- `.team/` 管理ファイル以外のファイル操作

### Manager spawn 手順

```bash
# 1. Manager 用ペインを作成
cmux new-split right  # → surface:M
cmux rename-tab --surface surface:M "[M] Manager"

# 2. Claude を初期プロンプト付きで起動（Sonnet）
cmux send --surface surface:M "claude --dangerously-skip-permissions --model sonnet '.team/prompts/manager.md を読んで指示に従って作業を開始してください。'\n"

# 3. Trust 確認が出たら承認
for i in $(seq 1 10); do
  SCREEN=$(cmux read-screen --surface surface:M 2>&1)
  if echo "$SCREEN" | grep -q "Yes, I trust"; then
    cmux send-key --surface surface:M "return"
    sleep 3; break
  elif echo "$SCREEN" | grep -qE '(Thinking|Reading|❯)'; then
    break
  fi
  sleep 3
done
```

### タスクファイル形式

`.team/tasks/open/<task-id>.md`:

```markdown
---
id: task-001
title: ログイン機能の実装
priority: high
created_at: 2026-03-23T00:00:00Z
---

## 要件
ユーザーがメールアドレスとパスワードでログインできるようにする。

## 受け入れ基準
- ...
```

## 2. Manager プロトコル

Manager は別ペインでイベント駆動で動作する（Sonnet モデル）。テンプレート `templates/manager.md` 参照。

### 2.1 タスク検出

```bash
# .team/tasks/open/ を走査
ls .team/tasks/open/*.md 2>/dev/null
```

タスクが存在すれば Conductor を起動する。なければ待機して再チェック。

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
elif bash .team/scripts/validate-surface.sh surface:C; then
  # done ファイルなし + surface 生存 → 実行中
  echo "Conductor-N: 実行中"
else
  # surface 消失 → クラッシュ
  echo "WARNING: Conductor-N がクラッシュ"
fi
```

**フォールバック:** done マーカーが確認できない場合は `cmux read-screen` で `❯` 検出を使用する:

```bash
SCREEN=$(cmux read-screen --surface surface:C 2>&1)
# ❯ あり AND "esc to interrupt" なし → 完了（アイドル状態）
# ❯ あり AND "esc to interrupt" あり → 実行中
```

**重要: push ではなく pull 型。Conductor は完了したら done マーカーを作成して idle に戻る。Manager が見に来る。**

### 2.4 結果回収

Conductor 完了（done マーカー検出）後、Manager は以下のみを行う:

```bash
# 1. Journal（タスクファイルに追記された作業サマリー）を読み取る
TASK_FILE=$(ls .team/tasks/closed/*-conductor-N.md 2>/dev/null | head -1)
if [ -n "$TASK_FILE" ]; then
  cat "$TASK_FILE"
fi

# 2. ログ記録
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] task_completed id=<task-id> conductor=conductor-N" >> .team/logs/manager.log

# 3. Conductor リセット（/clear 送信で次のタスクに備える）
cmux send --surface surface:C "/clear\n"

# 4. done マーカーを削除
rm -f .team/output/conductor-N/done
```

**Manager がやらないこと:**
- タスクファイルの closed/ 移動（Conductor の責務）
- Conductor ペインの close（persistent — 閉じない）
- worktree の削除（Conductor の責務）
- マージ処理（Conductor が納品方法を判断する）

### 2.5 ループ継続・アイドル化

結果回収後、タスクを再スキャンする。タスクがあれば Conductor を起動、なければアイドル化して Master からの通知を待機。

- **Conductor 稼働中**: 30秒間隔で pull 型監視を実行
- **アイドル時（open tasks ゼロ）**: Manager は停止して待機。`.team/logs/manager.log` に `idle_start` を記録
- **起床トリガー**: Master が新規 issue を作成すると、システムが `[TASK_CREATED]` 通知をユーザーに表示。ユーザーが新しいセッションで Manager を再 spawn するか、既存 Manager ペインで restart コマンドを実行

## 3. Conductor プロトコル

Conductor は1つのタスクを自律的に完遂する。テンプレート `templates/conductor.md` 参照。

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

```bash
# サブエージェントを Conductor のペインにタブとして作成
cmux new-surface --pane <conductor-pane-id>  # → surface:A
cmux rename-tab --surface surface:A "[A] Agent"

# Claude を初期プロンプト付きで起動
cmux send --surface surface:A "claude --dangerously-skip-permissions '.team/prompts/agent-N.md を読んで指示に従って作業してください。'\n"

# Trust 確認が出たら承認（§1 と同じ手順）
```

**サブエージェントはタブとして作成する。** ペインを split するのではなく、Conductor と同じペイン内の新しいタブとして起動する。これによりレイアウトが固定のまま維持される。

**1体ずつ確実に起動すること。** 起動確認（`cmux read-screen` で処理開始を検出）してから次を起動する。

### 3.4 Agent 監視（pull 型）

Manager と同じ判定ロジック:

```bash
SCREEN=$(cmux read-screen --surface surface:A 2>&1)
# ❯ あり AND "esc to interrupt" なし → 完了
# ❯ あり AND "esc to interrupt" あり → 実行中
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

# 3. タスクファイルを closed/ に移動
TASK_FILE=$(ls {{PROJECT_ROOT}}/.team/tasks/open/*-{{ROLE_ID}}.md 2>/dev/null | head -1)
if [ -n "$TASK_FILE" ]; then
  mkdir -p {{PROJECT_ROOT}}/.team/tasks/closed
  mv "$TASK_FILE" {{PROJECT_ROOT}}/.team/tasks/closed/
fi

# 4. done マーカーを作成
touch {{OUTPUT_DIR}}/done

# 5. ❯ プロンプトに戻る（idle 状態）
# daemon がリセット処理（/clear + done マーカー削除）を行う
```

## 4. Agent プロトコル

Agent は実作業を担当する。`cmux-agent-role` スキル参照。

- 割り当てられたタスクを実行する
- 指定された出力ファイルに結果を書く
- **完了したら停止する。報告は不要。** 上位（Conductor）が `cmux read-screen` で検出する
- worktree 内で作業すること（Conductor から指定されたディレクトリ）

## 5. 通信プロトコル

### ファイルベース通信

`.team/` ディレクトリ構造:

```
.team/
├── tasks/
│   ├── open/          # Master が作成、Manager が読む
│   └── closed/        # Manager が完了時に移動
├── output/
│   └── conductor-N/   # Conductor が書く、Manager が読む
│       └── summary.md
├── prompts/           # 各層がプロンプト生成時に書き出す（監査証跡）
├── specs/             # 要件・設計ドキュメント
└── team.json          # チーム構成（Master が初期化）
```

### cmux コマンド通信

| コマンド | 用途 |
|---------|------|
| `cmux send` | 上位→下位のプロンプト送信 |
| `cmux send-key return` | 複数行プロンプトの送信確定 |
| `cmux read-screen` | 上位が下位の画面を読む（pull 型監視） |
| `cmux close-surface` | 完了した Agent タブの終了 |
| `cmux new-surface --pane` | Conductor ペイン内にサブエージェントをタブとして作成 |

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

### team.json（Master が初期化）

```json
{
  "project": "project-name",
  "description": "",
  "phase": "init",
  "architecture": "4-tier",
  "created_at": "2026-03-23T00:00:00Z",
  "manager": {
    "surface": "surface:N",
    "status": "running"
  },
  "conductors": [],
  "completed_outputs": []
}
```

### 進捗情報の取得方法（Master 向け）

status.json は廃止。Master は以下の真のソースから直接情報を取得する:

| 情報 | 真のソース | 取得方法 |
|------|-----------|---------|
| Manager の状態 | Manager ペイン | `cmux read-screen --surface MANAGER` |
| 稼働中 Conductor | cmux ペイン構成 | `cmux tree` |
| open task 数 | task ファイル | `ls .team/tasks/open/` |
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
- **サブエージェント**は Conductor のペインに新規タブ（`cmux new-surface --pane`）として作成
- **最大3タスク並列**、4つ目以降はキューイング
- **タスク完了時**: Conductor が自らタスクファイルを closed/ に移動、done マーカー作成

### サブエージェントの配置

サブエージェントはペイン分割ではなく、Conductor ペイン内のタブとして作成する:

```bash
# Conductor-1 のペインにサブエージェントをタブとして追加
cmux new-surface --pane <conductor-1-pane-id>  # → surface:A
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
| Agent クラッシュ | Conductor | `cmux read-screen` で異常検出 → ペイン閉じて再 spawn |
| Conductor クラッシュ | Manager | `cmux read-screen` で異常検出 → ペイン閉じて再 spawn、または abort してタスクを reopen |
| Manager クラッシュ | Master | `cmux read-screen` で Manager ペインが応答なし → ペイン閉じて再 spawn |
| API レート制限 | 各層 | 待機して再試行。同時 Agent 数を減らす |

### 異常検出の基準

```bash
SCREEN=$(cmux read-screen --surface surface:X 2>&1)

# 正常パターン:
# - "esc to interrupt" が含まれる → 実行中
# - ❯ が含まれ "esc to interrupt" がない → アイドル（完了）

# 異常パターン:
# - シェルプロンプト ($, %) が見える → Claude が終了した
# - エラーメッセージが見える → クラッシュ
# - 画面が空 → ペインが消えた
```

## 10. コマンド一覧

### 基本コマンド

| コマンド | 説明 |
|---------|------|
| `/start` | チーム体制構築（Master + Manager 起動） |
| `/team-status` | ステータス表示（真のソース直接参照） |
| `/team-disband` | 全層終了（Agent → Conductor → Manager の順で bottom-up） |
| `/team-spec` | 要件ブレスト（Master が直接ユーザーと対話） |
| `/team-task` | タスク管理（タスクの作成・一覧・クローズ） |

### 手動オーバーライド（Manager を経由せず直接実行）

| コマンド | 説明 |
|---------|------|
| `/team-research` | リサーチ直接実行 |
| `/team-design` | 設計直接実行 |
| `/team-impl` | 実装直接実行 |
| `/team-review` | レビュー直接実行 |
| `/team-test` | テスト直接実行 |
| `/team-sync-docs` | ドキュメント同期直接実行 |
