---
id: 282
title: Update通知バナーが null のとき空 text を返すのをやめる（空白行除去）
priority: low
created_by: surface:427
created_at: 2026-04-20T22:10:24.748Z
---

## タスク
## 問題

TUI ダッシュボードのヘッダー直下に、常時 1 行の空白行が残っている。

## 原因

`skills/cmux-team/manager/dashboard.tsx:1163-1179` の Update 通知バナー実装で、`daemon.updateAvailable` が null のときも `ui.text("", { dim: true })` で**空の text 要素**を返している。`ui.column({ gap: 0 }, [...])` 内に空 text 要素が含まれるため、1 行分のスペースが常に占有される。

最新版で稼働している間（= 大半の時間）はずっと空行だけが残る UX。

## 修正内容

`dashboard.tsx` で Update バナー要素を組み立てる IIFE をやめ、`updateAvailable` が非 null のときだけ ui 要素を配列に含めるように書き換える。具体的には配列 spread で条件付き挿入:

```tsx
...(daemon.updateAvailable ? [buildUpdateBanner(daemon)] : []),
```

などの形にして、null のときは何も挿入しないようにする。

## 対象ファイル

- `skills/cmux-team/manager/dashboard.tsx` （1163-1179 付近）

## 確認方法

1. 最新版で `cmux-team start` → ヘッダー (`─ cmux-team v4.1.0 ...`) の直下が空行を挟まず `─ Master ─` セクションに続くこと
2. `state.updateAvailable` を手動で設定したユニットテスト or デバッグで、バナーが正しく表示されること（既存の表示経路は維持）
3. `notify` / `task` 両モードで実機確認できるとなお良い（任意）

## 優先度

low — 機能影響なし、見た目の改善のみ。
