---
id: 242
title: Conductor worktree の base を origin/<mainBranch> から解決する (+ create-task --base-branch)
priority: high
created_by: surface:47
created_at: 2026-04-17T10:49:12.085Z
---

## タスク
## 概要

Conductor の worktree 作成時に `projectRoot` の HEAD を暗黙 start-point に使っているため、ローカル main 系ブランチが origin から乖離していると **他タスクの変更が PR に混入する** 事故が発生する。`.team/config.json` の `mainBranch` が worktree 作成時に参照されていない点も問題。

## 発生事例（Dear / T165）

- **症状**: T165 の PR #1891 に無関係な 14 タスク分の変更が混入（summary.md は 3 ファイル申告、実 PR は 26 ファイル）
- **原因**: T165 の worktree 作成時、projectRoot の `HEAD`（ローカル `dev` = `98a3223f9`）を start-point にしてしまった。ローカル dev は origin/dev から 14 commits 乖離していたため、PR diff（origin/dev..T165 head）にそれらが全部載った
- **観測**:
  ```
  T165 branch: 977af393a (parent = 98a3223f9 = 当時のローカル dev HEAD)
  origin/dev:  09bd8c7a8
  → 15 commits 差分 (他 14 + T165 本人 1)
  ```

## 該当コード

`skills/cmux-team/manager/conductor.ts:306-321` の worktree 作成部:

```ts
const worktreeArgs = ["worktree", "add", worktreePath, "-b", branch];
if (baseBranch) {               // task.md frontmatter `base_branch:` のみ
  worktreeArgs.push(baseBranch);
}
await execFile("git", worktreeArgs, { cwd: projectRoot });
```

- `baseBranch` は task.md の `base_branch:` frontmatter からしか取らない
- `.team/config.json` の `mainBranch` は **worktree 作成には使われていない**（`{{MAIN_BRANCH}}` プロンプト変数のみ）
- 省略時は `cwd=projectRoot` の HEAD 依存

## やってほしいこと

### 1. worktree 作成で `mainBranch` と origin 追従を効かせる（主）

優先順位で start-point を解決する:

1. task.md frontmatter の `base_branch:` （明示指定、既存動作）
2. `.team/config.json` の `mainBranch` → **`origin/<mainBranch>`** を start-point に使う
3. `origin/<mainBranch>` が解決できない場合はローカル `<mainBranch>` にフォールバック
4. それも無ければ現行通り HEAD（最終フォールバック）

設計上の要点:
- **常に origin を優先**すること。ローカル <mainBranch> が push されていない中間状態にあることが通常なので、origin ref のほうが安全
- `git fetch origin <mainBranch>` を worktree 作成の直前に打つかどうかは検討（頻度が高いと遅い。毎回 fetch はやり過ぎだが、数分キャッシュはあり得る）
- 失敗時は明示的にログ: `worktree_created base=origin/dev source=<explicit|config-origin|config-local|head-fallback>`

### 3. `cmux-team create-task --base-branch <name>` オプション（補完）

Master がタスク起票時に base を明示できるようにする。
- `main.ts` の `cmdCreateTask` に `--base-branch` を追加
- 指定された場合、生成される task.md の frontmatter に `base_branch: <name>` を書き込む
- `update-task` 側にも `--base-branch` を揃えるか要検討

### 周辺整備

- 新しい解決ロジックを docs/spec/ に反映（主に `01-skill-cmux-team.md` または該当する仕様ファイル）
- CLAUDE.md の「git worktree（概要）」セクションを base 解決ロジック込みで更新
- 既存テスト（`conductor.test.ts` / `daemon.test.ts`）への影響確認、必要なら unit test 追加
  - `base_branch: dev` 指定時は従来通り
  - 指定なしで config.mainBranch=dev のとき origin/dev が使われる
  - origin/dev 解決不能時のフォールバック経路
- `cmux-team start` 初期化時の `mainBranch` 自動検出ロジック（`git symbolic-ref refs/remotes/origin/HEAD`）は既存のまま利用してよい

## 完了条件

- [ ] conductor.ts の worktree 作成ロジックに mainBranch / origin 優先フォールバックを実装
- [ ] worktree_created ログに `base=` と `source=` を付与
- [ ] create-task に `--base-branch` オプションを追加
- [ ] docs/spec と CLAUDE.md を更新
- [ ] 既存テストが通り、新規ケースの unit test を追加
- [ ] CHANGELOG.md に記載

## 参考

- 同時に Dear 側の `.team/config.json` を `mainBranch: dev` に手修正済み（このタスクのスコープ外）
