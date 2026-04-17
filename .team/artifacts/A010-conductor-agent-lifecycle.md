---
id: A010
type: spec
title: "Conductor / Agent ライフサイクル"
created: 2026-04-14T12:30:00+09:00
author: master
tags: [lifecycle, conductor, agent, hooks, session, T181]
---

# Conductor / Agent ライフサイクル

cmux-team の 4 層アーキテクチャ（Master → Manager → Conductor → Agent）のうち、Conductor と Agent の状態遷移を可視化する。検出メカニズムは Claude Code の hook（`settings.json`）に依存しており、prompt 本文やその frontmatter では制御しない。

## Conductor ライフサイクル

```mermaid
stateDiagram-v2
    [*] --> idle: cmux-team start<br/>固定ペインに Claude 起動
    idle --> assigning: TASK_CREATED<br/>(Manager が割当)
    assigning --> running: worktree 作成<br/>prompt 注入<br/>conductor_started
    running --> done_signal: Stop hook<br/>→ SESSION_IDLE<br/>conductor_done_signal
    running --> asking: Stop hook +<br/>AskUserQuestion 検出<br/>(T181)
    asking --> running: 人間介入<br/>(TUI 表示)
    done_signal --> reset: task_completed<br/>journal 記録
    reset --> idle: /clear<br/>conductor_reset

    running --> disconnected: validateSurface<br/>失敗
    disconnected --> running: surface 復活<br/>(5 分以内)
    disconnected --> aborted: 5 分経過<br/>disconnect_timeout<br/>task_aborted
    aborted --> reset

    note right of running
      Agent を spawn-agent で起動
      複数 Agent 並列監視
    end note
```

## Agent ライフサイクル

```mermaid
stateDiagram-v2
    [*] --> spawning: Conductor が<br/>cmux-team spawn-agent
    spawning --> initializing: タブ作成<br/>settings.json 注入 (T181)<br/>claude --settings 起動
    initializing --> working: agent_spawned
    working --> completed_idle: "停止"指示で<br/>❯ プロンプトに戻る
    working --> asking: AskUserQuestion<br/>呼び出し
    working --> crashed: プロセス終了<br/>(rate limit / error)

    completed_idle --> detected_completed: Stop hook<br/>→ SESSION_IDLE (T181)
    asking --> detected_ask: Stop hook<br/>→ SESSION_ASK (T181)
    crashed --> detected_crashed: SessionEnd hook<br/>→ SESSION_ENDED (T181)

    detected_completed --> done: done ファイル<br/>status=completed
    detected_ask --> done: done ファイル<br/>status=ask
    detected_crashed --> done: done ファイル<br/>status=crashed

    done --> [*]: Conductor が await-agent で検出<br/>agent_done<br/>タブ close
```

## 遷移イベント対応表

| 遷移 | トリガー | ログイベント |
|------|---------|------|
| Conductor idle → running | `TASK_CREATED` メッセージ | `conductor_started` |
| Conductor running → done | Stop hook → SESSION_IDLE | `conductor_done_signal` |
| Conductor running → disconnected | `validateSurface` 失敗 | `conductor_disconnected` |
| Conductor → aborted | 5 分経過 | `task_aborted reason=disconnect_timeout` |
| Conductor → reset | done / aborted 確定 | `conductor_reset` |
| Agent spawn | `cmux-team spawn-agent` CLI | `agent_spawned` |
| Agent 完了（プロセス存続） | Stop hook → SESSION_IDLE | `agent_done trigger=idle` (T181 後) |
| Agent 質問 | Stop hook + AskUserQuestion 検出 | `agent_done trigger=ask` (T181 後) |
| Agent クラッシュ | SessionEnd hook → SESSION_ENDED | `agent_done trigger=session_ended` |

## 検出メカニズムの分担

```mermaid
flowchart TB
    subgraph S[settings.json hooks]
        StopHook[Stop hook]
        SessionEndHook[SessionEnd hook]
        PreToolUseHook[PreToolUse hook]
    end

    subgraph D[daemon handleMessage]
        SI[SESSION_IDLE]
        SA[SESSION_ASK]
        SE[SESSION_ENDED]
    end

    subgraph F[状態反映]
        ConductorState[Conductor state]
        DoneFile[Agent done ファイル]
        TUI[TUI ダッシュボード]
    end

    StopHook -->|AskUserQuestion なし| SI
    StopHook -->|AskUserQuestion あり| SA
    SessionEndHook --> SE
    PreToolUseHook -->|監査証跡| D

    SI -->|Conductor surface| ConductorState
    SI -->|Agent surface| DoneFile
    SA -->|Conductor surface| ConductorState
    SA -->|Agent surface| DoneFile
    SE -->|Agent surface| DoneFile

    ConductorState --> TUI
    DoneFile -->|Conductor が await-agent 監視| TUI
```

## 既存実装の欠落点（T181 で埋める）

| 項目 | 現状 | T181 後 |
|------|------|---------|
| Conductor Stop hook | 設定済み | 変更なし（AskUserQuestion 検出を追加） |
| Conductor SessionEnd hook | 設定済み | 変更なし |
| **Agent Stop hook** | **未設定** | **新設（`generateAgentSettings()`）** |
| **Agent SessionEnd hook** | **未設定** | **新設** |
| Agent 完了検出 | `surface_lost` のみ（プロセス存続時は検出不可） | Stop hook で確実に検出 |
| Agent ask 検出 | 不可 | SESSION_ASK で検出 |
| Conductor が Agent を待つ方法 | ポーリング（30 秒間隔 read-screen） | `cmux-team await-agent` で done ファイル監視 |

## 設計原則との整合

- **pull 型監視**: Agent が done ファイルを書き、Conductor が await-agent で取りに行く
- **決定論的なものはコードで**: hook による検出は文字列マッチに依存しない（JSONL トランスクリプト構造で判定）
- **各層は自分の仕事だけをする**: Agent は作業して done ファイルを書くだけ、Conductor は待って解釈するだけ

## 参考

- T181（ready 待ち・本 artifact 作成時点 draft）: await-agent 方式への移行と Ask 状態検出対応
- `skills/cmux-team/manager/daemon.ts:670-710`: `handleMessage` SESSION_IDLE / SESSION_ENDED 処理
- `skills/cmux-team/manager/main.ts:922`: `generateConductorSettings`（Agent 版は T181 で新設）
- `skills/cmux-team/templates/ja/common-header.md`: 「作業が完了したら停止してください」— Agent 向け方針指示（検出メカニズムは hook 側）
