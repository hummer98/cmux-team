---
id: 024
title: Rezi TUI PoC: ビルド・動作検証
priority: high
created_at: 2026-03-29T13:20:09.264Z
---

## タスク
## 目的
dashboard-rezi.tsx が実際にビルド・動作するか検証する。

## 手順
1. `cd skills/cmux-team/manager && bun add @rezi-ui/core @rezi-ui/node` でインストール
2. `bun build dashboard-rezi.tsx --no-bundle` で型チェック・ビルド確認
3. API が実在するか確認（ui.page, ui.panel, ui.tabs, ui.logsConsole, ui.status, ui.kbd, ui.statusBar, ui.header, createNodeApp）
4. 存在しない API があれば Rezi の実際の API に合わせて dashboard-rezi.tsx を修正
5. 可能なら main.ts を一時的に書き換えて実際に表示テスト（既存 dashboard.tsx への影響は禁止）

## 成果物
- dashboard-rezi.tsx が `bun run` で動作する状態
- 動かない場合: 何が足りないか・Rezi の実際の API との差分をレポート

## 注意
- 既存の dashboard.tsx は変更しない
- package.json の依存追加は OK
