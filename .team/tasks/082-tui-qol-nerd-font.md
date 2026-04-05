---
id: 082
title: TUI ダッシュボード QoL: カーソル改善 + Nerd Font アイコン化
priority: medium
created_at: 2026-04-05T02:46:39.721Z
---

## タスク
## 概要
T081（Nerd Font 導入）を前提とした TUI ダッシュボードの QoL アップデート。

## 要件

### 1. Tasks 列のカーソル表示改善
- 現状: 左端に `>` カーソルが常時表示
- 変更: Tasks セクションが非選択状態（フォーカスなし）のときはカーソル非表示
- Tasks セクションが選択（操作可能）状態のときはアンダーバー `_` でカーソル表示
- 対象: `dashboard.tsx` の Tasks セクション描画部分

### 2. Tasks のステータス表示を Nerd Font アイコンに
- 現状: `[running]` `[closed]` `[ready]` `[aborted]` `[blocked]` などテキスト表示
- 変更: Nerd Font アイコンで簡潔に表示（例）:
  - running → `` (nf-cod-play) または `` (nf-fa-spinner)
  - closed → `` (nf-fa-check) 
  - ready → `` (nf-cod-circle_outline) または `◆`
  - aborted → `` (nf-fa-times) または `` (nf-cod-error)
  - blocked → `` (nf-fa-lock)
  - draft → `` (nf-fa-pencil)
- 色は現状のステータス色をそのまま維持
- フォールバック: Nerd Font なし環境では現状の `[running]` 等テキスト表示

### 3. Journal のイベントアイコンを Nerd Font に
- 現状: `[+]` `[▶]` `[✓]` `[✕]` などの簡易アイコン
- 変更: Nerd Font でより直感的に:
  - タスク追加 `[+]` → `` (nf-fa-plus_circle) 等
  - タスク開始 `[▶]` → `` (nf-fa-play) 等
  - タスク完了 `[✓]` → `` (nf-fa-check_circle) 等
  - タスク中止 `[✕]` → `` (nf-fa-times_circle) 等
- **surface 表示 `[xxx]` を dim（暗い色）にする** — 予備的情報なので目立たせない
- フォールバック: 現状のアイコンを維持

## 対象ファイル
- `skills/cmux-team/manager/dashboard.tsx` — 全変更箇所

## 注意
- Nerd Font のコードポイントは実装時に nerdfonts.com/cheat-sheet で確認すること
- フォールバック判定方法は T081 の実装に合わせる
