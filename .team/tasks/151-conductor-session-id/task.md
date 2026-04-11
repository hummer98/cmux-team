---
id: 151
title: Conductor 起動関数を統合し session-id を自己生成方式に変更
priority: high
depends_on: [150]
created_at: 2026-04-11T12:11:37.509Z
---

## タスク
## 背景

Conductor 起動に3つの関数（`spawnSingleConductor`, `launchConductorOnSurface`, `spawnConductor`）が存在し、CONDUCTOR_REGISTERED 送信・環境変数設定・session-id 渡しの挙動がそれぞれ微妙に異なる。統合して不整合を解消する。

また session-id は現在 Manager が生成して CLI 引数で渡しているが、`cmux-team conductor` 自身が生成して Manager に HTTP 通知する方式に変更する。

## やること

### 1. Conductor 起動関数の統合

`conductor.ts` の3関数を **ペイン作成** と **Conductor 起動** に分離・統合:

- **ペイン作成**: `createConductorPanes`（既存 L117）はそのまま
- **Conductor 起動**: 新関数（例: `launchConductor(surface)`）に統合。以下を行う:
  - CONDUCTOR_REGISTERED を HTTP で送信
  - `export CMUX_SURFACE=${surface} CMUX_CLAUDE_HOOKS_DISABLED=1` を送信
  - `cmux-team conductor` を送信（引数なし）
  - タブ名設定

`spawnSingleConductor`, `launchConductorOnSurface`, `spawnConductor` の Conductor 起動部分はこの新関数に置き換え。`spawnConductor` のペイン作成 + assignTask 呼び出しはそのまま残すか呼び出し元に移動。

### 2. session-id の自己生成方式

`cmdConductor()`（main.ts）を変更:

- 引数なし（通常起動）: UUID を自分で生成 → daemon に HTTP 通知（`cmux-team send SESSION_ID --session-id <uuid> --surface $CMUX_SURFACE` 等）→ `claude --session-id <uuid>` で exec
- `--session-id xxx` 引数あり（将来の拡張用に残す場合のみ）: そのまま使用

### 3. Manager 側の対応

- daemon.ts で SESSION_ID メッセージを受信して `conductor.sessionId` に記録
- `initializeConductor` / abort / restart の箇所で session-id 生成・引数渡しを削除
- conductor state への sessionId 設定は HTTP 通知受信時に行う

### 4. 呼び出し元の更新

abort（main.ts:1568-1573）、restart（main.ts:1653-1658）で:
- `crypto.randomUUID()` 生成を削除
- `--session-id` 引数渡しを削除
- `conductor.sessionId = newSessionId` を削除（HTTP 通知で設定される）

## 確認ポイント

- 通常起動で session-id が Manager に正しく伝わること
- resume フロー（`cmux-team resume`）は変更なし・正常動作すること
- trace 記録に session-id が入ること
- abort / restart 後の再起動で新しい session-id が記録されること
