---
id: 098
title: create-task --help に --run-after-all オプションを追加
priority: medium
created_at: 2026-04-06T19:48:42.651Z
---

## タスク
## バグ概要

`cmux-team create-task --help` の出力に `--run-after-all` オプションが記載されていない。
実装は済んでいる（main.ts:1198 付近）がヘルプテキストが未更新。

## 修正箇所

- skills/cmux-team/manager/main.ts の create-task ヘルプ出力部分
- Options セクションに `--run-after-all` の説明を追加
- Examples セクションにも使用例を追加（例: リリースタスク）

## 参考

T057 で設計・実装された機能。全通常タスク完了後に実行されるフラグ。
