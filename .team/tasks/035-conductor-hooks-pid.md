---
id: 035
title: Conductor ライフサイクル監視の再設計: hooks + PID ウォッチャー
priority: high
created_at: 2026-04-01T01:24:01.312Z
---

## タスク
## 背景

Conductor の Claude Code セッションが /exit やクラッシュでシェルに落ちた場合、daemon は検知できず永遠に running と表示し続ける。validateSurface() が surface の存在しか確認せず、Claude Code プロセスの生死を見ていないことが原因。

## 設計（承認済みプラン）

プラン詳細: .claude/plans/flickering-munching-bumblebee.md

### アーキテクチャ

Claude Code hooks → cmux-team send CLI → queue → daemon のパイプラインで全ライフサイクルイベントを通知。PID ウォッチャーで終了を約1秒以内に検知。

### 実装順序

1. schema.ts: SESSION_STARTED/ENDED/ACTIVE メッセージ型追加、ConductorState に pid/sessionId/disconnected 追加
2. main.ts: cmdSend に SESSION_* 対応 + CMUX_SURFACE 環境変数を cmdConductor()/cmdSpawnAgent() に追加
3. .claude/settings.json: SessionStart/End/Stop hooks 追加（既存 PreToolUse とマージ）
4. daemon.ts: processQueue に SESSION_* ハンドラ + PID ウォッチャー spawn
5. conductor.ts: checkConductorStatus に disconnected 対応
6. dashboard.tsx: disconnected 表示（⚠ アイコン）
7. main.ts: restart-conductor / reset-conductor コマンド追加

### 実験結果（確認済み）

- $PPID で Claude Code の PID が取得可能（ps_tree で /Users/yamamoto/.local/bin/claude を確認）
- session_id も stdin JSON から取得可能
- CMUX_SURFACE 環境変数は現在未設定 → cmdConductor() で設定必要

### 対象ファイル

- skills/cmux-team/manager/schema.ts
- skills/cmux-team/manager/daemon.ts
- skills/cmux-team/manager/main.ts
- skills/cmux-team/manager/conductor.ts
- skills/cmux-team/manager/dashboard.tsx
- .claude/settings.json

### 検証

1. cmux-team start → session_started ログ確認
2. Conductor で /exit → session_ended + TUI disconnected 表示
3. restart-conductor → idle 復帰
4. タスク割当 → SESSION_ACTIVE heartbeat 確認
5. Agent spawn/停止 → session_started/ended 確認
