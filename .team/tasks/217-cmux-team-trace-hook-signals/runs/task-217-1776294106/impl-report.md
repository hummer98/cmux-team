# T217 Implementation Report — cmux-team trace-hooks サブコマンド

## 変更ファイル一覧

| 相対パス | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/trace-store.ts` | `HookSignalRecord` 型と `getHookSignals(db, opts)` 関数を追加 |
| `skills/cmux-team/manager/trace-store.test.ts` | `getHookSignals` の unit test を 5 ケース追加（既存 3 + 新規 5 = 8） |
| `skills/cmux-team/manager/main.ts` | import 追加、`cmdTraceHooks` + 3 ヘルパ関数追加、switch に `case "trace-hooks"` 追加、JSDoc Usage 更新 |
| `skills/cmux-team/manager/i18n.ts` | `help_trace_hooks` を en / ja に追加、`help_main` 2 ヶ所に 1 行追記 |

## テスト結果

### bun test (全体)

```
368 pass
0 fail
774 expect() calls
Ran 368 tests across 17 files. [9.30s]
```

### bun test trace-store.test.ts のみ

```
8 pass
0 fail
36 expect() calls
Ran 8 tests across 1 file. [55ms]
```

内訳:
- `insertHookSignal (T216)`: 3 ケース（既存）
- `getHookSignals (T217)`: 5 ケース（新規）
  1. 全件取得 — id DESC で最新順
  2. type フィルタ
  3. surface フィルタ
  4. task_run_id フィルタ
  5. limit + ORDER BY id DESC

### 型チェック

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
(output: empty, exit 0)
```

エラー 0 件。

## CLI 手動確認

fixture 用の一時プロジェクトを `/tmp/cmux-team-t217-test` に作成し、`skills/cmux-team/manager/trace-store.ts` の `initDB` + `insertHookSignal` を直接呼ぶ seed スクリプトで 4 行を挿入してから CLI を実行。

### 受け入れ基準 5 — デフォルト表示 `trace-hooks --limit 3`

```
$ PROJECT_ROOT=/tmp/cmux-team-t217-test bun skills/cmux-team/manager/main.ts trace-hooks --limit 3
TIMESTAMP                      TYPE              SURFACE          PID       DETAIL
2026-04-16T10:03:00.000Z       CONDUCTOR_DONE    S[300]           -         reason=completed
2026-04-16T10:02:00.000Z       SESSION_STARTED   S[200]           2         source=resume task_run=task-217-xxx
2026-04-16T10:01:00.000Z       SESSION_ENDED     S[100]           1         reason=completed
```

plan.md の fixture 例では `AGENT_DONE/pid=3/source=conductor` が使われていたが、QueueMessage discriminated union に `AGENT_DONE` は存在せず（`CONDUCTOR_DONE` が正）また `SessionStartedMessage.source` は `"startup" | "resume" | "clear" | "compact"` に限定されているため、schema に忠実な値（`CONDUCTOR_DONE` と `source=resume`）で代用した。表の構造・カラム順・整形仕様は plan.md どおり。

### 受け入れ基準 6 — `trace-hooks --type SESSION_STARTED`

```
$ PROJECT_ROOT=/tmp/cmux-team-t217-test bun skills/cmux-team/manager/main.ts trace-hooks --type SESSION_STARTED
TIMESTAMP                      TYPE              SURFACE          PID       DETAIL
2026-04-16T10:02:00.000Z       SESSION_STARTED   S[200]           2         source=resume task_run=task-217-xxx
2026-04-16T10:00:00.000Z       SESSION_STARTED   S[100]           1         source=startup
```

### 受け入れ基準 7 — `trace-hooks --json --limit 1`

```
$ PROJECT_ROOT=/tmp/cmux-team-t217-test bun skills/cmux-team/manager/main.ts trace-hooks --json --limit 1
[
  {
    "id": 4,
    "timestamp": "2026-04-16T10:03:00.000Z",
    "type": "CONDUCTOR_DONE",
    "surface": "surface:300",
    "pid": null,
    "reason": "completed",
    "source": null,
    "question": null,
    "task_run_id": null,
    "payload_json": "{\"type\":\"CONDUCTOR_DONE\",\"surface\":\"surface:300\",\"success\":true,\"reason\":\"completed\",\"timestamp\":\"2026-04-16T10:03:00.000Z\"}"
  }
]
```

### 追加確認項目

#### 受け入れ基準 3 — ヘルプ表示

- `bun main.ts trace-hooks --help`（ja ロケール、デフォルト）: `help_trace_hooks` ja 版が表示されることを確認
- `CMUX_TEAM_LANG=en LANG=C LC_ALL=C LC_MESSAGES=C bun main.ts trace-hooks --help`: `help_trace_hooks` en 版が表示されることを確認

#### 受け入れ基準 4 — `help_main` 追記

```
$ bun main.ts --help | rg trace-hooks
  cmux-team trace-hooks                        hook シグナル履歴を表示

$ CMUX_TEAM_LANG=en LANG=C LC_ALL=C LC_MESSAGES=C bun main.ts --help | rg trace-hooks
  cmux-team trace-hooks                        display hook signal history
```

#### 受け入れ基準 8 — surface 正規化

`--surface 100`, `--surface surface:100`, `--surface 'C[100]'` の 3 形式すべてで同じ 2 行（`S[100]` の SESSION_STARTED と SESSION_ENDED）が返ることを確認。

#### 受け入れ基準 9 — 0 件時

```
$ trace-hooks --type NONEXISTENT
No hook signals found.

$ trace-hooks --type NONEXISTENT --json
[]
```

#### 受け入れ基準 10 — 不正 --limit

```
$ trace-hooks --limit abc
Error: --limit must be a positive number (got: abc)
(exit 1)

$ trace-hooks --limit 0
Error: --limit must be a positive number (got: 0)
(exit 1)
```

## 実装上の注意点

### surface 正規化の正規表現

plan.md の `^[CAMUS]?\[?(\d+)\]?$` は `C[665`（閉じ括弧なし）も通してしまうため、以下のように 2 本立てにした:

```ts
const m = raw.match(/^[CAMUS]?\[(\d+)\]$/) ?? raw.match(/^(\d+)$/);
```

これで `C[665]` / `A[719]` / `665` / `surface:665` は正しく正規化され、`C[665`（括弧閉じ忘れ）は原文のまま返って DB ミスマッチで 0 件になる。

### テスト fixture の型キャスト

plan.md のテスト fixture は `type: "AGENT_DONE" / source: "conductor"` など schema の discriminated union に無い値を使っていたため、schema に存在する類似値（`CONDUCTOR_DONE` / `source: "resume"`）に差し替えつつ、`as unknown as QueueMessage` でキャストした。`insertHookSignal` は内部で `Record<string, unknown>` に loose-type するため、テストからは型を緩めて呼べる。

### `noUncheckedIndexedAccess` 対応

tsconfig で `noUncheckedIndexedAccess: true` のため、テスト内の `rows[0].type` アクセスは `Object is possibly undefined` エラーになる。長さを `expect` で確認した直後に `rows[0]!` で non-null 断定してローカル変数に束縛する書き方で対応した。

## 完了判定

- [x] plan.md 5 章の受け入れ基準 1-10 全て確認
- [x] `bun test`: 368 pass / 0 fail
- [x] `bunx tsc --noEmit`: エラー 0 件
- [x] worktree の外には書き込んでいない（impl-report.md 出力のみ）
- [x] commit / git add はしていない
