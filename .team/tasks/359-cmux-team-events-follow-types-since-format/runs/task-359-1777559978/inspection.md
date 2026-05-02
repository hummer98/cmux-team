# T359 検品

## Verdict

**GO**

plan.md（Approved 済み）と design-review.md（Iteration 2 Approved）に対し、実装は仕様・テスト網羅性・実装品質・CLI 実機動作・型検査の全観点で要求を満たしている。Critical / Major の不備なし。後段で挙げる Minor 1 件は scope 外の environmental drift で、Implementer の責任ではないが本タスクの commit からは除外することを推奨する。

---

## Findings

### Critical（NOGO 確定）

なし。

### Major（修正推奨だが GO 可）

なし。

### Minor（任意改善）

- **m1: `package-lock.json` が 4.20.0 → 4.22.0 に書き換わっている**
  Implementer の意図的な変更ではなく、worktree 内で `bun install` が走った副作用（直近 commit `chore: release v4.22.0` 由来）。plan の出力ファイル一覧 (§4) には含まれず、本タスクの責務外。**commit に含めずに `git checkout -- package-lock.json` で破棄するのが望ましい**。挙動には影響しないため GO 障害ではない。

- **m2: help_events の `section 8` 表記**
  i18n.ts の help blob が `spec section 8 forward-compat` となっており、plan §5.2 の例示 `spec §8 forward-compat` と微妙に違う。en/ja で同一文を採用する方針自体は plan 通りで、`§` を ASCII 化したのは template literal や端末表示の互換性を意識した妥当な判断。Implementer 判断レベルで OK。

- **m3: `task_sync_guard_rejected` の field 順 — design-review m11 の記載通り plan を真値**
  実装は plan §2.5.3 表どおり `task_id, kind, main_branch, detail` の順で text 化。writer 側の宣言順 (`task_id, kind, detail, main_branch`) とは一致しないが、design-review m11 で「plan 表を真値、writer との順序差は微小なので Implementer 判断で OK」と確定済み。実装はその判断に従っており問題なし。

---

## A. 仕様適合（チェック結果）

| 項目 | 結果 |
|------|------|
| `--follow` / `-f` / `--types` / `--since` / `--format` | events-cli.ts:46-99 全 flag 動作 |
| exit code 0（正常 EOF / SIGINT graceful）/ 1（引数エラー / not found） | events-cli.ts:480-510, plan §6.5 通り |
| spec §8 reader 実装ガイドライン 4 項目 | events-cli.ts:281-308（schema 範囲外、未知 event、JSON parse 失敗、必須 field 欠損 全て skip + stderr warn） |
| writer 17 event の text format mapping | events-cli.ts:166-241 / events-writer.ts:47-134 と完全一致（task_created / task_ready / task_assigned / task_completed / task_completed_state_mismatch / task_aborted / task_sync_guard_rejected / task_reverted_to_ready / conductor_running / conductor_recovered / conductor_disconnected / conductor_asking / conductor_done_unresolved / conductor_start_timeout / conductor_assign_timeout / conductor_disconnect_timeout / api_error_received） |
| `--types` exact match / 空 list 拒否 | events-cli.ts:107-116（Set membership + ArgError on empty） |
| `--since` duration / ISO 8601 / エラー path | events-cli.ts:118-142（DURATION_RE + ISO_LIKE_RE で `5` 系を弾く処理系差対応） |
| `journal_summary` を text format から省く | events-cli.ts TEXT_FIELDS に journal_summary フィールドが含まれていない（plan §2.5.3 通り） |
| help blob の en/ja 同一英語文 | i18n.ts:560-589 (en) / 1407-1436 (ja) で完全同一 |
| `help_main` subcommand 一覧に events 行追加 | i18n.ts:769-770 (en) / 1617-1618 (ja) |

## B. テスト網羅性（チェック結果）

events-cli.test.ts は **19 ケース**（必須 11 + follow 系 2 + 補助 6）を実装。plan §3.2 の TDD 順序に沿う。

| plan ケース # | 実装 | カバー範囲 |
|---|---|---|
| 1 (events.jsonl 不在) | ✅ | exit 1 + stderr `not found` |
| 2 (全件 raw 出力) | ✅ | 順序保持 / raw line 一致 |
| 3 (--types) | ✅ | csv / 単一 / 空 list 引数エラー |
| 4 (--since duration) | ✅ | 5m / 2d 両方 |
| 5 (--since ISO 8601) | ✅ | 境界含む（>= since） |
| 6 (--since 引数エラー) | ✅ | abc / 3w / **5** 全 fail |
| 7 (--format text 17 event) | ✅ | 全 17 event の string match + journal_summary 省略 + optional task_id 省略 |
| 8 (不正 JSON skip + warn) | ✅ | 後続 valid 行は出る |
| 9 (schema_version=3 / 1 skip) | ✅ | strict equality（v1 も skip + warn） |
| 10 (未知 event) | ✅ | skip + warn |
| 11 (引数エラー: --format yaml / 未知 flag / --types 値なし) | ✅ | exit 1 |
| 12 (--follow append) | ✅ | poll 20ms / 後発 append を拾う / abort で exit 0 |
| 13 (--follow rotate) | ✅ | rename + 新ファイル検知 / 新先頭から再読 |

各テストは `createDummyProject` で temp dir を取得し独立。fixture を直接書いて in-process で `runEventsCli` を呼ぶ test 容易性は plan §1.1 の設計判断通り。

## C. 実装品質（チェック結果）

| 項目 | 結果 |
|------|------|
| `runEventsCli` が `process.exit` を呼ばず `Promise<number>` を返す | events-cli.ts:474（design-review m1 通り） |
| dispatcher 配置: `case "trace-hooks":` の直後 / `case "conductor":` の直前 | main.ts:5530-5537（plan §1.3 / §5.1 通り） |
| i18n.ts に ja / en 両 `help_events` 追加 | i18n.ts:560 / 1407 |
| 空の `catch {}` | fd close / wait abort 等の冪等な後処理に限定。ロジック分岐に絡む箇所では stderr に warn を出す（events-cli.ts:271-279, 281-285, 297-307, 314-328） |
| logger.ts → eventBus.ts の import 禁止違反 | 該当なし。events-cli.ts は logger.ts も eventBus.ts も触っていない |
| `cmdStatus` 等の慣行との整合 | `cmdEvents` は plan §5.1 通り `try { runEventsCli } finally { listener off } process.exit(exitCode)` パターン。design-review M3 の修正反映済み |
| TDD red→green 証跡 | impl-summary §"TDD red → green の証跡" にモジュール未存在 → 18/19 → 19/19 の段階を記録 |

`KNOWN_FLAGS` / `FLAGS_WITH_VALUE` を Set 化したリファクタも軽量で読みやすい。`flushBufferedLines` / `readIncrement` を follow loop 共通ヘルパに抽出したのも責務分離として妥当。

## D. CLI 実機動作（検証ログ）

```
$ bun .../main.ts events --help
cmux-team events -- tail / filter the events stream

Usage:
  cmux-team events [options]
... (28 行の help blob 出力)
```

Smoke test fixture（task_assigned + task_aborted）を temp dir に書いて `events` / `events --format text` / `events --format text --types task_aborted` / `events --format yaml`（不正値）/ events.jsonl 不在 の 5 ケースを手動実行:

```
=== json ===
{"ts":"2026-04-27T12:34:56.789Z","schema_version":2,"event":"task_assigned","task_id":"T357",...}
{"ts":"2026-04-27T12:35:00.000Z","schema_version":2,"event":"task_aborted","task_id":"T357",...}
=== text ===
2026-04-27T12:34:56.789Z task_assigned task_id=T357 conductor_surface=surface:5 task_run_id=task-357-1777260538
2026-04-27T12:35:00.000Z task_aborted task_id=T357 reason=user_clear
=== types filter ===
2026-04-27T12:35:00.000Z task_aborted task_id=T357 reason=user_clear
=== invalid format ===
Error: invalid --format value: yaml (must be json or text)
Run 'cmux-team events --help' for usage.
exit=1
=== not found ===
Error: events.jsonl not found at /var/folders/.../tmp.../.team/logs/events.jsonl
exit=1
```

全ケース仕様通り。raw JSON 出力で writer の JSON.stringify 結果がそのまま流れていること、`--format text` で `journal_summary` が省略されていることを確認。

## E. tsc / test 確認

### tsc

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
(no output / exit 0)
```

新規 / 修正ファイル全体で **type error 0 件**。

### bun test (events-cli.test.ts のみ実行 — 全体 bun test は禁忌 / A021 通り)

```
$ bun test --timeout 30000 events-cli.test.ts
bun test v1.3.13 (bf2e2cec)

 19 pass
 0 fail
 93 expect() calls
Ran 19 tests across 1 file. [116.00ms]
```

19 ケース全 pass / 116ms で完走。flake 観測なし。

## F. plan / scope 違反

`git status` で本タスクが触ったファイルを確認:

```
M  package-lock.json    ← Minor m1（version bump、Implementer の責務外）
M  skills/cmux-team/manager/i18n.ts          ← plan §4 通り
M  skills/cmux-team/manager/main.ts          ← plan §4 通り
?? skills/cmux-team/manager/events-cli.test.ts  ← 新規
?? skills/cmux-team/manager/events-cli.ts       ← 新規
```

- **T358 / T360 / T361 領域への侵入なし**: events-writer.ts / docs/spec/10-events-stream.md（特に §5 16 event 表記）/ retention policy のいずれも未変更。
- **writer / retention policy への手入れなし**: plan §6.10 通り writer 真値を採用しつつ writer は touch していない。
- **spec docs を未編集**: 17 vs 16 の食い違い指摘は impl-summary 残課題に retro 連携トリガーとして明記されており、本タスク内で spec を修正していないことを confirm。

## G. CLAUDE.md ガードレール違反

- **bun test 全体実行なし**: 検品時の test も `events-cli.test.ts` 単発で実行（A021 / `.github/workflows/test.yml` の per-file ループ方針に整合）。
- **`taskState[...] =` 等の禁止操作なし**: events-cli.ts は task-state を一切触らない。CLI は events.jsonl の read-only consumer。
- **直接ファイル書き込み禁止違反なし**: テストの fixture は `.team/logs/events.jsonl` で、`.team/tasks/` への直接書き込みではない（CLI 強制ガードの対象外）。

---

## 検証ログ

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
(no output / exit 0)

$ bun test --timeout 30000 events-cli.test.ts
bun test v1.3.13 (bf2e2cec)

 19 pass
 0 fail
 93 expect() calls
Ran 19 tests across 1 file. [116.00ms]

$ bun .../main.ts events --help    # 28 行の usage 出力 (exit 0)
$ PROJECT_ROOT=$tmp bun .../main.ts events                  # 2 行の raw JSONL 出力 (exit 0)
$ PROJECT_ROOT=$tmp bun .../main.ts events --format text    # 2 行の text format (exit 0)
$ PROJECT_ROOT=$tmp bun .../main.ts events --format text --types task_aborted   # 1 行 (exit 0)
$ PROJECT_ROOT=$tmp bun .../main.ts events --format yaml    # exit=1, stderr に invalid --format
$ PROJECT_ROOT=$empty bun .../main.ts events                # exit=1, stderr に not found
```

---

## Fix Required（NOGO の場合）

GO 判定のため必須修正なし。

任意の改善として:

1. **package-lock.json の差分は commit から除外**:
   ```bash
   git -C /Users/yamamoto/git/cmux-team/.worktrees/task-359-1777559978 checkout -- package-lock.json
   ```
   本タスクは package.json / 依存を一切変えていないため、lockfile の version bump は本 PR の責務外。

retro 連携項目（本タスクの scope 外、T361 / docs-sync で扱う）:
- spec §5 の 16 event 表記を 17 に更新（writer は既に `api_error_received` を含む 17 event を emit、CLI も 17 event を mapping 済み）
- 必要に応じて SIGINT exit code を 0 → 130 に変更する follow-up タスク（plan §6.5 / m3）
