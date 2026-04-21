# T277 Inspection Report

## 判定
**GO**

## 根拠

plan.md §4 / §5 / §9 の 14 項目すべてが完全に実装されている。`bun test` 全 666 pass / 0 fail。plan §7 の 4 つの grep チェックも想定通り（dead code / dead field / comment 乖離なし。test ファイルの `.not.toMatch` 2 箇所のみヒットで意図通り）。新 test 2 本は新仕様（R1 非発火）と T276 race regression を忠実にカバーし、`promptSentAt` 設定・`source_guess=clear_transient` assertion も期待通り動作する。SESSION_ACTIVE R1 は plan の方針通り現状維持で既存 test もそのまま pass。A014 artifact も row 7 取消線 + 注記 / L28 本文 / L266 Mermaid の 3 箇所同期更新が済んでいる。git working tree の変更は plan §4 リストと完全一致の 5 ファイルのみ（`git diff main` に出る dashboard.tsx は T278 unrelated commit で、本ブランチの変更ではない）。typecheck error 2 件は base ブランチで stash 検証した結果、事前から存在する pre-existing error で T277 とは無関係。

## 検証項目

| 観点 | 結果 | 備考 |
|------|------|------|
| plan §9 完了条件 14 項目 | ✅ | 全項目実装済み（下記「完了条件チェック」で個別確認） |
| コード品質（dead code） | ✅ | `sessionIdleAtInAssigning` / `session_idle_at=` / R1 SESSION_IDLE 関連 emitter すべて撤去済み。`schema.ts` の comment からも削除。`restoreConductorState` コメントも連動更新 |
| 新 test 品質 | ✅ | 新仕様 test: status=assigning 維持 + session_idle ログ有 + assigning_window_close/conductor_running 不在を positive/negative 双方で assert。regression test: ①IDLE 先着 / ②CLEAR 後着 / ③STARTED 遷移 の 3 段階を時系列で検証し、task_aborted not.toMatch + session_clear_expected reason=daemon_assign_clear + source_guess=clear_transient を assert |
| T276 race regression 再現性 | ✅ | clearSentAt="17:18:58.000" / promptSentAt=+200ms / idleAt=+2s → elapsedMs=2000<5000 で `guessSessionIdleSource` が `clear_transient` を返す経路を通る。promptSentAt を明示的に conductor に設定することで T276 事例を忠実再現 |
| `bun test` 全 pass | ✅ | `Ran 666 tests across 26 files. 666 pass / 0 fail / 1705 expect() calls` を実行確認 |
| grep 最終確認 | ✅ | 4 コマンドすべて想定通り（sessionIdleAtInAssigning=0 / session_idle_at==0 / assigning_window_close.*SESSION_IDLE=test file 1 行のみ / conductor_running.*via=SESSION_IDLE=test file 1 行のみ） |
| docs/CLAUDE.md 整合性 | ✅ | `sessionIdleAtInAssigning` / `R1 保険` / `R1 分岐` / `SESSION_IDLE.*R1` のいずれも docs/ および CLAUDE.md に残存なし |
| A014 artifact 更新 | ✅ | row 7 は `~~...~~` 取消線 + 「T277 で撤去」注記、L25-28 の `running` 行本文を SESSION_ACTIVE のみ言及に修正、L266 Mermaid から `IDLE` を除去 |
| git diff 妥当性 | ✅ | 修正 5 ファイル（A014 / conductor.ts / daemon.ts / daemon.test.ts / schema.ts）は plan §4 と一致。`git diff main` で出る dashboard.tsx 変更は main 側にのみ存在する T278（086a29c）の変更で、本ブランチでは編集していない |

## 完了条件チェック（plan §9 の 14 項目）

- [x] `daemon.ts:1933` の SESSION_IDLE R1 分岐削除（跡地に `// T277:` コメントで意図を残す 4 行。no-op 化ではなく分岐そのものを完全削除）
- [x] `daemon.ts:1825` の SESSION_ACTIVE R1 分岐は変更なしで存続（plan §2「変更しない」遵守）
- [x] `schema.ts:250, 255` の `sessionIdleAtInAssigning` コメント + フィールド定義削除
- [x] `conductor.ts:507-508` のコメントから SESSION_IDLE を除外 + T277 注記追加
- [x] `conductor.ts:650` の `sessionIdleAtInAssigning = undefined` 削除
- [x] `daemon.ts:236` `formatUserClearDecision` から `session_idle_at=...` 列削除
- [x] `daemon.test.ts:2337-2429` 既存 R1 SESSION_IDLE test を新仕様 test 2 本に置き換え
- [x] `daemon.test.ts:2430-2451` SESSION_ACTIVE R1 test は変更なしで pass
- [x] `daemon.test.ts` L3909-3938 重複 test 削除（現在は存在しない）
- [x] T276 race regression test 追加（`promptSentAt` 設定 + `source_guess=clear_transient` assertion 含む）
- [x] 永続化 test（describe "T261 フィールド永続化"）から `sessionIdleAtInAssigning` assertion 削除、「他 4 フィールド」→「他 3 フィールド」へテキスト更新
- [x] `bun test` 全 pass: 666 pass / 0 fail
- [x] A014 row 7 / L28 本文 / L266 Mermaid を同期更新
- [x] §7 grep チェック 4 コマンド実行 — 想定外参照なし

## 検証で実行したコマンドと出力

### 1. `bun test` (全 26 ファイル)

```
 666 pass
 0 fail
 1705 expect() calls
Ran 666 tests across 26 files. [37.26s]
```

### 2. plan §7 grep チェック

```
$ git grep -n "sessionIdleAtInAssigning" -- skills/ .team/ docs/
→ NO MATCH ✅

$ git grep -n "session_idle_at=" -- skills/ .team/ docs/
→ NO MATCH ✅

$ git grep -n "assigning_window_close.*SESSION_IDLE" -- skills/ .team/ docs/
skills/cmux-team/manager/daemon.test.ts:2361-2362
  // assigning_window_close via=SESSION_IDLE は出ない
  expect(logContent).not.toMatch(/assigning_window_close C\[277a\] via=SESSION_IDLE/);
→ 新 test の否定 assertion のみ ✅

$ git grep -n "conductor_running.*via=SESSION_IDLE" -- skills/ .team/ docs/
skills/cmux-team/manager/daemon.test.ts:2363-2364
  // conductor_running via=SESSION_IDLE も出ない
  expect(logContent).not.toMatch(/conductor_running C\[277a\] via=SESSION_IDLE/);
→ 新 test の否定 assertion のみ ✅
```

### 3. docs/CLAUDE.md R1 言及チェック

```
$ git grep -n -E "(sessionIdleAtInAssigning|R1 保険|R1 分岐|SESSION_IDLE.*R1)" docs/ CLAUDE.md
→ NO MATCH ✅
```

### 4. 残存 R1 言及（撤去後の状態確認）

```
skills/cmux-team/manager/daemon.ts:1825:          // T232 R1: ...          ← SESSION_ACTIVE R1（現状維持）
skills/cmux-team/manager/daemon.ts:1938:        //       旧 R1 分岐 ... 撤去した。 ← T277 撤去コメント
skills/cmux-team/manager/conductor.ts:509:    //       （T277: SESSION_IDLE R1 は撤去済み）
skills/cmux-team/manager/daemon.test.ts:2336,2337,2356,2388,2430   ← 全て新 test コメント or SESSION_ACTIVE R1 test
```
すべて plan 方針と整合。

### 5. `git diff --stat HEAD` (working tree)

```
 .team/artifacts/A014-conductor-state-machine.md |   8 +-
 skills/cmux-team/manager/conductor.ts           |   6 +-
 skills/cmux-team/manager/daemon.test.ts         | 126 +++++++++++++++---------
 skills/cmux-team/manager/daemon.ts              |  26 +----
 skills/cmux-team/manager/schema.ts              |   2 -
 5 files changed, 93 insertions(+), 75 deletions(-)
```

plan §4 の変更対象 5 ファイル（A014 + 4 source files）と完全一致。

補足: `git diff main --stat` では `dashboard.tsx` が表示されるが、これは main の 086a29c（T278 "fix(dashboard): Artifacts タブのスクロールをカーソル追従にする"）commit で行われた別タスクの変更で、本ブランチには含まれていない（HEAD=30bc99b が main の祖先のため main 側の追加 commit が diff に逆方向で出ている）。T277 の変更ではない。

### 6. typecheck (pre-existing errors 確認)

```
$ bun x tsc --noEmit (working tree)
conductor.ts(197,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3720,9): error TS2322: Type '"new_session"' is not assignable to ...

$ git stash && bun x tsc --noEmit (base HEAD)
conductor.ts(197,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3650,9): error TS2322: Type '"new_session"' is not assignable to ...
```

両 error とも stash 後の base にも存在するため **T277 とは無関係の pre-existing error**。impl-report の記述通り。本タスクスコープ外。

## 総評

plan が詳細かつ実装もそれに忠実。dead code / dead field の撤去が徹底されており、新 test 2 本はそれぞれ新仕様 (R1 非発火) と T276 race regression を positive/negative assertion の両面で締めている。特に regression test で `promptSentAt` を明示設定し `source_guess=clear_transient` の経路を assertion で担保している点は、T276 事例の忠実再現として設計上の厚みがある。A014 も Mermaid 図・表・本文の 3 箇所を同時更新しており、今後の state machine 変更時の参照ドキュメントとしての整合性が保たれている。merge 後の T278 cascade でも影響は出ない範囲（dashboard.tsx の変更領域と重複なし）。
