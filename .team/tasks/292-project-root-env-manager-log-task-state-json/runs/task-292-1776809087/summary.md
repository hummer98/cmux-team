# T292 完了サマリー — テスト隔離: ダミープロジェクト + PROJECT_ROOT env

- taskRunId: `task-292-1776809087`
- worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-292-1776809087`
- ブランチ: `task-292-1776809087/task`
- マージ先: `main`（ローカル ff-only マージ）

## 達成内容

`bun test` 実行中にテストが実プロジェクト配下の `.team/logs/manager.log` / `.team/task-state.json` / `.team/tasks/` 等を書き換える汚染バグを根絶した。

### 構造変更

1. **`skills/cmux-team/manager/test-project.ts`** 新設
   - `createDummyProject()` / `withDummyProject()` helper
   - `fs.mkdtemp()` ベース + `.team/` サブ構造の必要分だけ mkdir + `process.env.PROJECT_ROOT` override
   - try/finally で env 復元 + tmp dir 再帰削除、LIFO dispose
   - オプション: `createTeamDir` / `seedTeamJson` / `setProjectRootEnv` / `prefix` / `subdirs`
2. **22 テストファイルを helper に migrate** — 直書きの `process.env.PROJECT_ROOT = ...` を helper 経由に置換（`task.test.ts` は T290 regression 経路）
3. **`logger.ts`** に `CMUX_TEAM_LOGGER_STRICT=1` 時 fail-fast する strict モードを追加（production daemon は env を設定しないので影響なし）
4. **`main.ts`** の module-level `process.chdir(PROJECT_ROOT)` を `if (import.meta.main) { ... }` でガード（library として import された瞬間に別テストの tmp dir を指す env で chdir する事故を防ぐ）
5. **`scripts/verify-test-no-pollution.sh`** 追加 — `git status --porcelain .team/` の before/after 比較で汚染検出
6. **`manager/package.json`** の `test` script を `CMUX_TEAM_LOGGER_STRICT=1 bun test` に変更（以後 helper 未使用の新規テストは CI で赤化）

## 完了したサブタスク

- [x] Phase 1 Planner: plan.md 作成（449 行、Step A→C→B→D、受け入れ条件 8 項目、リスク 6 項目）
- [x] Phase 2 Design Review: **Approved**（0 Critical、10 Recommendations）
- [x] Phase 3 Implementation: 30 commit、helper + 22 ファイル migrate + logger strict + chdir ガード + 汚染検出スクリプト
- [x] Phase 4 Inspection: **GO**（0 Critical、全受け入れ条件 pass）

## 受け入れ条件の検証結果（Inspection 実測値）

| # | 条件 | 結果 |
|---|---|---|
| 1 | `.team/logs/manager.log` 無変更 | ✅ `git status` clean |
| 2 | `.team/task-state.json` 無変更 | ✅ 同上 |
| 3 | `.team/tasks/ conductors/ output/ queue/` 無変更 | ✅ 同上 |
| 4 | `bun test` 全 pass | ✅ **998 pass / 0 fail / 2381 expect() / 36 files / 45.38s** |
| 5 | tsc 新規エラー 0（pre-existing 3 件） | ✅ baseline と完全一致 |
| 6 | helper 参照テスト本数 ≥ 22 | ✅ 23（test-project.test.ts 含む） |
| 7 | `CMUX_TEAM_LOGGER_STRICT=1 bun test` pass | ✅ 998 pass / 46.08s |
| 8 | `verify-test-no-pollution.sh` pass | ✅ `OK: .team/ unchanged` |

## 変更ファイル一覧

### 新規追加（3）
- `skills/cmux-team/manager/test-project.ts` (128 行)
- `skills/cmux-team/manager/test-project.test.ts` (219 行)
- `scripts/verify-test-no-pollution.sh` (50 行)

### 既存修正（実装側、4）
- `skills/cmux-team/manager/logger.ts` (+11/-1): strict モード追加
- `skills/cmux-team/manager/main.ts` (+7/-1): chdir を `import.meta.main` でガード
- `skills/cmux-team/manager/package.json` (+3): test script に strict env 追加
- `package.json` (repo root): `test:clean` script 追加

### テスト migrate（22）
- C-1 (10): `conductor.test.ts` / `daemon.test.ts` / `envrc-prompt.test.ts` / `eventBus.trace.test.ts` / `logger.test.ts` / `main-branch.test.ts` / `master.test.ts` / `proxy.test.ts` / `queue.test.ts` / `rate-limit-persistence.test.ts`
- C-2 (4): `task.test.ts` (★ T290 regression) / `trace-store.test.ts` / `pidfile.test.ts` / `preflight.test.ts`
- C-3 (7): `agent-instructions.test.ts` / `cmux.test.ts` / `direnv-check.test.ts` / `gh-cache-cli.test.ts` / `gh-cache-store.test.ts` / `gh-cache-sync.test.ts` / `worktree-base.test.ts`
- C-4 (1): `main.test.ts`（親プロセス側の保険として helper 追加）

## マージコミット

（Step 9 完了後に追記）

## Agent ログ

- Planner: `surface:614`（成果物: `plan.md` 449 行）
- Design Reviewer: `surface:616`（成果物: `design-review.md` Approved）
- Implementer: `surface:617`（30 commit、約 1 時間稼働）
- Inspector: `surface:618`（成果物: `inspection.md` GO）

## 残課題

なし。plan §6「後続タスク候補」の `test-helpers/` パッケージ化 / fixture API 抽象化 / trace-store in-memory モード等は T292 スコープ外で、必要に応じて別タスクとして起票する。
