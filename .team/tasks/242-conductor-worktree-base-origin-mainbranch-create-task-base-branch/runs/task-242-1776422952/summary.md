---
task: T242
conductor: task-242-1776422952
completed_at: 2026-04-17
verdict: GO
---

# T242 完了サマリ

Conductor worktree の start-point を `origin/<mainBranch>` から解決するようにし、PR に他タスクの変更が混入する問題を解消した。create-task --base-branch は既実装だったため docs 確認のみに留めた。

## 完了サブタスク

1. `schema.ts` に `WorktreeBaseSource` Zod enum + `WorktreeBaseResolution` interface 追加
2. `worktree-base.ts` 新規 — `resolveWorktreeBase` 純粋関数（DI, explicit → config-origin → config-local → head-fallback のフォールバック）
3. `worktree-base.test.ts` 新規 — 12 ケースの unit test
4. `conductor.ts:assignTask` の worktree 作成部を `resolveWorktreeBase` 経由に置換。ログ `worktree_created branch=... base=... source=... path=...` を常時出力
5. `conductor.test.ts` に T242 describe 追加（実 git で base_branch 未指定 + local main のケースを検証）
6. `docs/spec/05-install-and-infrastructure.md` の mainBranch 行に worktree 解決順位と `CMUX_TEAM_FETCH_BEFORE_WORKTREE` 追記
7. `CLAUDE.md` に「worktree 作成時の start-point 解決（T242）」セクション新設、「git worktree（概要）」更新
8. `CHANGELOG.md` に `## [Unreleased]` + T242 エントリ追加

## 変更ファイル

### 新規
- `skills/cmux-team/manager/worktree-base.ts`
- `skills/cmux-team/manager/worktree-base.test.ts`

### 変更
- `skills/cmux-team/manager/schema.ts`
- `skills/cmux-team/manager/conductor.ts`
- `skills/cmux-team/manager/conductor.test.ts`
- `docs/spec/05-install-and-infrastructure.md`
- `CLAUDE.md`
- `CHANGELOG.md`

## テスト結果

- `bun test`（skills/cmux-team/manager）: **458 pass / 0 fail / 1006 expect**
- `bunx tsc --noEmit`: exit 0
- `bun test worktree-base.test.ts`: 12 pass
- `bun test conductor.test.ts`: 10 pass

## レビュー/検品結果

- Design Review: **Approved** — Critical 0件。任意提案（timeout, await log, HEAD 明示の記載）すべて反映
- Inspection: **GO** — Critical 0件、Major 0件、型エラー 0件

## 環境変数（新規）

- `CMUX_TEAM_FETCH_BEFORE_WORKTREE=1` — worktree 作成前に `git fetch --quiet origin <mainBranch>` を opt-in 実行（30 秒 timeout、失敗時はログのみで継続）

## 後方互換性

- `base_branch:` 明示済みタスクは挙動不変
- origin が無いリポは `config-local` にフォールバック
- local も無ければ `head-fallback` で従来挙動維持
- ローカル未 push commit を起点にしたい場合は `base_branch: HEAD` を明示する運用を CLAUDE.md に記載

## 納品

- ローカルマージ方式（main へ merge）
