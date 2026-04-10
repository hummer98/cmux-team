# タスク割り当て

## タスク内容

---
id: 127
title: worktree に source_up の .envrc を生成して OAuth トークンを継承
priority: high
created_at: 2026-04-10T07:23:23.562Z
---

## タスク
## 背景

Agent は worktree 内で claude を起動するが、.envrc は untracked のため worktree に含まれない。OAuth トークンが継承されず別の契約で動作してしまう。

.envrc のコピーは `pwd` 解決の問題がある（`export CLAUDE_CONFIG_DIR=\`pwd\`/.config` がコピー先のパスに解決されてしまう）。

## やること

worktree 作成後、コピーではなく `source_up` だけ書いた `.envrc` を生成する。

`skills/cmux-team/manager/conductor.ts` の `assignTask()` 内、worktree 作成後（行282付近）に追加:

```typescript
// .envrc を生成（source_up で親の .envrc を継承）
const envrcSrc = join(projectRoot, '.envrc');
if (existsSync(envrcSrc)) {
  writeFileSync(join(worktreePath, '.envrc'), 'source_up\n');
}
```

既存の direnv allow（行304-312）はそのまま活用される。.envrc が生成されるので existsSync チェックも通る。

## なぜ source_up

direnv の `source_up` は親ディレクトリの `.envrc` を探し、**その .envrc があるディレクトリに cd してから**評価する。これにより `pwd` は常にプロジェクトルートで解決され、相対パスの問題が起きない。

## 対象ファイル

- `skills/cmux-team/manager/conductor.ts` — assignTask() 内の worktree 作成後


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-127-1775805803` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-127-1775805803
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-127-1775805803/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/127-worktree-source-up-envrc-oauth/runs/task-127-1775805803
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/127-worktree-source-up-envrc-oauth/runs/task-127-1775805803/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
