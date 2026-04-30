# T305 実装サマリー

- task_id: 305
- role: Implementer
- run_id: task-305-1776974397
- implemented: 2026-04-24
- plan: `plan.md`（v2 / 7 Decision Log + 9 サブタスク）
- design-review-v2: Approved（Minor M6〜M8 は plan.md に記載された補足方針で自然対応）

## 概要

`/v1/messages` のレスポンスから usage / model / stop_reason / rate limit を抽出し、
1 リクエスト 1 レコードで新テーブル `api_usage` に記録する機構を追加した。

- 非 streaming: `arrayBuffer()` 取得後に JSON parse → INSERT
- streaming (SSE): `tee()` した logStream を行単位で parse し、関心イベント 4 種
  （`message_start` / `message_delta` / `message_stop` / `error`）のみ JSON.parse
- `content_block_delta` 等は parse しないため、性能は従来のバイト数計測 + 軽量 `\n` split の増分のみ
- 既存 `api-trace.jsonl` と `state.rateLimit` 更新は**完全温存**（並存方式）

## 変更ファイル一覧

| ファイル | 変更概要 |
|---|---|
| `skills/cmux-team/manager/trace-store.ts` | `api_usage` テーブル schema 追加（SCHEMA 内）、`ApiUsageRecord` 型 export、`insertApiUsage` / `getApiUsage` / `ensureApiUsageColumns` 実装。`initDB` 末尾で `ensureApiUsageColumns` を呼ぶ |
| `skills/cmux-team/manager/proxy.ts` | `Database` 型 import、`opts.db?: Database` を追加、`extractRateLimitForApiUsage` / `safeInsertApiUsage` ヘルパを追加。非 streaming 経路で `/v1/messages` 完全一致時に body parse → INSERT。streaming 経路は `drainAndLog` を `drainAndRecord` へ改名し、SSE パーサ（行バッファ + event type フィルタ）を内蔵。終端で 1 回 INSERT |
| `skills/cmux-team/manager/main.ts` | `cmdStart` 内の新規 proxy 起動 else ブランチで `initDB(PROJECT_ROOT)` を呼び `startProxy(..., { db: traceDb })` に渡す。既存 proxy 再利用分岐では DB を開かない（別プロセスの proxy が書き込む） |
| `skills/cmux-team/manager/trace-store.test.ts` | `describe("trace-store: api_usage (T305)")` を追加（新規 DB の列検証、往復テスト、最小構成 INSERT、role/error フィルタ、旧 DB migration 冪等性） |
| `skills/cmux-team/manager/proxy.test.ts` | `describe("api_usage (T305)")` を追加（非 streaming usage 抽出、SSE 集約、chunk 分断、429、502、count_tokens 除外、JSONL 並存、db 未指定 skip の 8 ケース） |
| `CLAUDE.md` | `運用上の注意（hook_signals GC）` の直下に `運用上の注意（api_usage GC — T305）` 節を追加（手動 DELETE 例示） |

## サブタスク完了状況

### ST1. `api_usage` テーブル schema と migration 追加 ✅
- `SCHEMA` 定数に CREATE TABLE を追加（列 26 + id）。**index は `ensureApiUsageColumns` 内で作成**（旧 DB 互換のため SCHEMA 外に置く — hook_signals と同じ理由）
- `ApiUsageRecord` interface を export
- `insertApiUsage(db, record): number` / `getApiUsage(db, opts): ApiUsageRecord[]` 実装
- `ensureApiUsageColumns(db)` を実装し `initDB()` 末尾で呼ぶ
- 冪等性: 既存 DB で列欠損があれば ALTER TABLE ADD COLUMN、既に列があれば no-op

### ST2. `api_usage` 書き込みテスト ✅
- 往復テスト、最小構成（timestamp のみ）テスト、role/error フィルタ、旧 DB migration 冪等性の 5 テストを追加
- `bun test trace-store.test.ts` → 25 pass / 0 fail

### ST3. 非 streaming 経路 body parse ✅
- `url.pathname === "/v1/messages"`（完全一致） かつ `opts.db` 指定時のみ INSERT
- 成功時: ルートの `model` / `id` / `stop_reason` / `usage.*` を抽出
- エラー時: body JSON の `error.type` を優先、JSON parse 失敗は `http_<status>` / `parse_failed`
- `duration_ms = Date.now() - startTime`、`timestamp = new Date().toISOString()` を INSERT 直前で採番
- `safeInsertApiUsage` で try/catch（M8 対応）

### ST4. streaming SSE parse ✅
- `drainAndLog` を `drainAndRecord` に改名し、SSE パーサを内蔵
- `TextDecoder({ stream: true })` + 内部バッファ → `\n` split → 各行 `replace(/\r$/, "")` で `\r` 剥がし（M1 / M2）
- ストリーム終端で `decoder.decode()`（引数なし）を呼んで flush、残り不完全行は破棄（M3）
- 関心イベント（`message_start` / `message_delta` / `message_stop` / `error`）のみ JSON.parse
- `message_delta.usage.output_tokens` は累積値として毎回上書き（M4 仕様通り）
- reader error（streamAborted = true）で捕捉した場合は `error="stream_aborted"` で INSERT
- 終端で 1 回だけ `safeInsertApiUsage`

### ST5. rate limit ヘッダー列の反映 ✅
- `extractRateLimitForApiUsage(headers)` を追加し、4 系統 12 ヘッダー + `anthropic-request-id` を抽出
- 非 streaming / streaming 双方で利用（streaming は drainAndRecord に context 経由で渡す）
- 数値列は NaN を NULL に倒し、不在ヘッダーも NULL

### ST6. proxy テスト追加 ✅
- 非 streaming usage 抽出（`input_tokens=100, output_tokens=50, cache_*` / rate limit / role/surface）
- SSE 集約（`message_start` + 3 × content_block_delta + 2 × `message_delta` + `message_stop`、`output_tokens` 120 で上書き確認、request_id ヘッダー優先）
- chunk 3 バイト分割（行境界をまたぐケース）
- 429 で `error=rate_limit_error`
- 502 空 body で `error=http_502`
- `/v1/messages/count_tokens` は INSERT されない（完全一致判定 R3）
- JSONL と `api_usage` の並存
- `opts.db` 未指定で INSERT されない（既存テスト互換）
- `bun test proxy.test.ts` → 36 pass / 0 fail（既存 28 + 新規 8）

### ST7. main.ts cmdStart での DB ハンドル接続 ✅
- **新規 proxy 起動 else ブランチ内で `initDB(PROJECT_ROOT)` を呼ぶ**（M7 採用）
- 既存 proxy 再利用分岐は initDB を呼ばない（別プロセスの proxy が書き込む）
- D11 の shutdown 経路挙動は現行設計（proxyHandle.stop() を呼ばず process.exit(0) に任せる）と整合
  - shutdown に `traceDb.close()` は追加しない（M6 で確認した方針どおり）
  - WAL mode（trace-store.ts:115）により writer 多重でも DB 破損は起きない
  - process 終了時に OS が fd を閉じる

### ST8. CLAUDE.md 更新 ✅
- 既存の `運用上の注意（hook_signals GC）` の直下に `運用上の注意（api_usage GC — T305）` 節を追加
- 24h で数 MB/日の見込みと、手動 DELETE の SQL 例示

### ST9. 型検査・テスト最終確認 ✅
- `bunx tsc --noEmit`: **新規エラー 0 件**（既存 3 件は plan.md §6 の通り温存: conductor.ts:201, daemon.test.ts:3870, daemon.ts:1558）
- `bun test`: **1168 / 1168 pass**

## 検証結果

```
$ cd skills/cmux-team/manager
$ bunx tsc --noEmit
conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3870,9): error TS2322: Type '"new_session"' is not assignable to ...
daemon.ts(1558,22): error TS2352: Conversion of type 'string | undefined' to ...
(本タスクで導入した新規エラー 0 件)

$ bun test
 1168 pass
 0 fail
 2851 expect() calls
Ran 1168 tests across 38 files. [52.05s]
```

詳細は `tsc-result.log` / `test-result.log` を参照。

## Design Review Minor への対応

| 指摘 | 対応 |
|---|---|
| M6（shutdown 経路の記述曖昧） | shutdown に `traceDb.close()` を追加せず、process.exit(0) 任せ。plan.md の補足方針通り |
| M7（既存 proxy 再利用分岐の initDB タイミング） | `else` ブランチ内（新規 proxy 起動側）で initDB。再利用分岐では呼ばない（無駄な open/close を回避） |
| M8（insertApiUsage 例外ハンドリング） | `safeInsertApiUsage` ヘルパで try/catch、失敗時は `log("api_usage_insert_failed", ...)` で継続 |
| R7（性能確認の測定方法） | 構造的に `content_block_delta` を無視する実装（pendingEvent が null のまま）なので、計装ログで確認する必要はない。SSE 行 split の複雑度は O(response_bytes) で線形 |
| R8（WAL 整合性根拠） | D11 の方針は維持（shutdown で close しない）。WAL journal mode は commit 済み tx を crash-safe に保つため、daemon プロセス異常終了でも DB 破損は起きない |

## 未解決事項

なし。

## 補足

- `api_usage` テーブルの読み取り側 CLI（集計コマンド等）は T306 / T307 で追加予定（本タスクでは書き込みのみ）
- `service_tier` / `cache_creation.ephemeral_5m_input_tokens` / `cache_creation.ephemeral_1h_input_tokens` は plan.md §1 Out of scope に従い未対応。`ensureApiUsageColumns` の migration pattern で将来追加可能
- 既存 `api-trace.jsonl` の書き出しは一切変更していない（JSONL との並存を維持）
- dashboard の表示や TUI への `api_usage` 集約連携は本タスクのスコープ外
