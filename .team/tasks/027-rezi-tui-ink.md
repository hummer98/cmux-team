---
id: 027
title: Rezi TUI: Ink版と同等の表示に調整
priority: high
created_at: 2026-03-30T01:51:56.130Z
---

## タスク
## 問題
Rezi 版 dashboard (dashboard-rezi.tsx) の表示が Ink 版と大きく異なり、重要な情報が欠落している。

## 現状の画面（cmux read-screen で確認済み）
- ヘッダー: ステータス（RUNNING）・PID・Conductor数・タスク数が表示されない
- Master セクション: OK
- Conductors セクション: タイトルが '…' で切れている（'Conductors 3/3' が表示されるべき）
- Tasks セクション: 固定高さで大量の空白。5件しかないのに画面の半分以上を占有
- Journal/Log タブ: タブ切り替えUIは表示されるが、コンテンツ（ジャーナルエントリやログ行）が一切表示されない

## 修正目標
Ink 版 (dashboard.tsx) と同等の情報量・レイアウトを実現する:

### 1. ヘッダー
- 'cmux-team RUNNING PID XXXX conductors N tasks N open' を1行で表示

### 2. Conductors セクション
- パネルタイトルに 'Conductors N/M' を完全表示
- idle/running/done の状態、タスクID、経過時間を表示

### 3. Tasks セクション
- タスク数に応じた可変高さ（空白を最小化）
- closed タスクは dim 表示

### 4. Journal/Log タブ（最重要）
- Journal: task_received/conductor_started/task_completed イベントを時刻・アイコン・タスクID・メッセージで表示
- Log: manager.log の末尾行を表示
- タブ切り替え（キーボード 1/2/Tab + マウスクリック）で表示を切り替え
- マウスホイールでスクロール可能

### 5. レイアウト全体
- Ink 版のように各セクションが内容に応じた高さを取り、下部タブが残りの高さを使う
- 画面幅に応じたレスポンシブ対応（cols >= 65/75/85 で段階的に情報量調整）

## 参考
- Ink 版: skills/cmux-team/manager/dashboard.tsx（これが正解の表示）
- Rezi ドキュメント: https://rezitui.dev/docs
- 現在の Rezi 版: skills/cmux-team/manager/dashboard-rezi.tsx

## 確認方法
daemon を再起動して表示確認:
- cmux-team stop && cmux-team start
- または daemon の auto-restart を待つ（ソースファイル mtime 変更で自動検出）
