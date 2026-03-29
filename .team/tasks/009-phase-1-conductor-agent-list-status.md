---
id: 009
title: Phase 1: Conductor テンプレート — Agent 監視ループを list-status に置換
priority: medium
created_at: 2026-03-29T06:42:43.871Z
---

## タスク
## 対象ファイル
- skills/cmux-team/templates/conductor.md

## 前提
Phase 0 の検証結果に依存。

## 変更内容
Agent 監視ループの完了判定を cmux list-status ベースに置き換える。

### A案 (cN マッピングが安定している場合)
- spawn 直後に list-status を取得し、新規 cN エントリを特定
- 30秒ポーリングで cN の状態を監視（Running → Idle で完了判定）
- Needs input 検出時のエラーリカバリも追加

### B案 (cN マッピングが不安定な場合)
- 全 cN エントリが非 Running になったら全 Agent 完了と判定
- 個別 Agent の状態は read-screen をフォールバックとして残す

## 追加改善
- Needs input 状態の検出と対処（現状は検出不可）
- サブタスク管理の例にある「cmux read-screen で ❯ 検出」の記述も更新
