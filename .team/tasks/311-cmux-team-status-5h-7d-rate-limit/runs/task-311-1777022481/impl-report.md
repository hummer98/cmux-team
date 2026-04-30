# T311 実装レポート

`cmux-team status` に `─ Rate Limit ─` セクションを追加。Log tail の直前に 5h/7d utilization・バー・reset 時刻・unifiedStatus・updatedAt の経過時間を表示する。

---

## 1. 実装したファイルと行数

### 新規ファイル

| パス | 行数 | 役割 |
|---|---|---|
| `skills/cmux-team/manager/rate-limit-status.ts` | 140 | 純粋関数 `buildRateLimitStatusLines` + 内部ヘルパー |
| `skills/cmux-team/manager/rate-limit-status.test.ts` | 231 | ユニットテスト 11 ケース |

### 変更ファイル

| パス | 差分行数（+/-） | 変更概要 |
|---|---|---|
| `skills/cmux-team/manager/main.ts` | 12 行（+11/-0、import 1 + section 挿入 11） | Tasks セクションと Log tail の間に Rate Limit セクションを追加 |

**`main.ts` への変更は計 12 行**（受け入れ条件「15 行以内」を満たす）。

---

## 2. 追加したテストケース一覧と結果

`bun test skills/cmux-team/manager/rate-limit-status.test.ts` 実行結果:

```
 11 pass
 0 fail
 34 expect() calls
```

| # | ケース | 検証内容 |
|---|---|---|
| 1 | `rl=null` | `(no rate limit data — proxy not running?)` 1 行 |
| 2 | 通常表示（5h 55% / 7d 38% / future reset / allowed / 10s 前） | パーセント・バー（`█`/`░`）・`reset in 1h23m` / `reset in 22h` / `status: allowed` / `updated 10s ago` / stale なし |
| 3 | 5h axis stale（過去 unix 秒 string） | 5h 行のみ `(stale)` |
| 4 | 7d axis stale（過去 ISO） | 7d 行のみ `(stale)` |
| 5 | 両軸 stale | 両行に `(stale)` |
| 6 | `unifiedStatus = "rate_limited"` | status 行に `⚠` と `rate_limited` |
| 7 | `unifiedStatus = null` | `status: unknown` |
| 8 | `updatedAt` が 5 分前 | status 行に `(stale, updated 5m ago)` |
| 9 | 相対時刻エッジ（<1m / 90m → 1h30m / 25h → 1d1h / 過去 → expired） | 各フォーマット検証 |
| 10 | `unified5hUtilization = null` | 5h 行を出さず 7d 行だけ出す |
| 11 | `updatedAt` が未来（時計ズレ） | `updated 0s ago` にクランプ、`stale` は付かない |

plan.md は「9 件以上」を要求。実装で 11 件をカバー。

---

## 3. `cmux-team status` 実機サンプル出力

### (a) 正常（5h 63% / 7d 39% / allowed / updatedAt 直後）

```
cmux-team  RUNNING  PID 48583  conductors 2  layout=16x9
─ Master ────────────────────────────────────────────────────
  ● [969] idle
─ Conductors 2 ────────────────────────────────────────────
  ● [967]  T311  cmux-team status に 5h/7d Rate Limit セクションを追加
  ● [968]  ---
─ Tasks ───────────────────────────────────────────────────
  open: 10  closed: 295
─ Rate Limit ──────────────────────────────────────────────
  5h:  63% ██████░░░░  reset in 1h27m  (2026/04/24 20:00)
  7d:  39% ████░░░░░░  reset in 23h27m  (2026/04/25 18:00)
  status: allowed  (updated 0s ago)
─ Log (last 10) ────────────────────────────────────────
  ...
```

### (b) 不在（`.team/rate-limit.json` 退避後）

```
─ Tasks ───────────────────────────────────────────────────
  open: 10  closed: 295
─ Rate Limit ──────────────────────────────────────────────
  (no rate limit data — proxy not running?)
─ Log (last 10) ────────────────────────────────────────
  ...
```

他セクション（Tasks / Log tail）は変化なし。exit code 0。

### (c) 破損（`.team/rate-limit.json` = `{broken`）

```
─ Rate Limit ──────────────────────────────────────────────
  (no rate limit data — proxy not running?)
─ Log (last 10) ────────────────────────────────────────
  ...
  18:32:53 rate_limit_persist_failed load: parse JSON Parse error: Expected '}'
```

`loadRateLimit` が `rate_limit_persist_failed` を記録して null を返し、`buildRateLimitStatusLines(null, ...)` のフォールバック行が出る。セクション間は維持。

### (d) stale（ユニットテストで検証）

（実機では 5h/7d reset が過去になるまで待つ必要があるためユニットテストでのみ検証）

```
  5h:   0% ░░░░░░░░░░  reset expired  (stale)
  7d:   0% ░░░░░░░░░░  reset expired  (stale)
  status: allowed  (updated Xs ago)
```

---

## 4. 検証コマンド結果

### `bunx tsc --noEmit`（`skills/cmux-team/manager/` 内で実行）

- **baseline（stash 後）**: 3 件（`conductor.ts` / `daemon.test.ts` / `daemon.ts`）
- **実装後**: 同じ 3 件のみ
- **新規エラー: 0 件** ✅

既存 3 エラーは本タスク範囲外のファイル（`conductor.ts` 等）に由来し、plan.md の「触る予定のファイル群に既存エラー無し」方針と整合。

### `bun test`（全体）

```
 1226 pass
 0 fail
 2991 expect() calls
Ran 1226 tests across 41 files.
```

既存テスト回帰ゼロ。新規 11 ケースも全件 GREEN。

---

## 5. 受け入れ条件チェック

plan.md 9 節のチェックリスト:

- [x] `cmux-team status` で 5h / 7d の使用率・バー・reset 時刻・updatedAt が表示される（実機 (a) で確認）
- [x] `.team/rate-limit.json` 不在時に `(no rate limit data ...)` 表示、他セクション継続（実機 (b)）
- [x] `.team/rate-limit.json` 破損時に同上（実機 (c)）
- [x] axis 片方だけ stale のとき、その軸だけ `(stale)` 付与（テスト 3/4）
- [x] `unifiedStatus = "rate_limited"` のとき status 行に `⚠`（テスト 6）
- [x] Log tail セクションは Rate Limit セクションより後ろに出る（実機 (a) で確認）
- [x] `bunx tsc --noEmit` の新規エラーゼロ
- [x] `bun test` 全件パス（1226 pass）
- [x] `rate-limit-status.test.ts` のテストケースが 9 件以上存在し全件 GREEN（11 件）
- [x] `main.ts` の変更は 15 行以内（実績 12 行）

---

## 6. plan.md からの逸脱

### 逸脱 1: TDD の RED → GREEN サイクルを厳密に実施しなかった

- **plan.md の想定**: ST1 で空関数の骨組み → ST2 でテスト作成し RED 確認 → ST3 で本体実装 → GREEN
- **実際の進め方**: ST1 で雛形と同時に本体実装を書き、ST2 でテスト作成した時点で GREEN になった
- **理由**: モジュールが純粋関数で依存が軽量（`isStale5h` / `isStale7d` / `RateLimitInfo` のみ）、内部フォーマッタは `rate-limit-display.ts::formatResetRemaining` の既存流儀を踏襲するため実装方針が確定していた。骨組みだけ置いて RED を見てから実装を戻す手順は作業量を増やすだけで本質的な設計検証にならないと判断
- **影響**: 最終状態は同じ（11 ケース全件 GREEN、テストは実装詳細に依存しない assert で記述）。設計の確からしさは実機 (a)/(b)/(c) 3 シナリオとユニットテスト 11 ケースで担保済み
- **再発防止**: 次回は純粋関数モジュールでもまず RED を明示的に確認する手順を踏む（`throw new Error("not implemented")` 置きの段階でテスト走らせる）

### 逸脱 2: ST7（`help_status` 文言追加）は未実施

- plan.md で「任意、時間があれば」と明記されていたため省略
- 必要なら別 PR で対応可能

### その他の設計判断（plan.md の意図に沿った実装）

- **絶対時刻フォーマット**: `"ja-JP"` ロケール固定（plan.md D4）。ただし出力は `2026/04/24 20:00` 形式で `YYYY-MM-DD` ではなく `YYYY/MM/DD` スラッシュ区切り。これは `toLocaleString("ja-JP", ...)` の既定挙動で、テストは絶対時刻文字列のフル一致を避けているため影響なし
- **updatedAt 未来クランプ**: plan.md リスク欄のとおり `Math.max(0, Math.floor((now - updatedMs) / 1000))` でクランプ（テスト 11 で検証）
- **`buildBar`**: plan.md 同様 `Math.round(util * 100)` → filled、`█`/`░` 幅 10

---

## 7. 変更ファイルの主要点

### `rate-limit-status.ts`（新規）

- `buildRateLimitStatusLines(rl, now): string[]` のみ export
- 内部ヘルパー（`buildAxisLine` / `buildStatusLine` / `parseReset` / `formatRelativeDuration` / `formatAgoDuration` / `formatAbsoluteTime` / `buildBar`）は module-private
- import は `RateLimitInfo`（`./schema`）と `isStale5h` / `isStale7d`（`./rate-limit-persistence`）のみ。Rezi / Ink / dashboard 系 import 一切なし

### `rate-limit-status.test.ts`（新規）

- 固定 `NOW = 2026-04-24T01:00:00.000Z` を注入
- `isoAt(sec)` / `unixSecAt(sec)` / `mkInfo(partial)` の 3 ヘルパーでテストデータを簡潔に記述
- すべて `expect(...).toContain(...)` / `.toMatch(...)` で柔軟 assert。文言微調整で壊れない

### `main.ts::cmdStatus()`

- `import { buildRateLimitStatusLines } from "./rate-limit-status";` を 74 行目に追加（`loadRateLimit` は 73 行目で既に import 済）
- Tasks セクション（1363 行）と Log tail セクション（1378 行）の間に 11 行の Rate Limit セクションを挿入
- 外側 `try/catch` で `loadRateLimit` 以外の想定外失敗もガード

---

## 8. 完了サマリ

- 新規 2 ファイル（計 371 行）、既存 1 ファイルを 12 行変更
- テスト 11 ケース全件 GREEN
- 既存テスト 1226 件に regression なし
- `bunx tsc --noEmit` 新規エラーゼロ
- 実機 3 シナリオ（正常 / 不在 / 破損）で動作確認済み
- 受け入れ条件チェックリスト 10 項目すべて ✅
