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
[ユーザー] ↔ [Master] → [Manager (ループ)] → [Conductor (タスク駆動)] → [Agent (実作業)]
    │            │              │                       │                      │
    │            │              │                       │                      ├─ コード実装
    │            │              │                       │                      ├─ テスト実行
    │            │              │                       │                      └─ 完了→停止
    │            │              │                       │
    │            │              │                       ├─ git worktree 内で作業
    │            │              │                       ├─ Agent 起動・監視
    │            │              │                       └─ 結果統合→停止
    │            │              │
    │            │              ├─ issue 検出→Conductor spawn
    │            │              ├─ pull 型監視→結果回収
    │            │              └─ issue クローズ→ループ継続
    │            │
    │            ├─ issue 作成
    │            ├─ status.json 読み取り→報告
    │            └─ Manager 健全性確認
    │
    └─ 指示・確認
```

### 各層の責務

| 層 | 責務 | 特徴 |
|----|------|------|
| **Master** | ユーザー対話。issue 作成。status.json 読み取り。 | 作業しない。ポーリングしない。 |
| **Manager** | 別ペインでループ実行。issue 検出→Conductor spawn→結果回収→issue クローズ。 | 常駐ループ。 |
| **Conductor** | 1タスクを自律実行。git worktree 隔離。Agent spawn→結果統合。 | タスク完了で停止。 |
| **Agent** | 実作業（実装・テスト・リサーチ等）。 | 完了したら停止。上位が見に来る。 |

### 通信方式

| 方向 | 手段 |
|------|------|
| Master → Manager | `.team/issues/open/` （ファイルベース） |
| Manager → Conductor | `cmux send` （プロンプト送信） |
| Manager ← Conductor | pull（`cmux read-screen` で `❯` 検出） |
| Conductor → Agent | `cmux send` （プロンプト送信） |
| Conductor ← Agent | pull（`cmux read-screen` で `❯` 検出） |
| Manager → Master | `.team/status.json` （ファイルベース） |

## 1. Master の行動原則

**あなたは Master です。** 以下の原則を厳守すること。

### やること

- ユーザーの指示を解釈し `.team/issues/open/` に issue ファイルを作成
- `/team-init` で Manager を spawn
- `status.json` を読んでユーザーに進捗を報告
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

# 2. Claude を初期プロンプト付きで起動（Trust 承認後すぐに実行される）
cmux send --surface surface:M "claude --dangerously-skip-permissions '.team/prompts/manager.md を読んで指示に従って作業を開始してください。'\n"

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

### issue ファイル形式

`.team/issues/open/<issue-id>.md`:

```markdown
---
id: issue-001
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

Manager は別ペインで常駐ループを実行する。テンプレート `templates/manager.md` 参照。

### 2.1 Issue 検出

```bash
# .team/issues/open/ を走査
ls .team/issues/open/*.md 2>/dev/null
```

issue が存在すれば Conductor を起動する。なければ待機して再チェック。

### 2.2 Conductor 起動

```bash
# 1. ペイン作成（§7 グリッドレイアウトに従い right/down を使い分ける）
cmux new-split down  # → surface:C

# 2. git worktree 作成
git worktree add .worktrees/conductor-N -b conductor-N/task

# 3. Conductor プロンプトを生成
# タスク定義を .team/tasks/conductor-N.md に書き出す
# テンプレートから .team/prompts/conductor-N.md を合成

# 4. Claude を初期プロンプト付きで起動
cmux rename-tab --surface surface:C "[C] Conductor"
cmux send --surface surface:C "claude --dangerously-skip-permissions '.team/prompts/conductor-N.md を読んで指示に従って作業してください。'\n"

# 5. Trust 確認が出たら承認（§1 と同じ手順）
```

### 2.3 Conductor 監視（pull 型）

定期的に `cmux read-screen` で Conductor の状態を判定する:

```bash
SCREEN=$(cmux read-screen --surface surface:C 2>&1)

# 判定ロジック:
# ❯ あり AND "esc to interrupt" なし → 完了（アイドル状態）
# ❯ あり AND "esc to interrupt" あり → 実行中
# ❯ なし → 起動中 or クラッシュ
```

**重要: push ではなく pull 型。Conductor は完了したら停止するだけ。Manager が見に来る。**

### 2.4 結果回収

Conductor 完了を検出したら:

```bash
# 1. 結果を読む
cat .team/output/conductor-N/summary.md

# 2. issue を closed に移動
mv .team/issues/open/issue-XXX.md .team/issues/closed/

# 3. Conductor ペインを閉じる
cmux send --surface surface:C "/exit\n"
cmux close-surface --surface surface:C

# 4. worktree ブランチをマージ（テストパス時）
cd .worktrees/conductor-N
git add -A && git commit -m "conductor-N: タスク完了"
cd ../..
git merge conductor-N/task

# 5. worktree を削除
git worktree remove .worktrees/conductor-N
git branch -D conductor-N/task
```

### 2.5 ステータス更新

ループのたびに `.team/status.json` を更新する:

```bash
# status.json を書き出す（Master が読む）
```

### 2.6 ループ継続

結果回収後、再び §2.1 に戻り次の issue を探す。issue がなければ短い間隔で待機。

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
# 1. ペイン作成（§7 グリッドレイアウトに従い right/down を使い分ける）
cmux new-split down  # → surface:A
cmux rename-tab --surface surface:A "[A] Agent"

# 2. Claude を初期プロンプト付きで起動
cmux send --surface surface:A "claude --dangerously-skip-permissions '.team/prompts/agent-N.md を読んで指示に従って作業してください。'\n"

# 3. Trust 確認が出たら承認（§1 と同じ手順）
```

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

```bash
# 1. 結果サマリを書き出す
# .team/output/conductor-N/summary.md に結果を書く

# 2. Agent ペインをすべて閉じる
cmux send --surface surface:A "/exit\n"
cmux close-surface --surface surface:A

# 3. 自分は停止する（❯ に戻る）
# Manager が cmux read-screen で検出する
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
├── issues/
│   ├── open/          # Master が作成、Manager が読む
│   └── closed/        # Manager が完了時に移動
├── tasks/             # Manager が作成、Conductor が読む
├── output/
│   └── conductor-N/   # Conductor が書く、Manager が読む
│       └── summary.md
├── prompts/           # 各層がプロンプト生成時に書き出す（監査証跡）
├── specs/             # 要件・設計ドキュメント
├── team.json          # チーム構成（Master が初期化）
└── status.json        # Manager が更新、Master が読む
```

### cmux コマンド通信

| コマンド | 用途 |
|---------|------|
| `cmux send` | 上位→下位のプロンプト送信 |
| `cmux send-key return` | 複数行プロンプトの送信確定 |
| `cmux read-screen` | 上位が下位の画面を読む（pull 型監視） |
| `cmux close-surface` | 完了した下位ペインの終了 |
| `cmux new-split right/down` | サブペインの作成（グリッドレイアウト） |

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

### status.json（Manager が管理）

```json
{
  "updated_at": "2026-03-23T00:01:00Z",
  "manager": {
    "surface": "surface:N",
    "status": "monitoring",
    "loop_count": 5
  },
  "conductors": [
    {
      "id": "conductor-1",
      "surface": "surface:C",
      "task": "ログイン機能の実装",
      "status": "running",
      "agents": [
        { "id": "agent-1", "surface": "surface:A", "status": "running" }
      ]
    }
  ],
  "completed_tasks": [
    { "id": "conductor-0", "task": "初期セットアップ", "completed_at": "..." }
  ],
  "issues": {
    "open": 2,
    "closed": 3
  }
}
```

## 7. レイアウト戦略

### 基本方針: グリッドレイアウト

`new-split right` だけで横に並べると、ペインが 1/2 → 1/4 → 1/8 と狭くなる。
**`right` と `down` を組み合わせてグリッド状に配置する。**

### 2ペイン（Master + Manager）

```bash
cmux new-split right  # → [Master] | [Manager]
```

### 4ペイン（2x2 グリッド）

```bash
# 1. 左右に分割
cmux new-split right  # → [Master] | [Manager]

# 2. Master 側（左）を上下に分割
cmux new-split down  # → [Master] の下に [Conductor]

# 3. Manager 側（右）を上下に分割
cmux new-split down --surface surface:M  # → [Manager] の下に [Agent]
```

結果:
```
[Master    ] | [Manager  ]
[Conductor ] | [Agent    ]
```

### 6ペイン（2x3 グリッド）

```
[Master    ] | [Manager  ]
[Conductor ] | [Agent A  ]
[Agent B   ] | [Agent C  ]
```

上下分割を追加で行うことで均等なサイズを維持する。

### 分割方向の選び方

| ペイン数 | 分割方法 |
|---------|---------|
| 2 | `right` 1回 |
| 3-4 | `right` + `down` で 2x2 |
| 5-6 | 2x3 グリッド |
| 7+ | ワークスペースを分ける |

### 注意事項

- ペイン幅・高さが狭すぎると `cmux send` や `cmux read-screen` が正常に動作しない
- 完了した Agent のペインは即座に閉じてスペースを確保する
- 7ペイン以上はワークスペースを分けて対応する

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
| Conductor クラッシュ | Manager | `cmux read-screen` で異常検出 → ペイン閉じて再 spawn、または abort して issue を reopen |
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
| `/team-status` | ステータス表示（status.json 読み取り） |
| `/team-disband` | 全層終了（Agent → Conductor → Manager の順で bottom-up） |
| `/team-spec` | 要件ブレスト（Master が直接ユーザーと対話） |
| `/team-issue` | イシュー管理（issue の作成・一覧・クローズ） |

### 手動オーバーライド（Manager を経由せず直接実行）

| コマンド | 説明 |
|---------|------|
| `/team-research` | リサーチ直接実行 |
| `/team-design` | 設計直接実行 |
| `/team-impl` | 実装直接実行 |
| `/team-review` | レビュー直接実行 |
| `/team-test` | テスト直接実行 |
| `/team-sync-docs` | ドキュメント同期直接実行 |
