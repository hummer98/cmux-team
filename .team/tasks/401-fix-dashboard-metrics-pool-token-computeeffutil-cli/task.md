---
id: 401
title: fix(dashboard): Metrics pool token に computeEffUtil を適用して CLI と一致させる
priority: high
created_by: surface:511
created_at: 2026-04-30T13:55:23.482Z
---

## タスク
## 背景

`cmux-team token list` (CLI) と Manager dashboard の Metrics ページで、同じ usage snapshot の解釈が乖離している。

| 経路 | 関数 | 挙動 |
|------|------|------|
| CLI | `formatPerHandleUtilCell` → `computeEffUtil` | stale (>30 分) かつ `reset_*_at` 通過済みの軸を 0% に上書き、reset 通過軸が 1 つでもあれば marker="*" |
| Metrics ページ | `buildPoolTokenRows` → 生 `snap.util_5h/7d` | reset 通過判定なし。stale でも生値のまま表示 |

ユーザーから "Metrics ページでリセット時間を過ぎている Pool Token が 0% になってないのはなぜ？" として報告された。

## 該当コード

`skills/cmux-team/manager/dashboard.tsx:2079-2091` (`buildPoolTokenRows`):

```tsx
const rows: PoolTokenRow[] = candidates.map((tok) => {
  const snap = getLatestUsageSnapshot(daemon.tokenDb!, tok.id);
  return {
    handle: tok.handle,
    util5h: snap?.util_5h ?? null,        // ← 生値
    reset5hIso: snap?.reset_5h_at ?? null,
    util7d: snap?.util_7d ?? null,        // ← 生値
    reset7dIso: snap?.reset_7d_at ?? null,
    hasSnapshot:
      snap !== null &&
      (snap.util_5h !== null || snap.util_7d !== null),
  };
});
```

参照する CLI 側の正しい実装は `skills/cmux-team/manager/token-format.ts:55-67` (`formatPerHandleUtilCell`) と `token-store.ts:983-1032` (`computeEffUtil`)。

## 修正方針（実装判断は agent に委ねる）

1. `buildPoolTokenRows` で `computeEffUtil(snap, now)` を呼び、`effUtil5h/effUtil7d` を `PoolTokenRow.util5h/util7d` に詰める
2. `PoolTokenRow` に reset 通過済み情報（`reset5hPassed` / `reset7dPassed` 等）を追加し、`dashboard-metrics.ts` の pool tokens セクションでマーカー ("*") を出すか検討
   - CLI と同様 `(* = reset 通過済みで実質クリア)` 凡例も Metrics ページに追加するかは UI 設計判断
3. `PoolTokenRow` の意味が「生 snapshot 値」から「effUtil（stale/reset 反映後）」に変わるので、関連テスト（`dashboard-metrics.test.tsx`、`dashboard-issues.test.tsx` 内の `metricsData` 初期値、`buildPoolTokenRows` の単体テストがあれば）の入力期待値を更新する
4. CLI と Metrics の両方で同じ値が出ることを最低 1 ケースで verify するテストを追加するのが望ましい

## 設計上の注意

- `computeEffUtil` は "3 箇所が共有する唯一の実装" として export されており（admit / throttle / 表示）、このバグは "Metrics ページが 4 つ目の独自実装になっていた" ことに相当する
- 修正後、Metrics ページも `computeEffUtil` を経由する 4 箇所目の consumer になる
- `reset_5h_at` / `reset_7d_at` が null・不正値のケースは `computeEffUtil` が既にハンドル済み（snap=null は hasSnapshot=false で空表示）

## 受け入れ条件

- `@kddi` のように `util_7d` が高いまま reset_7d_at を通過した token が、CLI と Metrics で同じ表示になる（stale 条件を満たせば 0%、満たさなければ snapshot の生値、ただし表示元は `computeEffUtil`）
- 既存テストが pass し、新規 verify ケースが追加されている
- 凡例追加の要否は agent の判断でよいが、追加した場合は i18n キー（`metrics_*`）を一貫させる

