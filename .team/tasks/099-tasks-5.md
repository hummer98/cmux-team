---
id: 099
title: Tasks スクロール領域を5行に戻す
priority: medium
created_at: 2026-04-06T20:00:23.679Z
---

## タスク
## 背景

T096 のスクロールバグ修正で Tasks 領域が広くなりすぎた。

## 修正内容

`dashboard.tsx` の Tasks セクションの表示行数を 5行 に固定する。

## 対象ファイル

- `skills/cmux-team/manager/dashboard.tsx`
