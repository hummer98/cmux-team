---
id: 390
title: pool status / token list の per-handle 表示を effUtil（stale 救済反映後）に揃える
priority: medium
created_by: surface:141
created_at: 2026-04-30T06:52:16.557Z
---

## タスク
## 背景

`cmux-team pool status` / `cmux-team token list` の per-handle 行は **`usage_snapshots` の生値**（`util_5h` / `util_7d`）を表示している。一方、`selectToken` / `peekNextToken` / `admitCandidates` 等のピックアップ系は spec T373 の stale 救済を適用した **effUtil**（`reset_*_at` 経過済み軸を 0 にした値）で動作する。

このため、reset 通過済みかつ stale な token で表示と内部判定が乖離する:

| handle | snap (5h, 7d) | 表示 | 実際のピックアップ判定 (effUtil) |
|---|---|---|---|
| `@tayo` | (0.02, 0.91) | `5H:2% / 7D:91%` ← 古い | `(0.00, 0.00)` で score=0 (実機確認済) |
| `@kddi` | (0.02, 0.97) | `5H:2% / 7D:97%` | `(0.00, 0.97)` blocker（5h は reset 通過、7d 未到達） |

ユーザー体験: 「7d=91% に見えるのに spawn-agent で選ばれる」「@kddi が default なのに blocker」の挙動理由が表示から読み取れない。今回の調査（KDG-discord-listener / KDG-lab の pool 有効化検討時）で発覚。

## 方針

per-handle 行の `5H USE` / `7D USE` カラムを **effUtil（stale 救済反映後）** に切り替える。snap 生値も小さなインジケータで補助表示する。

## 変更内容

### 1. effUtil 計算ロジックの pure 関数化

`token-store.ts:947-962` に inline で書かれている stale 救済 + reset 反映ロジックを pure 関数として extract:

```ts
export function computeEffUtil(
  snap: UsageSnapshot | null,
  nowMs: number,
  staleThresholdMs: number = 30 * 60 * 1000,
): { effUtil5h: number; effUtil7d: number; isStale: boolean; reset5hPassed: boolean; reset7dPassed: boolean }
```

`admitCandidates` 内の 947-962 もこの関数に置き換え（DRY）。`pool-throttle.ts: countPoolTokens` 内の同等ロジック（pool-throttle.ts:147-152）も同じ関数を使う。

### 2. token-format.ts の per-handle 行で effUtil を表示

- カラム値を effUtil に変更
- カラムヘッダーは現状維持（`5H USE` / `7D USE`）。意味の説明は help / spec 側で行う
- snap 生値が effUtil と異なる token では行末に `(stale, reset 通過)` 等の小マーカーを付ける（実装は短い接尾辞 1 文字: `*` または `↻` 等で OK）

### 3. dashboard.tsx (Ink) のヘッダー next 候補表示

`pool 7d ██▇▅▅▆█  next: @kddi 5h:65%` の `5h:N%` 部分は spec 上 effUtil を使う前提（`peekNextToken.util_5h`）。すでに正しく動いているはずなので、本タスクではコード追加せず「正しく動いているか」テストケースで確認するだけ。

### 4. テスト

- `computeEffUtil` の単体テスト（reset passed / not passed / stale / not stale の 4×4 マトリクス）
- `formatTokenList` 系のテストに「reset 通過済み stale token は 0% 表示 + マーカー付き」のケースを追加
- 既存テストの破壊回帰がないか確認

### 5. spec / docs 反映

- `docs/spec/09-token-pool.md` の「## CLI コマンド」「### `cmux-team token list`」「## 7d Forecast ゲージ + next 候補」あたりに「per-handle 行は effUtil を表示する」と明記
- 関連ファイル一覧の token-format.ts の説明を更新

## 受け入れ基準

- [ ] `cmux-team pool status` で `@tayo` の 7d use が `0%` 表示になる（reset 通過済みの場合）
- [ ] `cmux-team pool status` で `@kddi` の 7d use が `97%` のまま（reset 未到達なので生値）
- [ ] `cmux-team token list` も同様
- [ ] reset 通過済み token に小マーカーが付く
- [ ] 単体テスト追加（computeEffUtil の挙動マトリクス）
- [ ] spec 09-token-pool.md に表示仕様を明記
- [ ] 既存テスト pass（特に admitCandidates / peekNextToken）

## スコープ外

- TUI dashboard.tsx のヘッダー行の挙動変更（既に effUtil を使っているはずで、確認のみ）
- snap 生値を `cmux-team token list --raw` 等で出すフラグ（必要ならフォローアップで）
- usage_snapshots の保持期間 / GC（別問題）

## 関連

- 発覚経緯: KDG-discord-listener / KDG-lab の pool 有効化検討中、@tayo の 7d=91% 表示と実際の挙動 (effUtil 0) の乖離をユーザーが指摘
- spec T373 (stale 救済): `docs/spec/09-token-pool.md` 「token 選択アルゴリズム」セクション
- 関連実装: `skills/cmux-team/manager/token-store.ts` (admitCandidates), `pool-throttle.ts` (countPoolTokens), `token-format.ts` (表示)
