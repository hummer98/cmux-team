---
id: 051
title: TUIログタブ: ローカルTZ表示 + スクロール対応
priority: medium
created_at: 2026-04-03T01:25:53.775Z
---

## タスク
## 概要

TUIのログタブに2つの改善を行う。

## 1. タイムゾーン対応

### 現状
- `logger.ts` で `new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')` を使用しており、常にUTC表記
- 例: `[2026-04-03T01:21:33Z]`（JSTだと10:21）

### 要件
- ユーザーのローカルタイムゾーンを尊重して表示する
- ログファイル自体はUTCのままでもよいが、TUI表示時にローカルTZに変換する
- または、ログ書き込み時点でローカルTZのオフセット付きISO 8601（例: `2026-04-03T10:21:33+09:00`）にする

### 対象ファイル
- `skills/cmux-team/manager/logger.ts` — タイムスタンプ生成
- `skills/cmux-team/manager/dashboard.tsx` — `buildLogRows()` での表示変換（ログファイルがUTC保持の場合）

## 2. スクロール対応

### 現状
- 最新200行を `.slice(-200)` で表示
- 上下キー・Page Up/Down などのスクロール操作なし
- Rezi UI の `computeAutoScrollPosition` は未使用

### 要件
- 上下キー（j/k または矢印キー）でログを1行ずつスクロール
- 通常時は最新行にauto-scroll（最下部に追従）
- スクロール操作で上に移動したらauto-scrollを一時停止
- 最下部に戻ったらauto-scroll再開

### 対象ファイル
- `skills/cmux-team/manager/dashboard.tsx` — キーバインド追加、スクロール位置管理、表示ロジック改修

### 参考
- Artifacts タブの j/k キー実装が参考になる（dashboard.tsx line 707-715）
- Rezi UI に `computeAutoScrollPosition` ヘルパーあり
