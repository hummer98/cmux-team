---
id: 311
title: cmux-team status に 5h/7d Rate Limit セクションを追加
priority: medium
created_by: surface:969
created_at: 2026-04-24T09:21:21.821Z
---

## タスク
## 目的

`cmux-team status` 出力に 5h / 7d 使用量・最終更新日時・解放予定時刻を表示する。現状はログ tail のみで、rate limit 状況が見えない。

## データソース

`.team/rate-limit.json`（既存、daemon が維持）。主なフィールド:

- `unified5hUtilization` / `unified7dUtilization`（0.0-1.0）
- `unified5hReset` / `unified7dReset`（unix 秒の**文字列**、または ISO8601。`rate-limit-display.ts:117-120` のパース処理を参考に）
- `updatedAt`（ISO8601）
- `unifiedStatus`（`allowed` / `rate_limited` / `unknown` など）

## 変更対象

`skills/cmux-team/manager/main.ts` の `cmdStatus()`（L1305-1384）に、Tasks セクションと Log tail セクションの間に新セクション `─ Rate Limit ─` を追加する。

## 出力フォーマット（目安）

```
─ Rate Limit ────────────────────────────────────────────
  5h: 55% █████░░░░░  reset in 1h23m  (2026-04-24 19:00)
  7d: 38% ███░░░░░░░  reset in 22h    (2026-04-25 17:00)
  status: allowed  (updated 10s ago)
```

### フォーマット詳細

- **使用率バー**: 幅 10、`█` filled / `░` empty。`rate-limit-display.ts` の `buildUtilizationBar` の流儀を参考に
- **色**: CLI なので ANSI color は使わず、`rate_limited` のときは status 行に `⚠` を付ける程度でよい（ログ tail と同じく plain text を基本に）
- **reset 時刻**: `reset in 1h23m` のような相対と、絶対時刻（ローカルタイムゾーン、`toLocaleString` など）を併記
- **updatedAt**: `updated Ns ago` の相対表示。ただし stale（例: 60s 超過）なら `(stale, updated 5m ago)` のように警告
- **rate-limit.json 不在**: `  (no rate limit data — proxy not running?)` と表示してセクションは継続（fail-fast ではない）

## 実装ヒント

- `rate-limit-display.ts` の reset パース（L117-120: unix 秒文字列 / ISO 両対応）は共通化してもよいが、まずは単独で書いてよい（dashboard.tsx 側は rgb 依存で CLI 側は plain text なので責務が違う）
- `formatDurationShort`（`dashboard-metrics.ts:150-162`）の流儀（60s / 1m30s / 1h5m / 1d4h）を参考に
- stale 判定のしきい値は `rate-limit-persistence.ts` の `isStale5h` / `isStale7d` を再利用できるか確認

## 受け入れ条件

- `cmux-team status` 実行時に 5h / 7d の使用率・バー・リセット時刻・updatedAt が表示される
- `.team/rate-limit.json` が無い / 壊れている場合でも他セクションの表示は正常に続く
- `bun test` / typecheck 通過
- 既存の Log tail セクションより**前**に表示する（操作感として上部に重要情報を置く）
