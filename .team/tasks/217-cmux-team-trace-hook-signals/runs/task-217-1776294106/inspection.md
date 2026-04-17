# T217 Inspection Report — cmux-team trace-hooks サブコマンド

## 判定

**GO** — マージ可能。

plan.md 通りに `trace-store.ts:HookSignalRecord` / `getHookSignals`、`main.ts:cmdTraceHooks`、`i18n.ts:help_trace_hooks` (en/ja) が揃っており、unit test 8 pass / tsc エラー 0 / CLI 受け入れ基準 1-10 全て実機で確認できた。impl-report に plan からの意図的逸脱（fixture を `CONDUCTOR_DONE`/`source=resume` に差し替え、surface 正規表現を 2 本立て化、hook type 列挙を実際の schema 名に修正）の理由が記載されており、いずれも妥当。

## 検品項目ごとの結果

### A. 実装の plan.md 遵守度 — pass

| 項目 | 結果 | 根拠 |
|-----|-----|-----|
| `trace-store.ts` に `HookSignalRecord` 型追加 | ✅ | `trace-store.ts:25-36`、スキーマ `hook_signals` (L53-64) と 1:1 対応 |
| `trace-store.ts` に `getHookSignals(db, opts)` 追加 | ✅ | `trace-store.ts:195-222`、条件動的構築 + `ORDER BY id DESC` + `LIMIT` インライン |
| `main.ts` に `cmdTraceHooks` 追加 | ✅ | `main.ts:3181-3232`、オプション解析 → DB open → 整形 → close |
| `main.ts` switch に `case "trace-hooks"` 追加 | ✅ | `main.ts:3570-3572`（`trace-task` の直後） |
| `main.ts` JSDoc Usage 追記 | ✅ | `main.ts:23` |
| `i18n.ts` en `help_trace_hooks` 追加 | ✅ | en セクション、`help_trace_task` の直後 |
| `i18n.ts` ja `help_trace_hooks` 追加 | ✅ | ja セクション、`help_trace_task` の直後 |
| `i18n.ts` `help_main` 2 ヶ所に 1 行追記 | ✅ | en L563 / ja L1112 |
| 意図的逸脱の理由記載 | ✅ | impl-report に ①fixture を `CONDUCTOR_DONE`/`source=resume` に変更 ②surface 正規表現 2 本立て ③hook type 列挙を schema 実在値に変更、の 3 点の理由が記載済み |

### B. テストの実効性 — pass

5 ケースいずれも意味ある検証:

| ケース | 検証内容 | 形式テストでない根拠 |
|-------|---------|--------------------|
| 全件取得 | len=4, first=CONDUCTOR_DONE, last=SESSION_STARTED, first.id > last.id | id DESC を id 比較で直接検証している |
| type フィルタ | len=2 かつ全行 `type === "SESSION_STARTED"` | `.every()` で条件を確認 |
| surface フィルタ | len=2 かつ全行 `surface === "surface:100"` | `.every()` で確認 |
| task_run_id フィルタ | len=1, type=SESSION_STARTED, surface=surface:200 | 具体的な行を特定できる条件 |
| limit + id DESC | len=2, first=CONDUCTOR_DONE, second=SESSION_STARTED(surface:200) | LIMIT だけでなく新しい順を同時に検証 |

実行結果 (`bun test skills/cmux-team/manager/trace-store.test.ts`):

```
 8 pass
 0 fail
 36 expect() calls
Ran 8 tests across 1 file. [56.00ms]
```

全体 (`bun test skills/cmux-team/manager/`): **368 pass / 0 fail / 774 expect()**、既存テスト regression なし。

### C. 型チェック — pass

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
exit=0
```

`noUncheckedIndexedAccess: true` 下で `rows[0]!`（`expect(rows.length).toBe(N)` 直後に non-null 断定してローカル変数に束縛）の書き方は妥当。長さを確認した直後の参照なので実行時エラーになる経路はない。テストファイル内のみの使用で本体コードには断定を持ち込んでいない。

### D. CLI 動作確認 — pass

実プロジェクトの `/Users/yamamoto/git/cmux-team/.team/traces/traces.db`（6 distinct type: AGENT_SPAWNED / CONDUCTOR_DONE / SESSION_CLEAR / SESSION_IDLE / SESSION_STARTED / SESSION_STOP）に対して実行。

#### 1. ヘルプ表示

```
$ bun main.ts trace-hooks --help
cmux-team trace-hooks -- daemon が受信した hook シグナル履歴を表示

Usage:
  cmux-team trace-hooks [options]

Options:
  --type <TYPE>          hook type で絞り込み（SESSION_STARTED / SESSION_ENDED /
                         SESSION_IDLE / SESSION_CLEAR / AGENT_SPAWNED / SESSION_ASK /
                         CONDUCTOR_DONE など）
  --surface <surface>    surface で絞り込み（"surface:665" / "665" / "C[665]" 受理）
  --task-run <id>        task_run_id で絞り込み（例: "task-217-1776294106"）
  --limit <N>            最大表示件数（デフォルト: 50、新しい順）
  --json                 tabular の代わりに JSON 配列を出力
  ...
```

```
$ bun main.ts --help | grep trace-hooks
  cmux-team trace-hooks                        hook シグナル履歴を表示
```

#### 2. デフォルト表示 (`--limit 5`)

```
$ PROJECT_ROOT=/Users/yamamoto/git/cmux-team bun main.ts trace-hooks --limit 5
TIMESTAMP                      TYPE              SURFACE          PID       DETAIL
2026-04-15T23:16:35.220Z       SESSION_STARTED   S[305]           35496     source=startup
2026-04-15T23:16:34.210Z       AGENT_SPAWNED     S[305]           -         -
2026-04-15T23:15:43.000Z       SESSION_IDLE      S[304]           90363     -
2026-04-15T23:15:43.000Z       SESSION_STOP      S[304]           90363     -
2026-04-15T23:08:24.637Z       SESSION_STARTED   S[304]           90363     source=startup
```

id DESC 順、`S[NNN]` 表記、pid null 時の `-`、source 表示すべて仕様通り。

#### 3. JSON 出力 (`--json --limit 1`)

```
$ ... trace-hooks --json --limit 1
[
  {
    "id": 15,
    "timestamp": "2026-04-15T23:16:35.220Z",
    "type": "SESSION_STARTED",
    "surface": "surface:305",
    "pid": 35496,
    "reason": null,
    "source": "startup",
    "question": null,
    "task_run_id": null,
    "payload_json": "{\"type\":\"SESSION_STARTED\",\"surface\":\"surface:305\",\"pid\":35496,\"sessionId\":\"456c08f9-1882-44f6-9230-dd2d0d608b8d\",\"source\":\"startup\",\"timestamp\":\"2026-04-15T23:16:35.220Z\"}"
  }
]
```

payload_json は raw 文字列のまま保持（decode しない）。仕様通り。

#### 4. type フィルタ — 0 件ケース

実 DB には `SESSION_ENDED` がまだ存在しない（hook 側で `/clear` 系で disconnected 誤判定を避けるため記録のみ、など）ため、以下は空結果で正しい挙動:

```
$ ... trace-hooks --type SESSION_ENDED --limit 3
No hook signals found.

$ ... trace-hooks --type SESSION_ENDED --json
[]
```

#### 5. surface 正規化 — 3 形式で同一結果

`surface:305` に 2 行（`SESSION_STARTED` と `AGENT_SPAWNED`）が入っている状態で:

```
$ ... trace-hooks --surface 305 --limit 3
TIMESTAMP                      TYPE              SURFACE          PID       DETAIL
2026-04-15T23:16:35.220Z       SESSION_STARTED   S[305]           35496     source=startup
2026-04-15T23:16:34.210Z       AGENT_SPAWNED     S[305]           -         -

$ ... trace-hooks --surface surface:305 --limit 3
（同じ 2 行）

$ ... trace-hooks --surface 'C[305]' --limit 3
（同じ 2 行）
```

3 形式すべてで同一結果。

#### 6. 異常系

```
$ ... trace-hooks --limit abc 2>&1 ; echo "exit=$?"
Error: --limit must be a positive number (got: abc)
exit=1

$ ... trace-hooks --limit 0 2>&1 ; echo "exit=$?"
Error: --limit must be a positive number (got: 0)
exit=1
```

### E. 既存機能への影響 — pass

#### `trace-task` smoke test

```
$ bun main.ts trace-task --help
cmux-team trace-task -- タスクのセッション履歴を表示

Usage:
  cmux-team trace-task <task-id> [options]
...
```

正常動作。

#### `git diff --stat`

```
 skills/cmux-team/manager/i18n.ts             | 58 ++++++++++++++++++
 skills/cmux-team/manager/main.ts             | 85 ++++++++++++++++++++++++++-
 skills/cmux-team/manager/trace-store.test.ts | 88 +++++++++++++++++++++++++++-
 skills/cmux-team/manager/trace-store.ts      | 42 +++++++++++++
 4 files changed, 271 insertions(+), 2 deletions(-)
```

変更は plan.md が指定した 4 ファイルのみ。daemon.ts / schema.ts / conductor.ts / hook スクリプトには一切手が入っていない。`help_main` 2 ヶ所（en L563, ja L1112）以外の他のエントリは破壊されていない。

## 実際に叩いたコマンドの出力抜粋

上記「D. CLI 動作確認」に掲載済み。

## Critical findings

なし（NOGO 事項なし）。

## Minor suggestions

1. **hook type 列挙の同期**: en/ja の `help_trace_hooks` で列挙する hook type 名は、今後 `schema.ts:QueueMessage` 側で discriminated union が変わった際に drift しうる。将来 type 名を増減させるときは i18n.ts のヘルプ文字列も同時に更新する運用で OK だが、気になるなら後日 `QueueMessage["type"]` から自動生成する選択肢もある。今回は範囲外。

2. **surface の role 推定**: 現状は `S[NNN]` 統一で plan.md の明示通り。Conductor / Agent 区別が必要になったら hook_signals に role 列を追加するか、`task_sessions` と JOIN する別タスクを起票する運用。今回は対応不要。

3. **`hook_signals` GC の可視化**: CLAUDE.md に記載の通り GC は未実装。`trace-hooks` を日常的に叩く運用に入ると「DB が膨張しているか」を sqlite から直接見る必要がある。将来 `trace-hooks --stats` のようなサブ機能があると便利だが、本タスクの範囲外。

---

以上、**判定: GO**。
