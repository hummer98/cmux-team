# Seed: cmux-team Skill（4層アーキテクチャ定義）

## File: `skills/cmux-team/SKILL.md`

## Purpose

4層アーキテクチャ（Master → Manager → Conductor → Agent）全体の定義スキル。
**Master（ユーザーセッション）** が読み込み、タスク作成・Manager 監視・進捗報告を行う。

## Frontmatter

```yaml
---
name: cmux-team
description: >
  Use when orchestrating multi-agent development via cmux.
  Triggers: .team/ directory exists, user says "team", "spawn agents",
  "parallel", "sub-agent", or any /team-* command is invoked.
  Provides: agent spawning, monitoring, result collection, synchronization protocols.
---
```

## Content Sections（実装済み）

### 0. アーキテクチャ概要

- 4層構造の図解（Master ↔ ユーザー、Manager daemon、Conductor 常駐、Agent 実作業）
- 各層の責務テーブル
- 通信方式テーブル（ファイルベース + cmux コマンド）

### 1. Master の行動原則

Master の「やること」「やらないこと」を明示:

**やること:**
- ユーザーの指示を解釈し `bun run main.ts create-task` でタスクを作成
- `bun run main.ts status` で進捗を報告
- Manager の健全性を `cmux read-screen` で確認

**やらないこと:**
- コードの読解・実装・テスト・レビュー
- Conductor / Agent の直接起動・監視
- ポーリング・ループ実行

**Manager spawn 手順:**
```bash
cmux new-split right  # → surface:M
cmux rename-tab --surface surface:M "[M] Manager"
cmux send --surface surface:M "claude --dangerously-skip-permissions --model sonnet '...'\n"
# Trust 確認の自動承認ループ
```

**タスクファイル形式:**
- `.team/tasks/<task-id>.md`（YAML frontmatter: id, title, priority）
- 状態は `.team/task-state.json` で管理（draft/ready/assigned/closed）

### 2. Manager プロトコル

Manager は **TypeScript daemon**（`skills/cmux-team/manager/main.ts`）として Bun で動作。

**2.1 タスク検出:**
- `task-state.json` で `status: ready` のタスクをスキャン
- 依存関係（`depends_on`）が全て closed であることを確認

**2.2 Conductor へのタスク割り当て:**
- idle Conductor を見つけ `/clear` + 新プロンプトを送信
- git worktree 作成 + プロンプト生成を daemon が実行
- Conductor は spawn しない（起動時に作成された固定ペインを再利用）

**2.3 Conductor 監視（pull 型）:**
- done マーカーファイル（`.team/output/conductor-N/done`）で完了検出
- 2 tick 連続で検出 → 完了確定（`doneCandidate` パターン）
- フォールバック: `cmux read-screen` で `❯` 検出
- surface 消失 → クラッシュ検出

**2.4 結果回収:**
- Journal 読み取り（task-state.json の closed タスク）
- ログ記録（`manager.log`）
- Conductor リセット（`/clear` 送信 + done マーカー削除）
- **Manager がやらないこと**: タスクの close、Conductor ペインの close、worktree 削除、マージ

**2.5 ループ継続・アイドル化:**
- 10秒ポーリング間隔（メインループ）
- アイドル時: `idle_start` をログに記録

### 3. Conductor プロトコル

Conductor は **常駐 Claude セッション**。タスクを割り当てられると自律的に完遂し、完了後は idle に戻る。

**3.1 タスク受領:** daemon が `/clear` + プロンプト送信
**3.2 git worktree 内で作業:** `.worktrees/run-<EPOCH>/` 内で全作業
**3.3 Agent 起動:** `spawn-agent` CLI で起動（直接 `cmux new-surface` 禁止）
**3.4 Agent 監視:** `cmux read-screen` で `❯` 検出（pull 型、30秒間隔）
**3.5 結果統合:** Agent 出力確認 + テスト実行
**3.6 完了:**
1. Agent タブを close
2. worktree を削除
3. `bun run main.ts close-task` でタスクを close（journal 記録）
4. `touch <outputDir>/done` で done マーカー作成
5. idle 状態に戻る

### 4. Agent プロトコル

- 割り当てられたタスクを実行
- 指定された出力ファイルに結果を書く
- **完了したら停止する。報告は不要。** 上位が検出する
- worktree 内で作業

### 5. 通信プロトコル

**ファイルベース通信:**
```
.team/
├── tasks/             # タスクファイル（フラット構造）
├── task-state.json    # タスク状態管理
├── output/conductor-N/ # Conductor 出力 + done マーカー
├── queue/             # ファイルベースメッセージキュー
├── prompts/           # プロンプト（監査証跡）
├── specs/             # 要件・設計ドキュメント
└── team.json          # チーム構成（daemon 自動管理）
```

**cmux コマンド:**
| コマンド | 用途 |
|---------|------|
| `cmux send` | 上位→下位のプロンプト送信 |
| `cmux send-key return` | 複数行プロンプトの送信確定 |
| `cmux read-screen` | pull 型監視 |
| `cmux close-surface` | Agent タブの終了 |
| `bun run main.ts spawn-agent` | Agent 起動 |

### 6. チーム状態管理

**team.json（daemon 自動管理）:**
```json
{
  "project": "project-name",
  "phase": "init",
  "architecture": "4-tier",
  "manager": { "pid": 12345, "surface": "surface:N", "status": "running" },
  "master": { "surface": "surface:M" },
  "conductors": [
    { "conductorId": "conductor-1", "surface": "surface:C", "status": "idle|running|done", ... }
  ]
}
```

**進捗情報の取得方法（Master 向け）:**
- Manager の状態: `cmux read-screen`
- 稼働中 Conductor: `cmux tree`
- タスク状態: `cat .team/task-state.json`
- 完了履歴: `cat .team/logs/manager.log`

### 7. レイアウト戦略

固定2x2レイアウト（4ペイン、5 surface）:
```
[Manager|Master] | [Conductor-1]
[Conductor-2   ] | [Conductor-3]
```
- 4ペインは不動（close しない）
- サブエージェントは `spawn-agent` CLI でタブ作成
- 最大3タスク並列、4つ目以降はキューイング

### 8. git worktree プロトコル

- 作成: `git worktree add .worktrees/run-<EPOCH> -b <branch>`
- ブートストラップ: `npm install`, `.envrc` 等の初期化
- 成功時: Conductor が commit → マージ（ローカル or PR）→ worktree 削除
- 失敗時: `git worktree remove --force`

### 9. エラーリカバリ

| 障害 | 検出者 | 対応 |
|------|--------|------|
| Agent クラッシュ | Conductor | 再 spawn |
| Conductor クラッシュ | Manager | リセット、タスク reopen |
| Manager クラッシュ | Master | 再 spawn |

### 10. コマンド一覧

**基本コマンド:** `/start`, `/team-status`, `/team-disband`, `/team-spec`, `/team-task`

**daemon CLI サブコマンド:** `start`, `send`, `status`, `stop`, `spawn-agent`, `agents`, `kill-agent`, `create-task`, `update-task`, `close-task`

**手動オーバーライド:** `/team-research`, `/team-design`, `/team-impl`, `/team-review`, `/team-test`, `/team-sync-docs`
