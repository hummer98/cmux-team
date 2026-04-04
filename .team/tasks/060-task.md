---
id: 060
title: ロギングポリシー策定と全般的なログ改善
priority: high
created_at: 2026-04-03T21:18:13.043Z
---

## タスク
## 概要

daemon 全般でロギングが不十分。障害発生時に原因を推測するしかない状態。

## やること

### 1. ロギングポリシーの策定

全般的なログの方針を見直し、明確なポリシーを策定する。

検討すべき観点:
- 何をログに残すべきか（成功/失敗/判断分岐/外部コマンド結果）
- catch で例外を握りつぶさないルール
- 外部コマンド（cmux tree, cmux send 等）の実行結果ログ
- 判断分岐のログ（なぜその分岐に入ったか）
- ログレベルの方針

### 2. CLAUDE.md にロギングポリシーを記述

策定したポリシーを CLAUDE.md に簡潔に追記する。今後の開発で参照できるようにする。

### 3. 既存コードの全般的なログ改善

ポリシーに従い、以下のファイルを中心に修正:
- `manager/cmux.ts` — validateSurface, tree, send 等の外部コマンド呼び出し
- `manager/conductor.ts` — checkConductorStatus の判定根拠
- `manager/daemon.ts` — processQueue, initializeLayout, monitorConductors
- `manager/template.ts` — プロンプト生成
- `manager/main.ts` — CLI サブコマンドの実行
- その他 catch {} で握りつぶしている箇所すべて

### 注意

- ログが冗長になりすぎないこと。必要十分な情報を残す
- 正常系のログは最小限、異常系・判断分岐は詳細に
- パフォーマンスに影響しないこと（高頻度ループ内の過剰ログを避ける）
