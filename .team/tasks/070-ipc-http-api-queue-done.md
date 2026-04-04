---
id: 070
title: ファイルベース IPC を HTTP API に移行（queue・done マーカー）
priority: medium
created_at: 2026-04-04T07:03:57.119Z
---

## タスク
## 概要

daemon の proxy（Bun HTTP サーバー）に API エンドポイントを追加し、現在ファイル経由で行っている一時的なプロセス間通信を HTTP API に置き換える。

## 背景

現状、Claude Code セッション → daemon 間の通信に `.team/queue/` ディレクトリのファイル書き込み + 10秒ポーリングを使っている。daemon は既に HTTP サーバー（proxy）を動かしており、`/state`, `/tasks`, `/conductors` の GET エンドポイントも存在する。ファイル経由の IPC は遅延（最大10秒）とファイル I/O のオーバーヘッドがある。

## 移行対象

### 1. メッセージキュー（`.team/queue/`） → `POST /api/messages`

- 現在: `cmux-team send <TYPE>` CLI → `.team/queue/*.json` → daemon の `processQueue()` が10秒ポーリング
- 変更後: `cmux-team send <TYPE>` CLI → `POST http://localhost:{port}/api/messages` → daemon が即時処理
- 対象メッセージ: TASK_CREATED, CONDUCTOR_DONE, AGENT_SPAWNED, SESSION_STARTED, SESSION_ENDED, SESSION_ACTIVE, SESSION_IDLE, SHUTDOWN
- `queue.ts` のファイル操作は不要になる

### 2. done マーカー（`taskStatusFile`） → CONDUCTOR_DONE メッセージ統合

- 現在: Conductor が `taskStatusFile` に `{"status":"done"}` を書き込み → daemon の `checkConductorStatus()` がポーリング検出
- 変更後: Conductor が `cmux-team send CONDUCTOR_DONE` を実行（既に存在する仕組み）→ API 経由で即時通知
- done マーカーのファイルポーリング（`checkConductorStatus` の `existsSync`）を廃止
- タスクの永続的な完了状態は `task-state.json`（`close-task` CLI）が担うため影響なし

### 3. `.team/queue/processed/` の廃止

- 処理済みメッセージのアーカイブは再読み込みされない
- ログ目的なら `manager.log` に記録するだけで十分

## 移行しないもの

- `.team/proxy-port` — CLI が proxy のアドレスを知るために必要（鶏と卵問題）
- `.team/master.surface` — T055 で廃止済み（team.json に統合）
- `.team/task-state.json` — タスク履歴の永続化として必要

## 実装方針

### proxy.ts

- `POST /api/messages` エンドポイント追加
- body は既存の `QueueMessage` スキーマを再利用
- 受信したメッセージを即座に `processQueue` 相当の処理に渡す
- T069 の `POST /master-state` と同じパターン

### daemon.ts

- `tick()` から `processQueue()` のファイルポーリングを削除
- proxy からのコールバックでメッセージを処理する関数を公開
- `checkConductorStatus()` から done マーカーの `existsSync` チェックを削除

### main.ts（CLI）

- `cmdSend()` を HTTP POST に変更（`proxy-port` ファイルからポート取得）
- フォールバック: proxy に接続できない場合のエラーハンドリング

### queue.ts

- ファイル操作関数を廃止（または HTTP クライアントに置き換え）

### conductor テンプレート

- `taskStatusFile` への書き込み指示を `cmux-team send CONDUCTOR_DONE` に統一

## 注意点

- proxy-port が存在しない／proxy が起動していない場合の graceful degradation
- daemon restart 中のメッセージロスト（許容可能 — restart 後にタスク再スキャンで回復）
- 既存の `cmux list-status` によるフォールバック検出は残す（防御的）
