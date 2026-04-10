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
