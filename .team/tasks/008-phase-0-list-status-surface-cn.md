---
id: 008
title: Phase 0: list-status の surface↔cN マッピング実験検証
priority: medium
created_at: 2026-03-29T06:42:32.638Z
---

## タスク
## 目的
cmux list-status の cN エントリと surface の対応関係を実験的に確認する。改修方針全体を左右するブロッカー。

## 検証項目
1. Agent を spawn した時、新しい cN エントリが出現するか
2. Agent が完了（idle）した時、対応する cN が Idle に変わるか
3. cN の番号は surface の作成順序に対応するか（安定性）
4. Agent タブを close した時、cN エントリは消えるか
5. cmux identify --surface で workspace を取得し、list-status から Agent 状態を特定できるか

## 方法
- workspace:8 の Conductor idle ペインで手動テスト
- または小さなテストスクリプトを作成

## 成果物
- 検証結果レポート（.team/output/ に配置）
- Phase 1 の方針決定（A案: cN 直接監視 / B案: 全体判定 + read-screen フォールバック）
