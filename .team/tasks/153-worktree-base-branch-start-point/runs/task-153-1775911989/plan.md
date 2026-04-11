# Plan: worktree 作成時に baseBranch を start-point として使用する

## 背景

`conductor.ts` L288 の `git worktree add` で start-point を指定していないため、常に HEAD（通常は main）から分岐する。`base_branch` がタスクに指定されていても worktree 作成には使われず、プロンプトのマージ先指示にしか渡されていない。

## 修正対象

**ファイル**: `skills/cmux-team/manager/conductor.ts`
**箇所**: L287-294（`git worktree add` コマンド組み立て）

## 修正内容

### 1. worktree 作成コマンドに baseBranch を start-point として追加

**現状 (L287-294):**
```typescript
try {
  await execFile("git", ["worktree", "add", worktreePath, "-b", branch], {
    cwd: projectRoot,
  });
  worktreeCreated = true;
} catch (e: any) {
  throw new AssignTaskError("task", `git worktree add failed: ${e.message}`, e);
}
```

**修正後:**
```typescript
try {
  const worktreeArgs = ["worktree", "add", worktreePath, "-b", branch];
  if (baseBranch) {
    worktreeArgs.push(baseBranch);  // start-point を指定
  }
  await execFile("git", worktreeArgs, {
    cwd: projectRoot,
  });
  worktreeCreated = true;
} catch (e: any) {
  throw new AssignTaskError("task", `git worktree add failed: ${e.message}`, e);
}
```

### 2. ログ追加

baseBranch 指定時にログを出力して、どのブランチから分岐したか追跡可能にする。

## 考慮事項

- `baseBranch` が未指定の場合: 従来通り HEAD から分岐（後方互換）
- `baseBranch` が存在しないブランチの場合: `git worktree add` 自体がエラーを返すため、既存の catch で `AssignTaskError` として適切に報告される
- リモートにしか存在しない場合: `origin/<baseBranch>` を start-point に指定すれば git が自動的に解決する。タスク作成側で `base_branch: origin/feat-xxx` と書けば対応可能。conductor.ts 側での特別な処理は不要（シンプルさ優先）

## 完了条件

- `baseBranch` が指定されている場合、worktree がそのブランチから分岐して作成されること
- `baseBranch` が未指定の場合、従来通り HEAD から分岐すること
- TypeScript のビルドが通ること（`bun build` or `tsc`）
