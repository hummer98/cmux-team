---
id: 125
title: spawn-conductor から split を除去し現在の surface で起動する
priority: high
created_at: 2026-04-10T07:08:22.821Z
---

## タスク
## 背景

`cmux-team spawn-conductor` は常に `cmux.newSplit()` で新しいペインを作成してからConductorを起動する。しかし spawn の意味は「そのsurfaceでConductorを起動する」であり、split は不要。split が必要なら呼び出し側が行うべき。

## やること

`spawnSingleConductor()` を変更:
1. `cmux.newSplit()` を削除
2. 引数の surface で直接 Conductor を起動する
3. surface が未指定の場合は `CMUX_SURFACE` 環境変数または `cmux identify` で現在の surface を取得

## インターフェース変更

Before:
```
cmux-team spawn-conductor [--direction <right|down>] [--surface <parent>]
```
- `--surface`: 分割元の親ペイン
- `--direction`: 分割方向

After:
```
cmux-team spawn-conductor [--surface <target>]
```
- `--surface`: Conductorを起動するsurface（省略時は現在のsurface）
- `--direction` は不要になる

## 対象ファイル

- `skills/cmux-team/manager/conductor.ts` — `spawnSingleConductor()` の書き換え
- `skills/cmux-team/manager/main.ts` — `cmdSpawnConductor()` の引数変更

## 注意

- `createConductorPanes()`（start 時のレイアウト構築）は別関数なので影響なし
- daemon からの呼び出し箇所があれば確認すること
