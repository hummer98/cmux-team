---
id: 153
title: worktree 作成時に base_branch を start-point として使用する
priority: high
created_at: 2026-04-11T12:47:25.483Z
---

## タスク
## 背景

`conductor.ts` L288 の worktree 作成で start-point を指定していないため、常に HEAD（通常は dev/main）から分岐する。`base_branch` がタスクに指定されていても worktree 作成には使われず、プロンプトのマージ先指示にしか渡されていない。

結果:
1. worktree が dev から分岐して作成される
2. プロンプトに「feat/xxx にマージせよ」と書かれる
3. Conductor が dev ベースの変更を feat ブランチにマージ → dev の内容が混入

Dear プロジェクト T117 で実際に発生。

## やること

`conductor.ts` L288 の worktree 作成を修正:

**現状:**
```typescript
await execFile("git", ["worktree", "add", worktreePath, "-b", branch], {
  cwd: projectRoot,
});
```

**修正後:**
```typescript
const worktreeArgs = ["worktree", "add", worktreePath, "-b", branch];
if (baseBranch) {
  worktreeArgs.push(baseBranch);  // start-point を指定
}
await execFile("git", worktreeArgs, {
  cwd: projectRoot,
});
```

`baseBranch` は L284 で既にパース済み。それを worktree 作成にも渡すだけ。

## 注意

- `baseBranch` が未指定の場合は従来通り HEAD から分岐（後方互換）
- `baseBranch` が存在しないブランチの場合のエラーハンドリングも考慮（AssignTaskError で適切に報告）
- リモートにしか存在しない場合は `origin/${baseBranch}` を試すか、事前に fetch するか検討
