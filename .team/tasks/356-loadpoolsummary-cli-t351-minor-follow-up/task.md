---
id: 356
title: loadPoolSummary 失敗時にログ/CLI メッセージを残す（T351 minor follow-up）
priority: medium
created_by: surface:122
created_at: 2026-04-26T22:04:17.326Z
---

## タスク
## 背景

T351 で `cmdStatus` の旧 in-line ロジックを `loadPoolSummary` (`pool-summary.ts`) に集約した際、旧コード (旧 main.ts:1485-1487) の `console.log("(token pool read failed: ${e?.message ?? e})")` が消失し、現状は `pool-summary.ts:125-129` の catch で silent に `null` を返している。

daemon 側の `refreshPoolSnapshot` は `log("error", ...)` で manager.log に残るが、CLI (`cmux-team status`) 側では tokens.db 破損や読み取り失敗を区別できない。

## やること

- `loadPoolSummary` の catch 節に optional callback `onError?: (e: Error) => void` を生やすか、throw 切替で CLI 側に握らせる
- CLI 側 `cmdStatus` で旧挙動相当の `console.log` を復元
- 動作 / 単体テスト (case: tokens.db 破損 → CLI に warning メッセージ)

## 関連

- T351 inspection.md §指摘事項 1
- 旧 `main.ts:1485-1487` (T351 commit 935b2a3 で削除)
- `skills/cmux-team/manager/pool-summary.ts:125-129`
