---
id: 067
title: TUIのTasksセクションにカーソルとスクロールを追加
priority: medium
created_at: 2026-04-04T01:12:25.012Z
---

## タスク
## 概要

TUI の Tasks セクションをスクロール可能にし、カーソルで選択できるようにする。

## やること

### AppState に追加
- taskCursor: number（選択中のタスクインデックス）

### Tasks セクション表示
- 固定表示行数を設定（例: 5行）
- タスク数が多い場合はカーソル位置に応じてスクロール
- カーソル行にマーカー（アンダーラインや > 等）を表示

### キーバインド
- 上下カーソルキーで taskCursor を移動
- タスク数の範囲内でクランプ

### 参考実装
- Log タブのスクロール: logScrollOffset + slice で表示範囲制御
- Artifacts タブのカーソル: artifactCursor + j/k キー

同じパターンを Tasks に適用する。

## 対象ファイル
- `manager/dashboard.tsx`
