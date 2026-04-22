# Inspection: T292

## Verdict

**GO**

## Summary

plan.md §4 の受け入れ条件 8 項目を全て実測で pass。`test-project.ts` helper の導入 + 22 テストの migrate + `logger.ts` strict モード + `main.ts` chdir ガード + `scripts/verify-test-no-pollution.sh` が plan 通り実装され、production daemon の主要モジュールへの逸脱変更もない。T292 実装者が触ったのは `logger.ts` / `main.ts` と test 群のみで、plan §6 の作業境界を厳守している。

## 受け入れ条件チェック

| # | 項目 | 結果 | 実測 |
|---|---|---|---|
| 1 | `.team/logs/manager.log` が 1 bit も変わらない | ✅ | `git status --porcelain .team/` before/after 差分 0 行（後述 Verification Evidence §E） |
| 2 | `.team/task-state.json` に変更が入らない | ✅ | 上記 §E の git status に含まれず clean |
| 3 | `.team/tasks/ conductors/ output/ queue/` が無変更 | ✅ | 上記 §E の git status に含まれず clean |
| 4 | `cd skills/cmux-team/manager && bun test` 全 pass | ✅ | **998 pass / 0 fail / 2381 expect() / 36 files / 45.38s** |
| 5 | tsc --noEmit 新規エラー 0（pre-existing 3 件） | ✅ | baseline 3 件と完全一致（`daemon.test.ts` の行番号が 3956→3954 に 2 行縮んだのみ、新規エラーなし。§F 参照） |
| 6 | helper 参照テスト本数が確認できる | ✅ | `rg -l 'createDummyProject\|withDummyProject' skills/cmux-team/manager/*.test.ts \| wc -l` = **23**（test-project.test.ts を含む）、impl-report の 23 と一致 |
| 7 | `CMUX_TEAM_LOGGER_STRICT=1 bun test` pass | ✅ | **998 pass / 0 fail / 46.08s**。`package.json.scripts.test = "CMUX_TEAM_LOGGER_STRICT=1 bun test"` が常時 strict を有効化 |
| 8 | `scripts/verify-test-no-pollution.sh` pass | ✅ | `OK: .team/ unchanged (git status stable before/after bun test)` を出力（§G 参照） |

## Findings

### Critical (NOGO reason)

（なし）

### Recommendations (GO でも改善提案)

1. **`test-project.test.ts:96` の `unknown as string` cast** — 実装レポート §4.5 にも記載あり。TS の narrow を緩和するための cast だが、`expect<string>(process.env.PROJECT_ROOT)` のように generic 明示で書く方が意図が明瞭になる可能性あり（impl-report で既に言及済みのため必須ではない）。

2. **`main.test.ts:117` / `:121` / `:217` の `before as string | undefined as string`** — TS narrow 対策の cast が散見される。将来リファクタで `assertEnv` みたいなヘルパに寄せると DRY になる。優先度: 低。

3. **`DEFAULT_SUBDIRS` から `task-state` が抜けている** — plan §2.1 のコメント「親 dir の `.team/` が mkdir されていれば OK なので不要」という判断に従い `test-project.ts:27-34` で `"task-state"` は無い。実際 task-state.json はファイルなので問題ないが、plan §2.1 のコメント欄と実装値の差分は意図通りであることが確認しやすいよう docstring で明示すると将来の読者に親切。優先度: 低。

4. **rebase コンフリクトの見込み** — 本 worktree は `faf8931` 起点で分岐しており、main には T291 由来の `resolveCanonicalTaskId` が `main.ts` に追加済み。T292 を main へ rebase する際、`main.ts` に T291 の `resolveCanonicalTaskId` 関数ブロックが付加される形でコンフリクトが発生する想定（手動解消または Conductor の Step 8 semantic resolution で対応可能な範囲）。これは作業境界違反ではなく、T292 worktree 切り出し時の base 選択によるもの。優先度: 情報提供のみ。

5. **`verify-test-no-pollution.sh` の false positive リスク** — design-review Recommendation #5 と同様、`.team/` 全体を対象にしているため、開発中の other untracked files（例: ログ一時ファイル）が紛れると検出漏れ or 過検出になり得る。現状は `before/after の diff` で不変性だけを見ているので実害は小さいが、特定パス限定（`manager.log` / `task-state.json` / `tasks/`）に絞る案を将来検討可。優先度: 低。

6. **Recommendation 1 (design-review) の savedEnv スナップショット** — 逐次ネストは `test-project.test.ts:169-182` で検証済み（LIFO dispose でうまく動くシナリオ）。並列呼び出しは docstring で明示的に未対応と宣言しており、現実装で十分。参考情報として記録。

## Fix Required (NOGO 時のみ)

（該当なし — GO 判定のため）

## Verification Evidence

### A. `bun test` 実行結果

```
$ cd /Users/yamamoto/git/cmux-team/.worktrees/task-292-1776809087/skills/cmux-team/manager && bun test 2>&1 | tail -5
 998 pass
 0 fail
 2381 expect() calls
Ran 998 tests across 36 files. [45.38s]
```

### B. strict モード実行結果

```
$ cd /Users/yamamoto/git/cmux-team/.worktrees/task-292-1776809087/skills/cmux-team/manager && CMUX_TEAM_LOGGER_STRICT=1 bun test 2>&1 | tail -4
 998 pass
 0 fail
 2381 expect() calls
Ran 998 tests across 36 files. [46.08s]
```

### C. `package.json` test script

```
$ cat /Users/yamamoto/git/cmux-team/.worktrees/task-292-1776809087/skills/cmux-team/manager/package.json | jq '.scripts'
{
  "test": "CMUX_TEAM_LOGGER_STRICT=1 bun test"
}
```

### D. helper 使用テスト本数

```
$ cd /Users/yamamoto/git/cmux-team/.worktrees/task-292-1776809087 && rg -l 'createDummyProject|withDummyProject' skills/cmux-team/manager/*.test.ts | wc -l
      23
```

### E. `.team/` 汚染検出（実測 diff）

```
$ cd /Users/yamamoto/git/cmux-team/.worktrees/task-292-1776809087
$ git status --porcelain .team/ > /tmp/t292-status-before.txt   # 0 行
$ cd skills/cmux-team/manager && bun test > /dev/null 2>&1      # exit 0
$ cd /Users/yamamoto/git/cmux-team/.worktrees/task-292-1776809087
$ git status --porcelain .team/ > /tmp/t292-status-after.txt
$ diff /tmp/t292-status-before.txt /tmp/t292-status-after.txt && echo "DIFF CLEAN (no pollution)"
DIFF CLEAN (no pollution)
```

さらに worktree 全体 `git status --porcelain` も空であり、`.envrc` / `.team/logs/` / `.team/task-state.json` / `.team/tasks/` / `.team/conductors/` / `.team/output/` / `.team/queue/` いずれも汚染なし。

### F. tsc --noEmit baseline diff

```
$ cd /Users/yamamoto/git/cmux-team/.worktrees/task-292-1776809087/skills/cmux-team/manager && bunx tsc --noEmit 2>&1 | tee /tmp/t292-tsc-after.txt | tail -5
conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3954,9): error TS2322: Type '"new_session"' is not assignable to ...
daemon.ts(1597,22): error TS2352: Conversion of type 'string | undefined' ...

$ diff /Users/yamamoto/git/cmux-team/.team/tasks/292-project-root-env-manager-log-task-state-json/runs/task-292-1776809087/tsc-baseline.txt /tmp/t292-tsc-after.txt
2c2
< daemon.test.ts(3956,9): error TS2322: Type ...
---
> daemon.test.ts(3954,9): error TS2322: Type ...
```

行番号が 3956 → 3954 に 2 行シフトしただけで、エラー件数・内容は pre-existing 3 件と完全同一。新規エラー **0 件**。

### G. `scripts/verify-test-no-pollution.sh` 実行結果

```
$ ls -la /Users/yamamoto/git/cmux-team/.worktrees/task-292-1776809087/scripts/verify-test-no-pollution.sh
-rwxr-xr-x@ 1 yamamoto  staff  1529  4月 22 08:16 .../scripts/verify-test-no-pollution.sh

$ bash /Users/yamamoto/git/cmux-team/.worktrees/task-292-1776809087/scripts/verify-test-no-pollution.sh 2>&1 | tail -3
Ran 998 tests across 36 files. [51.90s]
OK: .team/ unchanged (git status stable before/after bun test)
```

### H. main.ts chdir ガード確認（commit 815c5a9）

```diff
 const PROJECT_ROOT = findProjectRoot();
 process.env.PROJECT_ROOT = PROJECT_ROOT;
-process.chdir(PROJECT_ROOT);
+if (import.meta.main) {
+  process.chdir(PROJECT_ROOT);
+}
```

- `PROJECT_ROOT` env 設定は chdir より前で行われており、位置関係は不変（plan §2.4 / design-review §109 の裏取り通り）
- `import.meta.main === true` の CLI 起動経路（`bun run main.ts start` 等）で従来通り chdir される
- 他 test ファイルから library として import された時のみ chdir が抑止される（impl-report §4.1 の修正動機に整合）

### I. logger.ts strict モード確認（commit d127ab3）

```diff
 export async function log(event: string, detail: string = ""): Promise<void> {
-  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
+  const envRoot = process.env.PROJECT_ROOT;
+  if (!envRoot && process.env.CMUX_TEAM_LOGGER_STRICT === "1") {
+    throw new Error(
+      "logger: PROJECT_ROOT is not set but CMUX_TEAM_LOGGER_STRICT=1. " +
+        "Wrap tests with createDummyProject() from test-project.ts, or pass setProjectRootEnv: true.",
+    );
+  }
+  const projectRoot = envRoot || process.cwd();
```

- env 未設定 + strict=0（既定）では従来通り `process.cwd()` fallback で動作する（後方互換性維持）
- strict=1 のみで throw。production daemon は `CMUX_TEAM_LOGGER_STRICT` を設定しないので、`main.ts:125` で env を設定してから log() が呼ばれる経路と矛盾しない
- `main.ts` の最初の `log()` は pidfile acquire 関連の箇所で、env 設定（module-top）より十分後（plan §2.4 / design-review §9 で裏取り済み）

### J. test-project.ts 実装確認

- `dispose()` が try/finally で env 復元（`test-project.ts:100-109`）
- `disposed` フラグで二重 dispose no-op（`test-project.ts:98-99`）
- `createTeamDir` / `seedTeamJson` / `setProjectRootEnv` / `prefix` / `subdirs` オプションが plan §2.1 の設計通りに実装
- plan §3 Step A-1 の 7 ケースは `test-project.test.ts` で全て網羅:
  - 一意な tmp dir → L36-46
  - subdirs 作成 → L48-59
  - env 書き換え → L72-81
  - env 復元（元 undefined / string 両方） → L90-99 / L101-111
  - withDummyProject の try-finally → L198-208
  - 二重 dispose → L161-167
  - seedTeamJson → L124-135
  - 追加で setProjectRootEnv=false / createTeamDir=false / ensureSubdir / 複数プロジェクト LIFO もカバー → L113-122 / L137-148 / L150-159 / L169-182

### K. 作業境界の逸脱確認（base からの差分）

T292 worktree は `faf8931`（T291 マージ前）から分岐しているため `git diff main..HEAD` には T291 差分も含まれる。実装者が実際に加えた変更を base からの diff で確認:

```
$ BASE=$(git merge-base main HEAD); git diff --numstat $BASE..HEAD -- \
    skills/cmux-team/manager/main.ts skills/cmux-team/manager/logger.ts \
    skills/cmux-team/manager/main.test.ts skills/cmux-team/manager/package.json
11  1   skills/cmux-team/manager/logger.ts
9   4   skills/cmux-team/manager/main.test.ts
7   1   skills/cmux-team/manager/main.ts
3   0   skills/cmux-team/manager/package.json
```

- production daemon の主要モジュール（daemon.ts / conductor.ts / task.ts / master.ts / template.ts / proxy.ts 等）は**変更 0 ファイル**
- 実装者が触った production 側は `main.ts` (7/1) / `logger.ts` (11/1) のみで、いずれも plan で明示された範囲（chdir ガード / strict モード追加）
- plan §6「やらないこと」の全項目に抵触なし:
  - logger.ts cwd fallback は削除されていない（`envRoot || process.cwd()` が残存 — §I 参照）
  - task.ts / daemon.ts / conductor.ts の projectRoot 解決ロジック変更なし
  - process.chdir ベースの分離を採用していない（helper は env 書き換え一択）

### L. コミット粒度

```
$ git log --oneline main..HEAD | wc -l
30
$ git log --oneline main..HEAD | grep -v T292 | wc -l
0
```

全 30 commit に T292 タグ付き。ファイル単位 migrate (22) + helper 本体 (1) + main.ts chdir ガード (1) + pidfile doc 更新 (1) + logger strict (1) + package.json test script (1) + verify-test-no-pollution (1) + tsc fix (1) + impl-report (1)。bisect 用の粒度は十分。

### M. main.test.ts に関する補足

`git diff main..HEAD -- main.test.ts` は 9 追加 / 186 削除と見えるが、これは main 側に T291 が追加した子プロセス spawn 系テストが含まれていないだけで、T292 実装者の実変更は `git diff $BASE..HEAD` で 9 追加 / 4 削除。rebase 時にコンフリクト解消が必要だが、T292 の作業境界違反ではない（Recommendation #4 参照）。
