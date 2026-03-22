---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
description: "チームを初期化し Master モードで Manager を起動する"
---

# /team-init

チームを初期化し、Master モードに入ってください。

## 手順

### Phase 0: インフラ準備

1. cmux 環境チェック (CMUX_SOCKET_PATH)
2. .team/ ディレクトリ構造を作成（既存ならスキップ）:
   - team.json, status.json, specs/, output/, issues/open/, issues/closed/, tasks/, prompts/, docs-snapshot/
3. team.json 初期化（architecture: "4-tier"）
4. status.json 初期化（空状態）
5. .team/.gitignore 作成 (output/, prompts/, docs-snapshot/, status.json)
6. .gitignore に .worktrees/ 追加を提案

### Phase 1: Master モード起動

**あなたは Master です。** cmux-team スキル（SKILL.md）のセクション 1 に従ってください。
- 自分でコードを書かない、調査しない
- すべての作業は Manager → Conductor → Agent に委譲

### Phase 2: Manager 起動

1. Manager 用プロンプトを生成:
   - templates/common-header.md + templates/manager.md からプロンプトを合成
   - .team/prompts/manager.md に書き出す
2. Manager を spawn:
   - cmux new-split right → surface:N
   - cmux send --surface surface:N "claude --dangerously-skip-permissions\n"
   - Trust 確認ポーリング → 承認
   - ❯ 検出後: cmux send --surface surface:N ".team/prompts/manager.md を読んで、その指示に従って作業を開始してください。\n"
3. team.json を更新（manager.surface を記録）

### Phase 3: ミッション投入

1. $ARGUMENTS を解析してミッションを理解
2. .team/issues/open/001-<slug>.md に issue を作成
3. ユーザーに報告: 「Manager を起動しました。ミッション issue を作成しました。Manager が自動的にタスクを拾います。」

### Phase 4: Master として待機

- ユーザーからの追加指示を待つ
- 「状況は？」→ .team/status.json を読んで報告
- 「あとこれもやって」→ 新しい issue を作成
- Manager の健全性を定期的に確認（cmux read-screen で生存確認）

## 引数

$ARGUMENTS = ミッションの説明（必須）
空の場合は「何を実現したいですか？」と尋ねる。

## 注意事項

- .team/ が既に存在する場合はインフラ準備をスキップし、Manager が稼働中か確認
- Manager が既に稼働中なら再起動せず、新しい issue のみ作成
