---
id: 012
title: Agent 状態判定を read-screen から list-status に移行
priority: medium
created_at: 2026-03-29T06:43:42.983Z
---

## タスク
## 背景
リサーチ (run-1774764648) により、cmux が Claude Code hooks を自動注入しており cmux list-status で Running/Idle/Needs input を正確に取得できることが判明。現在の read-screen + パターンマッチは誤判定リスクがあり置き換えが妥当。

## メリット
- 判定精度: 中（パターン依存）→ 最高（hooks ベース）
- 応答速度: ~50ms → ~5ms
- Needs input 検出: 不可 → 可能
- UI 変更耐性: 弱い → 強い

## 制約
- list-status は workspace 単位の API（--surface フラグなし）
- surface → cN のマッピングの安定性が未検証

## 作業フェーズ

### Phase 0: list-status の surface↔cN マッピング実験検証（ブロッカー）
- Agent spawn 時に新 cN エントリが出現するか
- Agent 完了時に対応 cN が Idle に変わるか
- cN 番号の割り当てルール（安定性）
- 結果次第で Phase 1 が A案/B案に分岐

### Phase 1: Conductor テンプレート（conductor.md）
- Agent 監視ループの完了判定を list-status ベースに置換
- A案: cN マッピングが安定 → spawn 時に cN 特定して個別監視
- B案: 不安定 → 全 cN の状態で判定 + read-screen フォールバック

### Phase 2: Manager テンプレート（manager.md）
- §3 Conductor 監視のフォールバック判定を list-status に変更（小変更）

### Phase 3: SKILL.md プロトコル記述更新（8箇所）
- 通信方式テーブル、Master 行動原則、Agent 監視、通信プロトコル等

### Phase 4: ドキュメント更新
- CLAUDE.md、docs/seeds/04-templates.md、requirements.md、README.md

### Phase 5: read-screen の役割再定義
- 状態判定から外し Trust 確認・画面内容取得・非 Claude プロセスに限定

## 変更しないもの
- spawn-conductor.sh / spawn-team.sh の Trust 承認（read-screen 維持）
- Agent テンプレート（Agent 自身は状態判定しない）

## 詳細プラン
.team/plan.md 参照
