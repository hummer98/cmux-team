---
task: T242
role: implementer-1
generated_at: 2026-04-17
---

# T242 実装レポート

## Completed Tasks

1. **サブタスク 1**: `schema.ts` に `WorktreeBaseSource`（Zod enum）と `WorktreeBaseResolution` 型を追加
2. **サブタスク 2**: `worktree-base.ts` に純粋関数 `resolveWorktreeBase` を実装（DI パターン、`main-branch.ts` を踏襲）
3. **サブタスク 3**: `worktree-base.test.ts` に 12 ケースの unit test を追加（explicit / config-origin / config-local / head-fallback / fetch opt-in / trim 正規化 / `HEAD` explicit / 等）
4. **サブタスク 4**: `conductor.ts:assignTask` の worktree 作成部を `resolveWorktreeBase` 経由に変更。ログを `worktree_created branch=<new> base=<ref> source=<...> path=<...>` で常時出力する形に統一
5. **サブタスク 5**: `conductor.test.ts` に T242 describe ブロックを追加（base_branch 未指定 + local main の場合に worktree が main 基点で作られることを実 git で検証）
6. **サブタスク 6**: `docs/spec/05-install-and-infrastructure.md` の `mainBranch` 説明に worktree 解決順位 + 環境変数 `CMUX_TEAM_FETCH_BEFORE_WORKTREE` を追記
7. **サブタスク 7**: `CLAUDE.md` に「worktree 作成時の start-point 解決（T242）」セクションを新設、「git worktree（概要）」を更新
8. **サブタスク 8**: `CHANGELOG.md` に `## [Unreleased]` を新設し T242 エントリを追加
9. **サブタスク 9**: `bun test`（458 pass / 0 fail）+ `bunx tsc --noEmit`（exit 0）で全体回帰確認

## Files Changed

### 新規
| パス | 内容 |
|------|------|
| `skills/cmux-team/manager/worktree-base.ts` | `resolveWorktreeBase` 純粋関数 + `ResolveWorktreeBaseOptions` 型 |
| `skills/cmux-team/manager/worktree-base.test.ts` | 12 ケースの unit test |

### 変更
| パス | 変更概要 |
|------|---------|
| `skills/cmux-team/manager/schema.ts` | `WorktreeBaseSource` Zod enum と `WorktreeBaseResolution` interface を追加（T213 `MainBranchSource` の並び） |
| `skills/cmux-team/manager/conductor.ts` | `assignTask` が `resolveWorktreeBase(projectRoot, { baseBranch, mainBranch, doFetch: env })` で start-point を解決。`worktreeArgs.push(resolution.startPoint)`、`worktree_created` ログに `base=` と `source=` を付与し常時出力 |
| `skills/cmux-team/manager/conductor.test.ts` | `describe("assignTask worktree base 解決 (T242)")` ブロックを追加。実 git で main 2 commits + dev 1 commit を作り、base_branch 未指定時に worktree HEAD が main HEAD と一致することを確認 |
| `docs/spec/05-install-and-infrastructure.md` | `mainBranch` 行に worktree 解決順位（explicit → config-origin → config-local → head-fallback）と `CMUX_TEAM_FETCH_BEFORE_WORKTREE` を追記 |
| `CLAUDE.md` | 「worktree 作成時の start-point 解決（T242）」を `### mainBranch の優先順位` の下に新設。「git worktree（概要）」の `作成` 行に start-point の説明を追加 |
| `CHANGELOG.md` | `## [Unreleased]` を新規追加し T242 エントリを記載 |

### 削除
なし。

### スコープ外（触っていない）
- `main.ts:cmdCreateTask --base-branch` — 既に実装済み（計画書 § 1-4 で確認）
- `task.ts:createTaskProgrammatic` — 既に `base_branch:` frontmatter 対応済み
- `i18n.ts` — `--base-branch` help は既に記載済み
- `01-skill-cmux-team.md` / `02-skill-cmux-agent-role.md` — `--base-branch` 記述は既存

## TDD Cycles / Verification Results

### Cycle 1: worktree-base.ts（新規）

- **RED**: `bun test worktree-base.test.ts` → `Cannot find module './worktree-base'` で 1 fail
- **GREEN**: `worktree-base.ts` を実装 → 12 pass / 0 fail
- **REFACTOR**: 既存 `main-branch.ts` と揃える形で DI と trim 処理を統一（追加リファクタなし）

```
bun test v1.3.12 (700fc117)
worktree-base.test.ts:
 12 pass
 0 fail
 15 expect() calls
Ran 12 tests across 1 file. [20.00ms]
```

### Cycle 2: conductor.ts 組み込み

- **RED**: 実装の前にテストを書こうとしたが、conductor.test.ts の既存 T232 は `base_branch:` 未指定の `main` ブランチ前提で通っていた。`origin/main` が存在しないテスト環境で worktree が `main` 基点になることを確認するケースを追加
- **GREEN**: `conductor.ts:306-321` を `resolveWorktreeBase` 呼び出しに置換 → `bun test conductor.test.ts` 10 pass / 0 fail
- **REFACTOR**: ログを `if (baseBranch)` 分岐から無条件 `await log(...)` に統一（`worktree_created` が毎回出るようになり原因追跡性向上）

```
bun test v1.3.12 (700fc117)
conductor.test.ts:
 10 pass
 0 fail
 42 expect() calls
Ran 10 tests across 1 file. [6.32s]
```

### Cycle 3: 全体回帰

```
bun test 2>&1 | tail -5
 458 pass
 0 fail
 1006 expect() calls
Ran 458 tests across 22 files. [16.58s]
```

```
bunx tsc --noEmit
exit=0
```

## Issues Encountered

### I1. 計画書 § 3-2 の `docs/spec/01-skill-cmux-team.md` 更新について

計画書では 01-skill-cmux-team.md に「mainBranch 優先順位」セクションへの追記を指示していたが、実際には mainBranch に関する詳細な解説は `05-install-and-infrastructure.md:424` に集約されている（T224 での同期済み）。01 には `create-task --base-branch` の表記のみで mainBranch 節はない。

→ **対応**: 05-install-and-infrastructure.md:424 の mainBranch 行末尾に worktree 解決順位と `CMUX_TEAM_FETCH_BEFORE_WORKTREE` を追記。01 は現状でも `--base-branch` の行が記載されているため追加変更なし。CLAUDE.md 側に詳細を記述（こちらが日常的な参照源）。

### I2. CHANGELOG のバージョン番号判断

計画書 § 3-2 に「次バージョンは patch or minor 判断はリリース時」とあったため、`[Unreleased]` セクションを先頭に作成しエントリを追加した。リリース時に `release` スキルが適切なバージョン番号を付与する前提。

### I3. `base_branch: HEAD` の扱い

Design Review 提案 3 の「ローカル未 push commit を含めたい場合は `base_branch: HEAD`」を反映するため、`resolveWorktreeBase` の explicit 経路は `baseBranch` の値を無加工で `startPoint` に設定する。`baseBranch: "HEAD"` のケースは test で明示的にカバー済み（`HEAD` がそのまま `startPoint` として git に渡される）。ユーザー側の運用ポイントとして CLAUDE.md に追記した。

### I4. worktree 作成で仮想 main 未マージ状態でも新挙動が互換維持されるか

既存 T232 テスト（`git init -b main` + 1 commit、`base_branch:` なし、mainBranch="main"）は新実装でも pass する。これは `rev-parse refs/remotes/origin/main^{commit}` が失敗（origin 未設定）→ `refs/heads/main^{commit}` 成功 → `config-local` source で start-point=`main` になり、`git worktree add ... main` が実質 HEAD と同じ commit を指すため互換性あり。

## 計画書との逸脱

なし。計画書のサブタスク分割・変更対象・テスト戦略・Decision Log すべてに従って実装した。
