# タスク割り当て

## タスク内容

---
id: 181
title: await-agent方式への移行とAsk状態検出対応
priority: medium
created_at: 2026-04-13T17:48:13.437Z
---

## 背景

ConductorがAgentの完了を自前のポーリングループ（30秒間隔のcmux read-screen）で確認している。
ManagerはSESSION_ENDEDでAgent完了を検知できる構造だが、**現状AgentにはSessionEnd hookが設定されていない**（generateConductorSettings()はConductor専用）。

実際のagent_done検知はtick()内のsurface_lostチェック（pollInterval=10秒毎）が唯一のパスであり、
**「プロセス継続のままプロンプトに戻る」ケース（429後など）はsurfaceAlive()=trueのためsurface_lostが発火せず検知不可**。
現在のConductorポーリングは`❯`チェックでこれを唯一検出している。

また、ConductorがAskUserQuestionを呼んでStop hookが発火した場合、ManagerはSESSION_IDLEを受け取るが
runningのConductorはステータスが変わらず放置される（詰まり検出不可）。

## 前提事実（検証で確認）

- `generateConductorSettings()` はConductor専用。Agentに適用されない
- Agentには現在 Stop hook / SessionEnd hook が存在しない
- `daemon.ts` の `SESSION_ENDED` Agent パスは実質dead code
- done ファイル方式を機能させるには、まずAgentへのStop hook追加が必要
- Claude CodeがAskUserQuestionを呼ぶと、トランスクリプトJSONLに `tool_use` ブロックとして記録される
- Stop hookのペイロードには `transcript_path` と `last_assistant_message` が含まれ、ask/complete を構造的に区別できる
- SESSION_IDLE受信時、running状態のConductorはステータス変化なし（誤判定なし）。ただし詰まり検出もできない

## 修正内容

### 1. Agent側 settings の整備（新規）

- `generateAgentSettings(projectRoot, surface, conductorSurface)` を新設
  - Stop hook: トランスクリプトの最終ブロックが `AskUserQuestion` tool_use か確認
    - Yes → `SESSION_ASK` 送信（ask内容をpayloadに含める）
    - No  → `SESSION_IDLE` 送信（完了）
  - SessionEnd hook（`logout|prompt_input_exit|other`）: `SESSION_ENDED` 送信（プロセス終了シグナル）
- `cmdSpawnAgent` でこのsettingsを使用（statusLineも統合）
- `$CMUX_SURFACE`（agent surface）だけでdaemon側はconductorを特定できる

### 2. Conductor側 settings の更新

- 既存 `generateConductorSettings()` のStop hookに `AskUserQuestion` 検出を追加
  - Yes → `SESSION_ASK` 送信
  - No  → `SESSION_IDLE` 送信（現状維持）

### 3. schema.ts

- `SessionAskMessage` を新設（`SESSION_ASK` メッセージ型）
  - `surface`, `question`（last_assistant_message）, `pid` を含む
- `ConductorState` に `askQuestion?: string` フィールドを追加

### 4. Manager側（daemon.ts）

- `handleMessage` に `SESSION_ASK` ケースを追加
  - **Agent surface** → done ファイルに `status=ask\nquestion=...` を書く
  - **Conductor surface** → `conductor.askQuestion` にquestionを保存、`conductor.status = "asking"` に遷移。自動回復メッセージは送らない

- `handleMessage` の `SESSION_IDLE` ケースにAgent surface処理を追加
  - conductor / master でもない surface が SESSION_IDLE → `agent_done`（status=completed）として扱う
  - done ファイルを作成: `.team/conductors/<conductor-surface>/agent-done/<agent-surface>` に `status=completed` を書く

- `SESSION_ENDED` のAgentパス（現dead code）が実際に届くようになる
  - done ファイルに `status=crashed` を書く

### 5. TUI（dashboard.tsx）

- Conductorが `status === "asking"` の場合に表示を変える
  - ステータスラベル: `asking` または `⚠ ask` など視認しやすい表示
  - `askQuestion` の内容をConductor行に表示（折り返し or 省略）

### 6. main.ts

- `cmux-team await-agent --surface $SURFACE [--timeout <sec>]` コマンドを追加
  - fs.watchで done ファイルを監視（await-taskと同パターン）
  - `STATUS=completed|crashed|ask|timeout` を stdout に出力
  - timeout は600秒程度

### 7. Conductorテンプレート側

- ポーリングループを `cmux-team await-agent --surface $AGENT_SURFACE` に置き換え
- exit 75時の処理を追加（`RESET_EPOCH` まで sleep してリトライ）
- `STATUS=crashed` 時: outputファイルを読んでエラー判断し対処方針を決める
- `STATUS=ask` 時: Agentの質問内容を読んで自律判断し、回答をAgentに送信してリトライ

## スコープアウト（別タスクへ）

- SessionEnd `other` matcher のConductorへの追加（disconnect_timeoutで既対応）
- disconnected → abort のrate limit区別（判定困難）
- rate limit回復時のidle AgentへのcontinueE一斉送信（実現条件が不確定）
- Conductor ask時の自動回復メッセージ送信（ユーザーがTUIで状況を見て手動介入する方針）

## 方針

- 429/rate limit（プロンプト戻り）: Stop hookでSESSION_IDLEが届く → agent_done(completed)
- 429/rate limitによるプロセス終了: SessionEnd hookでSESSION_ENDEDが届く → agent_done(crashed)
- 429以外のAPIエラー: Conductorに判断を委ねる（crashed通知 → Conductorが自律対処）
- Agent ask: ConductorがSTATUS=askを受け取り自律判断して回答・リトライ
- Conductor ask: Managerが `status=asking` に遷移してTUIに表示 → ユーザーが手動介入


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-181-1776143077` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-181-1776143077
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-181-1776143077/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/181-agent-await-agent/runs/task-181-1776143077
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/181-agent-await-agent/runs/task-181-1776143077/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
