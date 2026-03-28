---
id: 036
title: spawn-agent で claude -w を使い Agent を worktree 内で起動する
priority: high
status: draft
created: 2026-03-29
depends_on: [034]
---

## 概要

現状 `spawn-agent` (main.ts) が Agent を起動する際、worktree パスへの `cd` を行わないため Agent がメインリポジトリで作業してしまうバグがある。

## 現状の問題

- `main.ts:379` で `claude --dangerously-skip-permissions '${prompt}'` を実行しているが、`cd` なし
- Agent はメインリポジトリのファイルを直接編集してしまう
- Conductor が手動で `cp` + `git checkout` で修復する羽目になる

## 修正方針

`claude -w <conductor-id>` オプションを使う:

- `-w name` で worktree 名を指定可能
- 同名の worktree が既に存在する場合は再利用される（fail しない）
- 同一 Conductor の複数 Agent は同じ worktree を共有できる

### 変更内容

1. **spawn-agent の起動コマンド変更**
   - Before: `claude --dangerously-skip-permissions '${prompt}'`
   - After: `claude -w <conductor-id> --dangerously-skip-permissions '${prompt}'`

2. **Conductor 側の worktree 作成コードを削除**
   - worktree の作成は Claude Code の `-w` に委譲
   - Conductor テンプレートから worktree 作成手順を削除

3. **worktree クリーンアップの見直し**
   - `-w` で作成された worktree は `.claude/worktrees/<name>` に配置される
   - Conductor 完了時のクリーンアップパスを更新

## 影響範囲

- skills/cmux-team/manager/main.ts（cmdSpawnAgent）
- skills/cmux-team/templates/conductor.md（worktree 作成手順の削除）
- skills/cmux-team/manager/conductor.ts（クリーンアップパスの更新）

## Journal

- summary: cmdSpawnAgent で team.json から worktreePath を取得し cd prefix を付与するよう修正
- files_changed: 1
