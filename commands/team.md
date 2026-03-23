---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
description: "チーム体制を構築し Master モードに入る"
---

# /team

現在のワークスペースを cmux-team 構成にし、Master モードに入ってください。

## 手順

### Phase 0: インフラ準備（初回のみ）

`.team/` が存在しなければ作成する:

1. cmux 環境チェック (`CMUX_SOCKET_PATH`)
   - 設定されていなければエラー（cmux 内でのみ動作）
2. `.team/` ディレクトリ構造を作成:
   - team.json, status.json, specs/, output/, issues/open/, issues/closed/, tasks/, prompts/, docs-snapshot/
3. team.json 初期化（`architecture: "4-tier"`）
4. status.json 初期化（空状態）
5. `.team/.gitignore` 作成 (output/, prompts/, docs-snapshot/, status.json)
6. `.gitignore` に `.worktrees/` が含まれていなければ追加を提案

### Phase 1: Master ペインの識別

```bash
cmux rename-tab "Master"
```

### Phase 2: Manager 起動

1. Manager 用プロンプトを生成:
   - templates/common-header.md + templates/manager.md からプロンプトを合成
   - `.team/prompts/manager.md` に書き出す
2. Manager を spawn:
   ```bash
   cmux new-split right  # → surface:N
   cmux rename-tab --surface surface:N "Manager"
   cmux send --surface surface:N "claude --dangerously-skip-permissions\n"
   ```
3. Trust 確認ポーリング → 承認
4. ❯ 検出後: プロンプトを送信
   ```bash
   cmux send --surface surface:N ".team/prompts/manager.md を読んで、その指示に従って作業を開始してください。\n"
   ```
5. team.json を更新（manager.surface を記録）

### Phase 3: 準備完了報告

```
チーム準備完了。

  [Master ✳]  |  [Manager ⚡]

何をしますか？タスクを伝えてください。
例: 「ログイン機能を実装して」「README を更新して」「テストを追加して」
```

### Phase 4: Master として待機

**あなたは Master です。** cmux-team スキル（SKILL.md）のセクション 1 に従ってください。

- ユーザーからタスクを受け取ったら → `.team/issues/open/` に issue を作成
  - Manager が自動的に検出して Conductor を起動する
- 「状況は？」→ `.team/status.json` を読んで報告
- 「あとこれもやって」→ 新しい issue を追加作成
- Manager の健全性を定期的に確認（`cmux read-screen` で生存確認）

## 引数

なし

## 注意事項

- `.team/` が既に存在する場合はインフラ準備をスキップ
- Manager が既に稼働中なら再起動せず、「チーム稼働中。タスクを伝えてください。」と案内
- Conductor や Agent は Manager が必要に応じて spawn する（`/team` では起動しない）
- 自分でコードを書かない、調査しない — すべて Manager → Conductor → Agent に委譲
