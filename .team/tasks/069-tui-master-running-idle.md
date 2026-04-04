---
id: 069
title: TUI Master列に状態表示（running/idle/プロンプト先頭）
priority: high
created_at: 2026-04-04T06:57:04.228Z
---

## タスク
## 概要

TUI ダッシュボードの Master 列に、Master セッションの状態（running/idle）と入力プロンプトの先頭部分を表示する。

## 背景

現状 Master が何をしているか TUI から確認できない。hooks + daemon API で状態を連携する。

## 実装方針

### 1. proxy.ts にエンドポイント追加

- `POST /master-state` — hooks から呼ばれる。body: `{"status":"busy"|"idle", "prompt":"..."}`
- daemon メモリ上に保持（DaemonState に `masterState` フィールド追加）
- `GET /state` のレスポンスに `masterState` を含める（または `GET /master-state` を別途追加）

### 2. Claude Code hooks 設定

プロジェクトの `.claude/settings.json` に以下を追加:

- `UserPromptSubmit` hook: stdin から `prompt` を読み取り、`POST /master-state` に `{"status":"busy","prompt":prompt[:80]}` を送信
- `Stop` hook: `POST /master-state` に `{"status":"idle"}` を送信
- proxy port は `.team/proxy-port` から取得

### 3. dashboard.tsx の Master 列更新

- `/state` レスポンスの `masterState` を読み取り
- 表示例: `Master: [running] タスクT042のレビューを…` / `Master: [idle]`

## 参考: hooks stdin スキーマ

- `UserPromptSubmit`: `{"prompt": "string", ...}`
- `Stop`: `{"stop_reason": "string", ...}`

## 注意点

- hooks のコマンドはシンプルに（curl か python3 ワンライナー）
- proxy-port ファイルが存在しない場合は何もしない（graceful degradation）
- prompt は80文字程度で切り詰める
