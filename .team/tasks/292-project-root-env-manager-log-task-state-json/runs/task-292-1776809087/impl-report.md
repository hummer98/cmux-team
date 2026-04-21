# T292 実装レポート — テスト隔離: ダミープロジェクト + PROJECT_ROOT env で `.team/` 汚染を防ぐ

- taskRunId: `task-292-1776809087`
- Worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-292-1776809087`
- 実装者: implementer-1 (T292)
- 実装期間: 2026-04-22

---

## 1. 要旨

plan.md の Step A / C / B / D を順に実装。`skills/cmux-team/manager/test-project.ts` ヘルパーを新設し、汚染経路を持つ 22 本（C-1〜C-4）のテストを helper 経由に移行。合わせて logger.ts に strict モードを導入して将来 regressions を早期検出する体制を整備した。最後に汚染検出スクリプトとそれを呼び出す `npm run test:clean` を追加。

plan.md §4 の受け入れ条件 8 項目を全て満たしたことを確認済み。

---

## 2. 変更ファイル一覧

### 新規追加

| ファイル | 内容 |
|---|---|
| `skills/cmux-team/manager/test-project.ts` | `createDummyProject()` / `withDummyProject()` / `DEFAULT_SUBDIRS` を提供する test helper。tmp dir 作成 + `.team/` subdirs mkdir + `process.env.PROJECT_ROOT` 設定 + try/finally で確実な dispose（env 復元含む）。`createTeamDir` / `seedTeamJson` / `setProjectRootEnv` / `prefix` / `subdirs` のオプションで細かく調整可能 |
| `skills/cmux-team/manager/test-project.test.ts` | helper 自身の 16 ケースを検証（tmp dir 一意性 / subdirs 作成 / env 書き換え&復元 / seedTeamJson / withDummyProject の try-finally / 二重 dispose の no-op / setProjectRootEnv=false 等） |
| `scripts/verify-test-no-pollution.sh` | `git status --porcelain .team/` の before/after 比較で bun test の副作用を検出する CI ガード |

### 既存ファイル修正（実装側）

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/logger.ts` | `CMUX_TEAM_LOGGER_STRICT=1` 時に `PROJECT_ROOT` 未設定なら fail-fast する strict モードを追加。production daemon は env を設定しないので影響なし |
| `skills/cmux-team/manager/main.ts` | module-level の `process.chdir(PROJECT_ROOT)` を `if (import.meta.main) { ... }` でガード。library として import された瞬間に別テストの tmp dir を指す env で chdir し、その後 rm された dir に cwd が残る事故を防ぐ |
| `skills/cmux-team/manager/package.json` | `"test"` script を `"CMUX_TEAM_LOGGER_STRICT=1 bun test"` に変更（helper を使わない新規テストが CI で赤になる仕組み） |
| `package.json` (repo root) | `"test:clean": "bash scripts/verify-test-no-pollution.sh"` script を追加 |

### 既存ファイル修正（テスト migration）

C-1 (10 本): `conductor.test.ts` / `daemon.test.ts` / `envrc-prompt.test.ts` / `eventBus.trace.test.ts` / `logger.test.ts` / `main-branch.test.ts` / `master.test.ts` / `proxy.test.ts` / `queue.test.ts` / `rate-limit-persistence.test.ts`

C-2 (4 本): `task.test.ts` (★ T290 regression 経路) / `trace-store.test.ts` / `pidfile.test.ts` / `preflight.test.ts`

C-3 (7 本): `agent-instructions.test.ts` / `cmux.test.ts` / `direnv-check.test.ts` / `gh-cache-cli.test.ts` / `gh-cache-store.test.ts` / `gh-cache-sync.test.ts` / `worktree-base.test.ts`

C-4 (1 本): `main.test.ts`（親プロセス側の保険として `createDummyProject` を追加。子プロセス spawn 部分は既に tmp dir を env で注入していたので変更なし）

C-5 (11 本): 変更不要（確認のみ）

各テストファイル 1 本 = 1 commit で分割（22 commits + helper 本体 + 周辺修正）。

---

## 3. 受け入れ条件（plan.md §4）の検証結果

| # | 条件 | 結果 |
|---|---|---|
| 1 | `bun test` 実行後、`.team/logs/manager.log` に 1 bit の変更もない | ✅ `git status .team/logs/manager.log` が空（verify-test-no-pollution.sh で毎回チェック） |
| 2 | `.team/task-state.json` に変更が入らない | ✅ 同上、`git status` clean |
| 3 | `.team/tasks/` / `.team/conductors/` / `.team/output/` / `.team/queue/` に変更・untracked が無い | ✅ `git status .team/` clean、`bash scripts/verify-test-no-pollution.sh` が `OK: .team/ unchanged` を出力 |
| 4 | `cd skills/cmux-team/manager && bun test` が全 pass | ✅ `998 pass / 0 fail / 2381 expect() calls / 36 files / 45s` |
| 5 | `tsc --noEmit` で新規エラー 0（pre-existing 3 件は許容） | ✅ pre-existing 3 件のみ（`conductor.ts:201` TS1016 / `daemon.test.ts:3954` TS2322 / `daemon.ts:1597` TS2352）。新規追加分（test-project.test.ts:97）は delete 後の narrow 対策で `unknown as string` cast を入れて解消済み |
| 6 | `test-project.ts` / `test-project.test.ts` が追加され、汚染経路のあるテストから参照される | ✅ helper 使用 test ファイル数 = 23（`rg -l 'createDummyProject\|withDummyProject' skills/cmux-team/manager/*.test.ts` で確認） |
| 7 | `CMUX_TEAM_LOGGER_STRICT=1 bun test` が pass | ✅ `skills/cmux-team/manager/package.json` の `"test"` script が常時 strict を有効化し、998 tests pass |
| 8 | `bash scripts/verify-test-no-pollution.sh` が pass | ✅ 実行して `OK: .team/ unchanged (git status stable before/after bun test)` を確認済み |

---

## 4. 実装時の判断メモ

### 4.1 `main.ts` の module-level chdir ガード

Step B で logger strict モードを入れた直後、`bun test` で 12 件のテストが `posix_spawn 'bash' ENOENT` で落ちた。調査の結果、`main.ts:126` の `process.chdir(PROJECT_ROOT)` が module load 時に走る副作用であり、別テストの `beforeEach` で設定された tmp dir を指す env をそのまま chdir に使っていた。tmp dir が `afterEach` で削除されると cwd が dead dir に残り、`child_process.spawn` が cwd 解決に失敗する。

修正は **`if (import.meta.main) { process.chdir(PROJECT_ROOT); }`** のみ。env 設定はテストから見て副作用がなく（`findProjectRoot()` が既存 env を尊重する冪等動作）、production daemon は `import.meta.main === true` なので従来通り chdir される。

### 4.2 logger strict モードの導入タイミング

plan.md の通り Step C 完了後に導入。先に strict を入れると helper 未適用のテストが一斉に赤化するため、必ず C → B の順に実施した。

### 4.3 `logger.test.ts` の「PROJECT_ROOT 遅延評価」テスト

plan.md §3 C-1 の注意に従い、logger.test.ts 内で `setProjectRootEnv: false` を使って helper の env 強制設定を抑制し、従来の遅延評価挙動テストを維持した。

### 4.4 `pidfile.test.ts` に `createTeamDir: false` オプションを追加

pidfile のテストは `.team/` を事前作成せず、pidfile 取得時に親 dir が作られることを検証する。helper の既定（.team/ を必ず作成）と相性が悪いので、`DummyProjectOptions.createTeamDir` を追加して false 時は `.team/` の mkdir をスキップできるようにした。9ccbdfa で helper と一緒に移行。

### 4.5 tsc 新規エラー（test-project.test.ts:97）

`delete process.env.PROJECT_ROOT` 直後の参照は TS が undefined に narrow するため、`createDummyProject()` で string になった runtime 値と generic 推論が噛み合わず `toBe(string)` が `(expected: undefined)` overload にマッチしなくなる。実態は runtime では string なので、`unknown as string` cast で意図を明示して解消した（360cb47）。

---

## 5. コミットログ（新しい順）

```
360cb47 fix: T292 test-project.test.ts の tsc 新規エラーを除去
893bdbf test: T292 .team/ 汚染検出スクリプトと test:clean を追加
b847730 test: T292 package.json に bun run test で CMUX_TEAM_LOGGER_STRICT=1 を有効化
d127ab3 feat: T292 logger.ts に CMUX_TEAM_LOGGER_STRICT=1 で fail-fast する strict モードを追加
5cbf79e test: T292 pidfile.test.ts の doc コメントを createDummyProject 前提に更新
815c5a9 fix: T292 main.ts の module-level chdir を CLI 起動時のみに限定
cf6308d test: T292 migrate main.test.ts to createDummyProject
092b180 test: T292 migrate worktree-base.test.ts to createDummyProject
24048a8 test: T292 migrate gh-cache-sync.test.ts to createDummyProject
8e72a07 test: T292 migrate gh-cache-store.test.ts to createDummyProject
760a988 test: T292 migrate gh-cache-cli.test.ts to createDummyProject
225c584 test: T292 migrate direnv-check.test.ts to createDummyProject
e9a5355 test: T292 migrate cmux.test.ts to createDummyProject
f749b68 test: T292 migrate agent-instructions.test.ts to createDummyProject
54b4247 test: T292 migrate preflight.test.ts to createDummyProject
9ccbdfa test: T292 migrate pidfile.test.ts + add createTeamDir option
9462af6 test: T292 migrate trace-store.test.ts to createDummyProject
0efac46 test: T292 migrate task.test.ts to createDummyProject (★ T290 regression path)
0002d82 test: T292 migrate rate-limit-persistence.test.ts to createDummyProject
09eb4f4 test: T292 migrate queue.test.ts to createDummyProject
01c3761 test: T292 migrate proxy.test.ts to createDummyProject
e93265b test: T292 migrate master.test.ts to createDummyProject
8d2c607 test: T292 migrate main-branch.test.ts to createDummyProject
82577bc test: T292 migrate logger.test.ts to createDummyProject
8897ead test: T292 migrate eventBus.trace.test.ts to createDummyProject
fd0472b test: T292 migrate envrc-prompt.test.ts to createDummyProject
f2e44f7 test: T292 migrate daemon.test.ts to createDummyProject
3d0f75b test: T292 migrate conductor.test.ts to createDummyProject
bf30a45 test: T292 add test-project helper + self-tests
```

計 29 コミット（T292 前の T290/T291 chore commit 2 件は含まず）。

---

## 6. テスト結果

```
$ cd skills/cmux-team/manager && bun test
 ...
 998 pass
 0 fail
 2381 expect() calls
Ran 998 tests across 36 files. [44-46s]

$ CMUX_TEAM_LOGGER_STRICT=1 bun test  # ← package.json の新 test script
 998 pass / 0 fail

$ bash scripts/verify-test-no-pollution.sh
 ...
 998 pass
 OK: .team/ unchanged (git status stable before/after bun test)
```

---

## 7. 残課題

なし。plan.md §4 の受け入れ条件 8 項目を全て満たした。

plan.md §6「後続タスク候補」に挙がっている `test-helpers/` パッケージ化 / fixture API 抽象化 / trace-store in-memory モード等は本タスクの範囲外で、必要になった時点で別タスクとして起票する。
