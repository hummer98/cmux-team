# T305 Summary: proxy で API usage + rate limit を抽出し api_usage テーブルに記録

- task_id: 305
- run_id: task-305-1776974397
- branch: task-305-1776974397/task
- status: Completed (GO 判定)
- date: 2026-04-24
- depends_on: T304

## ゴール達成状況

- 新規 SQLite テーブル `api_usage` を trace DB に追加: ✅
- proxy が Anthropic API レスポンスから usage + rate limit ヘッダーを抽出し全リクエスト INSERT: ✅
- task_id / role / surface / conductor_id をヘッダーから解決（不明は NULL で INSERT）: ✅
- 既存挙動（レスポンス転送、JSONL 記録、state.rateLimit 更新）は変更なし: ✅

## サブタスク完了状況

| ST | 内容 | 状態 |
|----|------|------|
| ST1 | `api_usage` schema + `ensureApiUsageColumns` migration + `insertApiUsage` / `getApiUsage` | ✅ |
| ST2 | trace-store.test.ts に 5 テスト追加（migration 冪等性含む） | ✅ |
| ST3 | 非 streaming 経路の body parse + INSERT + エラー時 `http_<status>` / `parse_failed` | ✅ |
| ST4 | SSE 行単位 parse + TextDecoder flush + `\r` trim + 不完全行破棄 + stream_aborted | ✅ |
| ST5 | 4 系統 rate limit ヘッダー + `anthropic-request-id` 抽出 | ✅ |
| ST6 | proxy.test.ts に 8 テスト追加 | ✅ |
| ST7 | main.ts:cmdStart else ブランチで initDB → startProxy({db}) 配線 | ✅ |
| ST8 | CLAUDE.md に api_usage GC 節追加 | ✅ |
| ST9 | tsc 新規エラー 0 / bun test 1168 pass | ✅ |

## 変更ファイル

| ファイル | 追加/変更 |
|---|---|
| `skills/cmux-team/manager/trace-store.ts` | +228 行（api_usage CRUD + migration） |
| `skills/cmux-team/manager/proxy.ts` | +329 行 -5 行（SSE パーサ / INSERT 経路 / ヘルパ） |
| `skills/cmux-team/manager/main.ts` | +9 行（cmdStart 配線） |
| `skills/cmux-team/manager/trace-store.test.ts` | +243 行（新規 5 テスト） |
| `skills/cmux-team/manager/proxy.test.ts` | +517 行（新規 8 テスト） |
| `CLAUDE.md` | +8 行（api_usage GC 運用注記） |

合計: 6 ファイル / 1329 insertions / 5 deletions

## テスト結果

- `bunx tsc --noEmit`: 既存 3 件のエラー（conductor.ts:201, daemon.test.ts:3870, daemon.ts:1558）のみ温存。**本タスクによる新規エラー 0 件**（plan.md §6 で事前宣言）
- `bun test`: **1168 pass / 0 fail**（2851 expect() calls, 38 files, 52.05s）
  - 新規テスト: trace-store 5 件 + proxy 8 件 = 13 件

## Design Review Minor 反映

- M6（shutdown 経路）: shutdown に `traceDb.close()` 追加しない。`process.exit(0)` に任せる現行設計を維持
- M7（initDB タイミング）: 新規 proxy 起動の `else` ブランチ内で initDB（再利用分岐は開かない）
- M8（insertApiUsage 例外ハンドリング）: `safeInsertApiUsage` で try/catch、失敗時は `log("api_usage_insert_failed", ...)` で継続

## Out of scope（維持）

- 集計・可視化（T306 / T307 で扱う）
- 既存 JSONL の廃止・置き換え（当面並存）
- `service_tier` / `cache_creation.ephemeral_*` 列（将来 `ensureApiUsageColumns` で追加可能）
- dashboard の表示や TUI 連携

## 納品

- ローカルマージ（`--ff-only main`）
- マージコミット: （後段で埋める）

## 関連ドキュメント

- plan.md
- design-review.md (v1 Changes Requested)
- design-review-v2.md (v2 Approved)
- implementation.md
- inspection.md
- tsc-result.log / test-result.log
