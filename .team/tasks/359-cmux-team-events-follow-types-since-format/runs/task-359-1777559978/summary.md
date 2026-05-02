# T359 結果サマリー — `cmux-team events` サブコマンド

## 概要

T358 writer が emit する `.team/logs/events.jsonl` を tail / filter / format conversion する CLI を、4 フェーズ（Plan → Design Review → TDD Impl → Inspection）で実装した。

## 完了したサブタスク

| Phase | Agent | 出力 | 結果 |
|------|-------|------|------|
| 1 Plan | Planner | plan.md | 初版作成 |
| 2 Design Review | Design Reviewer | design-review.md | iter1 Changes Requested → iter2 Approved |
| 1' Replan | Planner | plan.md (改訂版) | Recommendations 1〜7 全反映 |
| 3 Impl | Implementer | events-cli.ts / events-cli.test.ts / impl-summary.md | TDD 19 ケース全 pass |
| 4 Inspection | Inspector | inspection.md | **GO**（Critical / Major なし、Minor 1 件のみ） |

## 変更ファイル

| 種別 | パス |
|------|------|
| 新規 | `skills/cmux-team/manager/events-cli.ts`（514 行） |
| 新規 | `skills/cmux-team/manager/events-cli.test.ts`（722 行 / 19 ケース） |
| 修正 | `skills/cmux-team/manager/main.ts`（dispatcher に `case "events":` 追加） |
| 修正 | `skills/cmux-team/manager/i18n.ts`（en/ja 両 blob に `help_events` + `help_main` への events 行追加） |

`package-lock.json` の version drift（`bun install` の副作用）は Inspector m1 推奨に従い破棄。

## CLI 仕様（実装済み）

```
cmux-team events [--follow|-f] [--types <list>] [--since <duration|timestamp>] [--format json|text]
```

- `--follow`: tail -F equivalent（rotate 検知で再 open、重複出力許容）
- `--types`: comma-separated exact match filter（空 list は引数エラー）
- `--since`: duration（`5m` / `1h` / `2d`）or ISO 8601（`2026-04-27T12:00:00Z`）
- `--format json`（default）: raw JSONL passthrough / `--format text`: `<ts> <event> key=value ...`
- exit 0: 正常 EOF / SIGINT graceful、exit 1: 引数エラー / events.jsonl 不在
- spec §8 forward-compat: 不正 JSON / 未知 event / schema_version 範囲外は stderr warn + skip

writer の 17 event 全てに対し text format key field mapping を実装（spec §5 は 16 event 表記だが writer 実装が真値、spec 修正は T361 の責務）。

## テスト結果

```
$ bun test --timeout 30000 events-cli.test.ts
 19 pass
 0 fail
 93 expect() calls
Ran 19 tests across 1 file. [116ms]
```

回帰確認:
- `daemon.test.ts`: 187 pass / 0 fail
- `events-writer.test.ts`: 19 pass / 0 fail

## tsc 結果

```
$ bunx tsc --noEmit
(no output / exit 0)
```

新規エラー 0 件。

## マージコミット

（後段で埋める）

## 主な設計判断

1. `runEventsCli(opts): Promise<number>` を export し test 容易性を確保（`process.exit` は呼び出し側 `cmdEvents` で）
2. line buffering: non-follow は `FileHandle.createReadStream() + readline.createInterface`、follow は自前 `read(fd, buf)` + line buffer + poll
3. rotate 検知: inode 変化 / size 縮小で再 open。重複出力は consumer 側 dedupe 責任とし help に明示
4. writer 17 event を真値とし、spec §5 の 16 event 表記との乖離は T361 / docs-sync の責務として retro へ送る
5. ISO 8601 like 形状チェックを `parseSince` に追加（`Date.parse("5")` の Bun 処理系差対応）
