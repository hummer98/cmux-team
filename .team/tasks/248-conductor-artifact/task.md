---
id: 248
title: Conductor 状態遷移の現状調査と Artifact 化
priority: medium
created_by: surface:47
created_at: 2026-04-17T17:14:52.122Z
---

## タスク
## 背景

Conductor の状態管理が複数の signal（hook push / PID watcher / timeout 類）の複合で決まっており、暗黙的な状態遷移になっている。結果として false-positive な disconnected 判定が発生している（T244 abort 事例など）。

堅牢化を議論する前提として、**現状の状態遷移を網羅的に文書化した Artifact** が必要。この Artifact を土台に設計議論 → `docs/spec/` への仕様昇格 → 堅牢化実装 の順で進める。

## 調査目的

現状の Conductor 状態機械を正確かつ網羅的に文書化する。**新設計の提案や改善案は含めない**（この Artifact は現状記述に徹する）。

## 調査対象

### コード
- `skills/cmux-team/manager/daemon.ts` — state 管理・handleMessage・assign/reset/disconnect ロジック
- `skills/cmux-team/manager/conductor.ts` — Conductor 初期化・spawnPidWatcher・タスク割当
- `skills/cmux-team/manager/queue.ts` — メッセージ種別・優先度
- `skills/cmux-team/manager/schema.ts` — ConductorState / Message の型定義

### hook / signal 経路
- `.claude/settings.json` 等の hook 設定（SessionStart / Stop / SessionEnd）
- hook shell → `cmux-team send --from-stdin` → daemon handleMessage
- PID watcher（`spawnPidWatcher`）の死活判定ロジック

### 関連ログ事例
- `.team/logs/manager.log` から false-positive 事例を最低 2 件ピックアップ（T244 abort を含む）

## 成果物

`.team/artifacts/Axxx-conductor-state-machine.md`

### フロントマター

```yaml
---
id: Axxx
type: research
title: "Conductor 状態機械 現状調査（2026-04-18 時点）"
created: <ISO 8601>
author: <surface>
task: T<このタスクID>
tags: [state-machine, conductor, robustness]
---
```

### 本文構成（必須セクション）

1. **状態一覧** — 各状態の名前・意味・想定滞在時間
   - idle / assigned / running / disconnected / aborted など実装で使われているすべて
2. **遷移表** — 各遷移について以下を明記:
   - from → to
   - トリガー signal（hook message 種別 / PID event / timeout）
   - ガード条件（state やフラグの前提）
   - 副作用（ログ出力・ファイル書き込み・surface 操作）
3. **Signal の種別と発生源**
   - hook push: SESSION_STARTED / SESSION_IDLE / SESSION_CLEAR / SESSION_ENDED
   - 内部: assign_timeout / disconnect_timeout / PID 消失
   - source= の意味（startup / clear / compact など）
4. **Timeout の一覧**
   - assign_timeout（値・監視対象・timeout 時の挙動）
   - disconnect_timeout（同上）
   - その他（hook_signals GC 等があれば）
5. **Invariant（暗黙の前提）**
   - 「どの状態同士が同時に真であってはならないか」「どの signal の順序が前提か」
6. **既知の false-positive 事例**
   - T244 abort（disconnect_timeout の誤発火、Conductor は agent_spawned を出していたのに disconnected 判定）
   - 他にログから拾える類似事例（スリープ復帰時など）
   - 各事例で「どの状態遷移が正しくなかったか」を明記
7. **メルマイド状態遷移図**（オプション・可能なら）
   - 参考として stateDiagram-v2 を添付（cmux markdown は mermaid 非対応なので別途 image でも可）

## 調査方針

- **推測ではなく実装に基づく記述** — コード行番号（file:line）を引用して裏取りする
- **新設計・改善案は書かない** — 現状記述に徹する。改善アイデアは別タスク（後続）で扱う
- **false-positive 事例の原因仮説は可** — ただし断定せず「〜と見られる」レベル

## 検証観点

- 全状態が列挙され、各状態について from/to 遷移が漏れなく記載されている
- 各遷移のトリガー signal がコード行番号付きで裏取りされている
- 少なくとも T244 abort が事例として分析されている
- Artifact のフロントマターが正しく（type: research, 関連タスク ID 付き）
- Master が artifact を読むだけで現状の状態遷移を把握できる品質

## 後続タスク（このタスクの範囲外）

- 堅牢化の設計議論（Master ↔ ユーザー、Artifact を下敷きに）
- docs/spec/ への正式版仕様の昇格
- 実装タスクの起票
