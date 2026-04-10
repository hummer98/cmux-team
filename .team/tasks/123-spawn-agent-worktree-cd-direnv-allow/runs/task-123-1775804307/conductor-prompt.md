# タスク割り当て

## タスク内容

---
id: 123
title: spawn-agent で worktree cd 後に direnv allow を実行
priority: high
created_at: 2026-04-10T06:58:27.974Z
---

## タスク
## 背景

T122 で Conductor 起動時の direnv allow 自動化を実装したが、spawn-agent（Agent 起動）側では対応漏れ。worktree 内で .envrc の OAuth トークンが引き継がれない。

## やること

`main.ts` の `cmdSpawnAgent()` 内、worktree への `cd` 後（行961-964）と Claude 起動（行966）の間に `direnv allow` を追加する。

## 対象箇所

`skills/cmux-team/manager/main.ts` 行 960-965 付近:

```typescript
// worktree ディレクトリに移動
if (worktreePath) {
  await cmux.send(surface, \`cd ${worktreePath}\n\`);
  await sleep(500);
  // ← ここに direnv allow を追加
}
```

## 実装

Conductor 側（conductor.ts）の T122 実装と同じパターンで:
- `.envrc` の存在チェックは不要（`direnv allow` は .envrc がなければ no-op）
- `cmux.send(surface, 'direnv allow 2>/dev/null\n')` + `await sleep(500)`


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-123-1775804307` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-123-1775804307
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-123-1775804307/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/123-spawn-agent-worktree-cd-direnv-allow/runs/task-123-1775804307
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/123-spawn-agent-worktree-cd-direnv-allow/runs/task-123-1775804307/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
