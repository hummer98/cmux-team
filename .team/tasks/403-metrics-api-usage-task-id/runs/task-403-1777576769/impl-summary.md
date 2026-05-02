# T403 Implementation Summary

## 概要

`api_usage.task_id` 全件 NULL 問題を、research.md §4 のハイブリッド方式で修正した。

- **agent**: `generateAgentSettings` で `x-cmux-role` / `x-cmux-surface` / `x-cmux-task-id` を改行区切りで `ANTHROPIC_CUSTOM_HEADERS` に固定注入。
- **conductor**: `proxy.ts` で `role==="conductor"` かつ `x-cmux-task-id` 未指定時のみ `state.conductors[surface].taskId` を pure read で逆引き。
- **master**: 修正なし（task に紐付かないため task_id NULL のまま運用）。

## 変更ファイル

| ファイル | 行数差分 |
|---|---|
| `skills/cmux-team/manager/main.ts` | +18 / -4 (差分 +22 / -8 → 計 +14 net) |
| `skills/cmux-team/manager/main.test.ts` | +25 / -3 |
| `skills/cmux-team/manager/proxy.ts` | +14 / -2 |
| `skills/cmux-team/manager/proxy.test.ts` | +226 / 0 |

合計: 4 ファイル, +284 / -8 行

### 主要変更点

- `main.ts:2207-2225`: `generateAgentSettings(projectRoot, surface, taskId?)` に optional `taskId` 引数を追加。`ANTHROPIC_CUSTOM_HEADERS` を 3 行（taskId 指定時）/ 2 行（未指定時）の改行区切り文字列に変更。`taskId` 未指定時は `x-cmux-task-id` 行を含めない（壊れた値で `api_usage` を汚染しないため）。
- `main.ts:2876-2880`: `cmdSpawnAgent` 内の `generateAgentSettings(PROJECT_ROOT, surface)` を `generateAgentSettings(PROJECT_ROOT, surface, taskId)` に変更。`taskId` は同関数内で既に `team.json` から解決済み (line 2740 付近)。
- `proxy.ts:738-755`: `taskId` 解決ロジックを変更。`req.headers.get("x-cmux-task-id") || opts?.taskId` で取れない場合、`role === "conductor" && conductorSurface && opts?.getState` のときに限り `opts.getState().conductors.get(conductorSurface)?.taskId` を pure read で参照。state アクセス失敗時は taskId NULL のまま（既存挙動維持）。`role === "master"` のリクエストは引き当てない（master surface の誤マッチ防止）。

## 追加テストケース

### `main.test.ts` (`describe generateAgentSettings`)

1. `taskId 未指定時は x-cmux-role と x-cmux-surface のみを改行区切りで注入する（x-cmux-task-id 行なし）` — 既存テストを差し替え。`x-cmux-surface` が agent でも注入されるようになった点を検証し、`x-cmux-task-id` 行が含まれないことを assert。
2. `T403: taskId 指定時は x-cmux-role / x-cmux-surface / x-cmux-task-id の 3 行を改行区切りで注入する` — 新ケース。期待値 `"x-cmux-role: agent\nx-cmux-surface: surface:100\nx-cmux-task-id: T403"`。
3. `T403: taskId 指定時の ANTHROPIC_CUSTOM_HEADERS にカンマ区切り (T355 regression) が混入しない` — T355 regression guard。

### `proxy.test.ts` (`describe api_usage (T305)`)

1. `T403: role=conductor + x-cmux-task-id 未指定でも state.conductors から task_id を逆引きする` — 新挙動の本命テスト。fakeState に `conductors: Map([[surface:c1, { taskId: "T403", ... }]])` を仕込み、`x-cmux-role: conductor` / `x-cmux-surface: surface:c1` のみで `/v1/messages` を投げ、`api_usage.task_id === "T403"` を検証。
2. `T403: ヘッダ x-cmux-task-id がある場合は state を引かずヘッダ値を優先する` — 優先順位 guard。state には別 task が登録されていてもヘッダ値が勝ち、state 側の値が `api_usage` に漏れないこと。
3. `T403: role=master の場合は state.conductors を引かない（誤マッチ防止）` — master surface が偶然 conductor surface と同名でも逆引きしないこと、master 行が `task_id NULL` のまま記録されることを assert。

## 検証コマンドと実行結果

| コマンド | 結果 |
|---|---|
| `bun test --timeout 30000 main.test.ts` | **215 pass / 0 fail** (595 expect calls) |
| `bun test --timeout 30000 proxy.test.ts` | **60 pass / 0 fail** (236 expect calls) |
| `bun test --timeout 30000 main.test.ts proxy.test.ts` | **275 pass / 0 fail** (831 expect calls) |
| `bunx tsc --noEmit -p tsconfig.json` | **新規エラー 0 件** (exit 0, 0 行出力) |

CLAUDE.md の `bun test` 全体実行禁忌を厳守し、関連 2 ファイルのみで検証を行った。

## 設計判断

research.md §4.1〜§4.3 の方針に**完全準拠**。差分なし。

- `generateAgentSettings` のシグネチャ変更は optional 引数 `taskId?: string` のみで、既存呼び出し (テスト含む) の互換性を維持。
- `proxy.ts` の逆引きは `try/catch` で囲み、空 catch とせずコメントで意図を明示（`logger` への明示記録は research.md でも要求していないため省略。state アクセス失敗は実用上発生せず、発生しても fallback で taskId NULL となるだけで副作用なし）。
- `cmdSpawnAgent` 経路では `taskId` は `team.json` 経由で解決済みのため、`generateAgentSettings(..., surface, taskId)` への変更は呼び出し 1 箇所のみで完結。

## 残課題

なし。完了条件 1〜5 すべて満たした。

将来的な拡張余地（research.md §4.3 に既述、本タスクのスコープ外）:

- master が現在操作している task を識別したい場合、UserPromptSubmit hook などから最新 taskId を `team.json` に保存し、proxy で `role === "master"` のときのみそれを引く拡張。
- 既存 13,885 行の `task_id NULL` データ補正は不可能（再構築不能）。新規行から正常化される。
