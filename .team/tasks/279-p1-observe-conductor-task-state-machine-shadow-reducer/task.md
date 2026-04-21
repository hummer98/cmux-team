---
id: 279
title: P1 observe: Conductor/Task state machine の shadow reducer 実装
priority: high
created_at: 2026-04-20T14:04:51.159Z
---

## 目的

cmux-team v4.0.0 で発生した T255 類の状態遷移バグ（`conductor_discarded` 後の pane 補充漏れ、SESSION_IDLE/CLEAR race 等）を構造的に解決するための第一歩。

Conductor / Task の FSM reducer を pure function として実装し、**shadow mode** で動かす。既存 `daemon.ts` のロジックは変更せず、イベントを reducer にも並行して流し込み、期待状態と実状態の diff をログ記録する。

併せて、**FSM を正とする状態機械リファレンス**（`docs/spec/07-state-machine.md`）を新規作成し、A017 artifact も reducer 実装に合わせて補正する。

## 背景

A017-state-machine.md に現状の遷移表がまとめられている。30+ 箇所に散在する遷移ロジックを 1 箇所（reducer）に集約し、型で exhaustive に網羅することでモグラ叩きを終わらせる。

CLAUDE.md の「構造的正しさを優先」方針（本セッションで更新）に基づく。

## 成果物

### 1. reducer 実装

`skills/cmux-team/manager/state-machine/` 新設:

- `events.ts` — discriminated union event 型（hook / timeout / assign / done / pid_died / clear_manual / registered）
- `conductor-fsm.ts` — Conductor reducer: `(state, event, ctx) => { next, actions[] }`
- `task-fsm.ts` — Task reducer
- `invariants.ts` — 不変条件 assert（例: running ⇒ assigned task を必ず持つ）
- `fsm.test.ts` — A017 の全遷移セルを網羅するテーブルテスト

### 2. shadow 配線

`daemon.ts` の各 handler **末尾** で shadow reducer も呼び出し、既存処理完了後に reducer の予測 state と実 state を比較して `fsm_shadow_diff` ログに記録する（副作用は実行しない）。try/catch で包んで既存処理に絶対に影響させないこと。

### 3. ドキュメント更新

- **新規**: `docs/spec/07-state-machine.md` — Conductor / Task / Joint の FSM リファレンス。reducer の型定義を正として、状態一覧・イベント一覧・遷移表・不変条件・Action 一覧を記載。Mermaid で状態遷移図を含める
- **更新**: `A017-state-machine.md` — shadow 稼働で発見された誤記・漏れを反映（無ければその旨を記載）
- **更新**: `docs/spec/00-project-overview.md` および関連ファイルで `07-state-machine.md` へのリンクを追加
- **更新**: CLAUDE.md のリポジトリ構造セクションに 07-state-machine.md の行を追加

## スコープ

- A017（2026-04-20）の状態遷移表を正とする
- Conductor: starting / assigning / idle / running / asking / disconnected / broken
- Task: draft / ready / assigned / closed / aborted / deleted
- Event: SESSION_STARTED / SESSION_IDLE / SESSION_CLEAR / SESSION_ACTIVE / SESSION_ASK / SESSION_ENDED / TIMEOUT / ASSIGN / DONE / PID_DIED / CLEAR_MANUAL / REGISTERED
- Action は discriminated union で返すのみ、実行しない
- 不変条件は assert するが throw しない（log のみ）

## スコープ外（次フェーズ以降）

- P2（T280 予定）: `handleMessage` / `scanTasks` を reducer 呼び出しに置換、effects.ts で Action 実行
- P3: tick ごとに不変条件を強制、違反時の自動リカバリ

## 完了条件

- reducer が全イベントを exhaustive switch で受理（TypeScript の never 型で検査）
- fsm.test.ts が A017 の全遷移セルをカバー（grep で状態×イベントの組合せを網羅確認）
- shadow mode を 24h 稼働させて `fsm_shadow_diff` の統計を取得し、乖離パターンを impl-report に列挙
- 不変条件違反（例: T255 の conductor_discarded 残し）が shadow ログで検出されることを 1 ケース以上で確認
- `docs/spec/07-state-machine.md` が reducer 実装と 1:1 対応し、Mermaid 図が描画される
- A017 の補正内容（あれば）が journal に記録される

## 参考

- `.team/artifacts/A017-state-machine.md` — 現状の遷移表（裏取りは file:line 形式済）
- CLAUDE.md「構造的正しさを優先」原則
- T255 / T263 / T269 / T276 / T277 — 最近の状態遷移関連バグ

## 注意

既存の `daemon.ts` は**一切書き換えない**（P2 の仕事）。shadow 呼び出しは各 handler の末尾に足す形で、try/catch で包んで既存処理に影響しないこと。

docs/spec/ への追記は dockeeper ではなく本タスクで実施する（reducer と spec を同一タスクで出すことで乖離を防ぐ）。
