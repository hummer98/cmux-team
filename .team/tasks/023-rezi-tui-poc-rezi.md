---
id: 023
title: Rezi TUI PoC: ダッシュボードを Rezi フレームワークで書き直す
priority: high
created_at: 2026-03-29T13:03:03.325Z
---

## タスク
## 目的
現在の Ink ベースの dashboard.tsx を Rezi TUI フレームワーク（https://rezitui.dev/docs）で書き直す PoC。
マウス対応（クリック・スクロール）が主な動機。

## スコープ
- `skills/cmux-team/manager/dashboard.tsx` の Rezi 版を `skills/cmux-team/manager/dashboard-rezi.tsx` として新規作成
- 既存の dashboard.tsx は変更しない（PoC なので並行して残す）
- テストは後回しでOK

## 現状の dashboard.tsx の構成（514行）
- Header: ステータス・PID・ポーリング間隔・Conductor数・タスク数
- Master セクション: Master プロセス状態
- Conductors セクション: Conductor 一覧（ツリー表示、Agent 含む）
- Tasks セクション: タスク一覧（status カラー表示）
- 下部タブ: Journal / Log タブ（2000ms 自動更新）
- キーボード操作: 1/2/Tab でタブ切替、r でリロード、q で終了

## Rezi で追加したいマウス操作
- タブのクリック切替
- タスク一覧のスクロール
- ログのスクロール

## 技術要件
- Rezi TUI フレームワークを使用（npm install rezi）
- TypeScript
- Bun で動作すること
- 既存の startDashboard() と同じインターフェース（state getter + callbacks）で呼べること
- stringWidth による日本語幅計算は維持

## 参考
- 現在の実装: skills/cmux-team/manager/dashboard.tsx
- Rezi ドキュメント: https://rezitui.dev/docs
- main.ts の startDashboard 呼び出し部分（L191-212）
