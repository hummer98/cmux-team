# タスク割り当て

## タスク内容

---
id: 262
title: Conductor 状態機械を純粋関数に抽出し、状態削減を検討
priority: medium
created_at: 2026-04-19T00:59:39.236Z
---

## タスク
## 背景

Conductor の状態管理が race condition の温床になっている。
A014（状態機械の現状調査）で 7 状態 × 25+ 遷移が文書化され、A015（フォールバック
設計方針）で fail-stop/best-effort の境界が決まっている。T232/T244/T250/T251/
T254/T255/T260/T261 と race fix が連続しており、根本的な整理が必要。

実装の現状:
- `conductor.status = ...` の直接代入が **42 箇所**（daemon.ts 7 + conductor.ts 2 + tests）
- guard 条件（`if (status === "disconnected" && taskRunId) ...`）が
  daemon.ts:1291/1345/1350/1702/1710/1789/1798/1805/1821/1824 等に散在
- signal 源が 4 系統: Claude hook / PID watcher(1s) / tick timeout(10s) / 直接 POST

XState 等のパッケージ導入を検討したが、race の本質は「signal 源の非決定性」で
あって「状態表現の貧弱さ」ではないため、パッケージ導入だけでは T244 型のバグは
消えない。先に純粋関数化とテスト網羅を済ませてから、必要ならパッケージ移行を
判断する段取りにする。

## やること

### Phase 1: 現状の純粋関数化（破壊的変更なし）

1. \`skills/cmux-team/manager/conductor-fsm.ts\` を新規作成
2. \`transition(state, event): { next, effects[] }\` の形で純粋関数化
   - 入力: 現在の \`ConductorState\` + イベント（SESSION_STARTED / SESSION_IDLE /
     SESSION_ENDED / SESSION_ASK / SESSION_CLEAR / SESSION_ACTIVE / CONDUCTOR_DONE /
     PID_DEAD / TIMEOUT_STARTING / TIMEOUT_ASSIGNING / TIMEOUT_DISCONNECT /
     ASSIGN_REQUEST / ASSIGN_FAILED 等）
   - 出力: 次状態 + 副作用リスト（ログ / worktree 削除 / task-state 更新 /
     notify 等）
3. daemon.ts の handleMessage / monitorConductors / spawnPidWatcher から
   \`conductor.status = ...\` の直接代入を撤去し、transition() 呼び出し + effect 実行に置き換える
4. \`conductor-fsm.test.ts\` で A014 の 25 遷移表をそのままテスト仕様にする
   - 各遷移: from × event × guard → to + effects を表駆動テスト化
   - 現行 daemon.test.ts の該当ケースも極力移行

### Phase 2: 状態削減の検討

A014 の 7 状態を見直し、本質的な軸に分解できないか検討する。削減候補:

- **starting と assigning の統合**: 両方「SESSION_STARTED 到着を待つ過渡期」で
  60s timeout も同じ。source（registered / clear）と taskRunId 有無で区別可能
  → \`pending\` のような 1 状態に統合し source フィールドで分岐
- **asking の廃止**: \`askQuestion: string\` 有無で表現可能（running + askQuestion）
  → \`status\` と直交するフラグとして分離
- **idle と running の統合検討**: \`taskRunId\` 有無で派生可能
  → ただし TUI 表示・assignTask 候補抽出で頻出するため、削減メリットは慎重に
- **disconnected と broken の関係再整理**: 時間境界（300s）で分かれる現状だが、
  broken は「永続化する確定異常」、disconnected は「監視中の通信断」と意味が
  明確に違うので残す方向

削減の判断基準:
- 状態を削ることで型安全性が下がらないか
- guard 条件が増えて可読性が落ちないか
- 外部（TUI / team.json / ログ）との互換性をどう扱うか

### Phase 3: パッケージ移行の判断（後続タスク化候補）

Phase 1/2 完了後、以下のどれを取るか決める:
- 現状の純粋関数のまま維持（最もシンプル）
- XState v5 に移行（網羅性の型チェック・可視化・parallel states）
- Robot 等の軽量 FSM（~1KB）に移行

## 判断が必要なポイント

- Phase 1 と Phase 2 を 1 タスクで一気にやるか、分割するか
  → 分割案: 本タスクを Phase 1 のみに限定し、Phase 2 は完了後に A016 相当の
    決定 artifact を書いてから別タスクにする
- transition() の event 型定義をどこまで正規化するか
  → hook signal をそのまま event にするか、\`ClearReceived\` のような
    semantic event に変換するか
- broken 状態の回復経路（現状未実装）を本タスクで決めるか後回しにするか

## 参考

- A014 「Conductor 状態機械 現状調査」（遷移表そのままテスト化できる）
- A015 「フォールバック動作の設計方針」（fail-stop 基本）
- T248（A014 の元タスク）
- T250（broken 導入）/ T254（task unique）/ T255（initializeLayout）
- memory \`feedback_error_recovery\`

## 対象ファイル

- 新規: \`skills/cmux-team/manager/conductor-fsm.ts\`
- 新規: \`skills/cmux-team/manager/conductor-fsm.test.ts\`
- 修正: \`skills/cmux-team/manager/daemon.ts\`（handleMessage / monitorConductors / spawnPidWatcher）
- 修正: \`skills/cmux-team/manager/conductor.ts\`（assignTask / resetConductor）
- 修正: \`skills/cmux-team/manager/schema.ts\`（Phase 2 で status union 変更時）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-262-1776560393` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-262-1776560393
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-262-1776560393/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/262-conductor/runs/task-262-1776560393
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/262-conductor/runs/task-262-1776560393/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」Step 12 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
