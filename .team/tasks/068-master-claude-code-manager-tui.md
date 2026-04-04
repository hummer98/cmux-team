---
id: 068
title: MasterのClaude Codeセッション状態をManagerで監視・TUI表示
priority: medium
created_at: 2026-04-04T01:16:15.814Z
---

## タスク
## 概要

Master の Claude Code セッションの状態（connected/disconnected, idle/running）を Manager が把握し、TUI の Master 欄に反映する。

## 現状

- 起動時に surface 生存確認するのみ
- 起動後の SESSION_ENDED / SESSION_STARTED 等のフックメッセージは Master surface と照合されず無視されている
- Master が死んでも TUI は ● のまま

## やること

### 1. DaemonState に Master 状態を追加
- masterPid, masterStatus (idle/running/disconnected), masterDisconnectedAt 等

### 2. daemon.ts の processQueue で Master surface を照合
SESSION_STARTED / SESSION_ENDED / SESSION_IDLE / SESSION_ACTIVE メッセージで masterSurface と一致する場合に Master の状態を更新する。現状は findConductor → Agent チェックの順だが、その前に Master チェックを追加。

### 3. PID watcher を Master にも適用
SESSION_STARTED で PID を受け取ったら spawnPidWatcher を設定。

### 4. TUI の Master 欄を更新
- connected + idle: ● (緑)
- connected + running: スピナーアニメーション (黄)
- disconnected: ⚠ disconnected (黄)
- surface なし: ○ (灰)

タスク番号等は不要。surface 番号と状態のみ表示。

## 対象ファイル
- `manager/daemon.ts` — Master 状態管理、processQueue の照合追加
- `manager/dashboard.tsx` — buildMasterSection の表示更新
- `manager/schema.ts` — 必要に応じて型追加
