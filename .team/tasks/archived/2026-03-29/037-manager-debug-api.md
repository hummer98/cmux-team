---
id: 037
title: Manager HTTP API にデバッグ用エンドポイントを追加
priority: high
status: ready
created: 2026-03-29
---

## 概要

Manager daemon の既存プロキシサーバーにデバッグ用 API エンドポイントを追加し、内部状態を外部から確認可能にする。

## 背景

現状 Manager の内部状態（taskList, conductors Map 等）を確認する手段がない。TUI の表示バグや タスク処理の問題が発生した際に原因特定が困難。

## 実装内容

既存のプロキシサーバー（`.team/proxy-port` で公開中のポート）に以下のエンドポイントを追加:

| エンドポイント | レスポンス |
|---|---|
| `GET /state` | DaemonState の全ダンプ（JSON） |
| `GET /tasks` | taskList の中身（読み込まれたタスク一覧、フィルタ状態） |
| `GET /conductors` | conductors Map の全エントリ（状態、割り当てタスク、agents） |

### 使用例

```bash
PORT=$(cat .team/proxy-port)
curl -s localhost:$PORT/state | jq .
curl -s localhost:$PORT/tasks | jq .
curl -s localhost:$PORT/conductors | jq .
```

## 影響範囲
- skills/cmux-team/manager/daemon.ts（プロキシサーバーにルート追加）

## Journal

- summary: プロキシサーバーに /state, /tasks, /conductors デバッグ用エンドポイントを追加し、DaemonState の内部状態をHTTP経由でJSON取得可能にした
- files_changed: 3
