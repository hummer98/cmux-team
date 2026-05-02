# T359 実装サマリー — `cmux-team events` サブコマンド

## 概要

T358 writer が emit する `.team/logs/events.jsonl` を tail / filter / format conversion する CLI を、Approved 済み plan.md に従って TDD（red → green → refactor）で実装した。

## 作成 / 修正したファイル

| 種別 | パス | 行数 | 概要 |
|------|------|------|------|
| 新規 | `skills/cmux-team/manager/events-cli.ts` | 514 | CLI 本体。`runEventsCli(opts): Promise<number>` を export |
| 新規 | `skills/cmux-team/manager/events-cli.test.ts` | 722 | bun test 19 ケース（必須 11 + follow / rotate 2 + 補助 6） |
| 修正 | `skills/cmux-team/manager/main.ts` | +29 | `import { runEventsCli }` / `case "events":` / `cmdEvents()` thin wrapper |
| 修正 | `skills/cmux-team/manager/i18n.ts` | +66 | en/ja blob に `help_events` を追加（同一英語文を流用、plan §5.2）。両 blob の `help_main` subcommand 一覧に events 行を追加 |

## テスト結果

```
$ bun test --timeout 30000 events-cli.test.ts
 19 pass
 0 fail
 93 expect() calls
Ran 19 tests across 1 file.
```

main.ts 修正による回帰がないことを `daemon.test.ts` で確認:

```
$ bun test --timeout 30000 daemon.test.ts
 187 pass
 0 fail
 667 expect() calls
```

events-writer.test.ts も合わせて smoke 実施:

```
$ bun test --timeout 30000 events-cli.test.ts events-writer.test.ts
 38 pass
 0 fail
 246 expect() calls
```

## tsc 結果

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
(no output / exit 0)
```

touch したファイル（events-cli.ts / events-cli.test.ts / main.ts / i18n.ts）に関する新規 tsc エラー: **0 件**。

## TDD red → green の証跡

### Step 1 (red): test 先行作成

`events-cli.test.ts` を新規作成し、まだ実装前の状態で `bun test events-cli.test.ts` を実行:

```
events-cli.test.ts:
# Unhandled error between tests
error: Cannot find module './events-cli' from '/.../events-cli.test.ts'
 0 pass
 1 fail
 1 error
```

→ red 状態を確認（モジュール未存在による失敗）。

### Step 2 (green): 実装

`events-cli.ts` を作成して `runEventsCli` / `parseTypes` / `parseSince` / `formatText` /
`runFollowLoop` を実装。初回テスト実行で 18 pass / 1 fail（`Date.parse("5")` を Bun が
valid と解釈する処理系差で test #6 の `--since 5` が通ってしまった）。

→ ISO 8601 like の形状チェック (`^\d{4}-\d{2}-\d{2}/`) を duration regex 不一致時に追加し
`Date.parse` を呼ぶ前に弾くよう修正。

```
$ bun test --timeout 10000 events-cli.test.ts
 19 pass
 0 fail
 93 expect() calls
```

→ 全 19 ケース green 達成。

### Step 3 (refactor)

実装中に取り出した `flushBufferedLines` / `readIncrement` ヘルパで follow loop の重複削減、
`KNOWN_FLAGS` / `FLAGS_WITH_VALUE` の Set 化で argv parser の switch を簡潔化。
全テスト green 維持。

## plan.md にない補足設計判断

1. **ISO 8601 like の形状チェックを `parseSince` に追加**
   `Date.parse("5")` の処理系差（Node.js は NaN、Bun は year=5 として valid）に
   対応するため、duration 正規表現が一致しなかった場合は `^\d{4}-\d{2}-\d{2}/` で
   ISO 8601 like の形状を先に確認してから `Date.parse` を呼ぶようにした。
   plan §2.4 の表で `5` は引数エラーと明示されており、本ガードは plan の意図に沿う。
   help blob の `--since` 説明 (en/ja 同一) には影響なし（ISO 8601 の例示は
   `2026-04-27T12:00:00Z` のみ）。

2. **`runEventsCli` 内で `--help` を処理し `t("help_events")` を stdout に書く**
   design-review m9 の指摘（cmdEvents の `hasHelpFlag()` と runEventsCli 内 parser の
   二重 parse 懸念）を踏まえ、help short-circuit は `runEventsCli` 内に寄せて
   `cmdEvents` 側では `hasHelpFlag()` を呼ばないシンプル形にした。test では
   --help 経路は assert していないが、production 経路は in-process で help text を
   stdout に書いて 0 を返すため検証可能。

3. **未知 event の skip + warn**
   plan §2.5.3 末尾で「未知 event は §2.2 の段階で skip + warn」と言及あり。
   `KNOWN_EVENTS = new Set(Object.keys(TEXT_FIELDS))` を unknown event 判定に
   流用し、format=json でも format=text でも skip 経路を統一した。

4. **CRLF 終端の strip**
   将来 Windows で events.jsonl が編集された場合に備え、`processLine` 冒頭で
   `\r$` を strip してから JSON.parse する。spec §2 (LF 1 行 1 record) 準拠の
   writer 出力では no-op。

5. **dispatcher の配置**
   plan §1.3 / §5.1 に従い `case "trace-hooks":` の直後、`case "conductor":` の
   直前に配置。行番号は使用せず構造で特定済み。

## 守ったガードレール

- `logger.ts` からの `eventBus.ts` import 禁止 — 本タスクは logger.ts に触っていない（events-cli.ts は logger を import しないし `eventBus` も触らない）
- 空の `catch {}` — fd close 等の冪等な後処理に限定。それ以外は warn を stderr に出す
- 既存 subcommand のスタイル — args parser は `cmdTraceHooks` のスタイルに合わせ、
  cmdEvents の `try/finally → process.exit` パターンは plan §5.1 通り

## 残課題・懸念

- **#12 / #13 follow テストの flakiness**: poll interval 20ms / waitUntil 2s で
  ローカル CI 共に安定しているが、CPU 過負荷時に flake する可能性は残る。
  実測では 19 テストを 110-150ms で完走しており現時点で flake は観測なし。
- **SIGINT exit code 0 の trade-off**: plan §6.5 / design-review m3 で確定済み。
  CI 上で SIGINT と通常 EOF を区別する必要が出た場合は follow-up タスクで 130 へ
  変更可能（test 書き換えコストは低い）。
- **writer 17 event vs spec §5 16 event の食い違い**: plan §6.10 通り writer 真値で
  実装。spec §5 の 16 event 表記の修正は T361 / docs-sync の責務として retro へ送る。
  `api_error_received` の text mapping は writer 型と一致しており、debug 用途で
  穴が空かないことを test #7 で確認済み。
- **`bun test` 全体実行**: CLAUDE.md / .team/artifacts/A021 の通り禁忌。本タスク
  検証では `events-cli.test.ts` / `events-writer.test.ts` / `daemon.test.ts` の
  3 ファイルに限定して実行した。
