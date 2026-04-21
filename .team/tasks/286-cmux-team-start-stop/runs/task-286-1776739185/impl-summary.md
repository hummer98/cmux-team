# Implementation Summary: T286

## 完了したサブタスク

- [x] S1: `applyDiscardOnly` 関数抽出 + `layout_restore_empty_fallback` 分岐
- [x] S2: `layout_mismatch_on_resume` を純観測ログ化
- [x] S3: M17a / M17b / M17c / M17d のマトリクス復帰テスト追加
- [x] S4: `cmdStop` 関数 + `case "stop"` 分岐 + JSDoc 行削除（main.ts）
- [x] S5: `help_stop`（en/ja）+ `help_main` の `cmux-team stop` 行削除（i18n.ts）
- [x] S6: `PidFileLockedError` メッセージから `Run 'cmux-team stop' or` を除去
- [x] S7: ドキュメント書き換え（README.md / README.ja.md / CLAUDE.md / docs/spec/01-03-06 / SKILL.md / cmux-team-guide）
- [x] S8: CHANGELOG `[Unreleased]` セクション追加（Changed (Breaking) + Fixed）
- [x] S9: 全体検証（`bun test` 852 pass / 0 fail、`bunx tsc --noEmit` 新規 0 件）

## 変更ファイル一覧

| ファイル | 差分 |
|---------|------|
| `skills/cmux-team/manager/daemon.ts` | +99 / -... |
| `skills/cmux-team/manager/daemon.test.ts` | +236 / -0 |
| `skills/cmux-team/manager/main.ts` | +0 / -28 |
| `skills/cmux-team/manager/main.test.ts` | +36 / -0 |
| `skills/cmux-team/manager/i18n.ts` | +0 / -26 |
| `skills/cmux-team/manager/pidfile.ts` | +1 / -1 |
| `skills/cmux-team/manager/pidfile.test.ts` | +13 / -0 |
| `CHANGELOG.md` | +8 |
| `CLAUDE.md` | +2 / -2 |
| `README.md` | +4 / -3 |
| `README.ja.md` | +5 / -4 |
| `docs/spec/01-skill-cmux-team.md` | +3 / -2 |
| `docs/spec/03-commands.md` | +2 / -1 |
| `docs/spec/06-implementation-tasks.md` | +4 / -3 |
| `skills/cmux-team/SKILL.md` | +3 / -2 |
| `skills/cmux-team-guide/SKILL.md` | +3 / -3 |

合計: 16 files changed, +397 / -97

## テスト結果

- `bun test --timeout 600000`: **852 pass, 0 fail, 2057 expect() calls**
- 新規追加テスト:
  - `daemon.test.ts` 「マトリクス復帰」describe 配下 — M17a（全 E discard）/ M17b（全 C idle cleanup）/ M17c（C+E 混在）/ M17d（全 E + resumePlan unmatched）
  - `main.test.ts` 「cmdStop 廃止 (T286)」describe — Unknown command で exit 1、冪等性（2 回連続呼び出し）
  - `pidfile.test.ts` — PidFileLockedError メッセージに `cmux-team stop` 案内なし / `kill <pid>` + `cmux` 案内あり
- `bunx tsc --noEmit`: **既存 3 件のみ（新規 0）**
  - `conductor.ts(201,3)` — TS1016 optional parameter followed by required（既存）
  - `daemon.test.ts(3956,9)` — TS2322 `"new_session"` type（既存）
  - `daemon.ts(1597,22)` — TS2352 SESSION_STARTED cast（既存）

## 検証コマンド出力（plan.md §5 の検証コマンド）

```
$ grep -A 3 'reason === "surface_missing_no_task"' skills/cmux-team/manager/daemon.ts | grep conductor_discarded
        "conductor_discarded",

$ sed -n '/^async function applyDiscardOnly/,/^}/p' skills/cmux-team/manager/daemon.ts | grep -c "Promise.all"
0

$ grep -c "layout_restore_empty_fallback" skills/cmux-team/manager/daemon.ts
1

$ grep -c "cmdStop\|async function cmdStop" skills/cmux-team/manager/main.ts
0

$ grep -c 'case "stop"' skills/cmux-team/manager/main.ts
0

$ grep -c "help_stop" skills/cmux-team/manager/i18n.ts
0

$ grep "cmux-team stop" skills/cmux-team/manager/pidfile.ts
(no output)
```

## TDD 進行記録

| Step | Phase | 結果 |
|------|-------|------|
| S1 | RED | M17a 系テスト追加 → fail 確認 |
| S1 | GREEN | `applyDiscardOnly` 抽出 + fallback 分岐 → pass |
| S1 | REFACTOR | JSDoc 追記（sequential 契約を明示） |
| S2 | RED | `layout_mismatch_on_resume` メッセージ assertion 変更 → fail |
| S2 | GREEN | メッセージから stop 案内を削除 → pass |
| S3 | RED→GREEN | M17b / M17c / M17d を追加、resume 分岐と cleanup-stale cleanup の期待値を新規実装に合わせる |
| S4 | RED | `runStop(["stop"])` で exit 1 + Unknown command を期待 → fail（exit 0 で SHUTDOWN sent） |
| S4 | GREEN | `cmdStop` 定義削除 + switch 分岐削除 + JSDoc 行削除 → pass |
| S5 | (S4 と同時) | i18n.ts から help_stop / help_main stop 行削除、stop --help の挙動テストは default case の汎用動作と重複するため破棄 |
| S6 | RED | PidFileLockedError.message に `cmux-team stop` を含まないこと → fail |
| S6 | GREEN | メッセージを `kill <pid> first, or close the cmux session (daemon auto-stops on cmux exit).` に変更 → pass |
| S7 | N/A | grep ベースでドキュメント書き換え完了 |
| S8 | N/A | CHANGELOG `[Unreleased]` 追記 |
| S9 | N/A | full test + tsc 検証完了 |

## 残課題・懸念

なし。既存 3 件の tsc エラーは本タスクのスコープ外（SESSION_STARTED 型 / optional param 順 / "new_session" cast）で、新規エラーは 0 件。全 852 テスト pass。
