# タスク割り当て

## タスク内容

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


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-153-1775911989` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-153-1775911989
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-153-1775911989/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/153-worktree-base-branch-start-point/runs/task-153-1775911989
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/153-worktree-base-branch-start-point/runs/task-153-1775911989/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
