---
id: A009
type: research
title: "cmux Socket API — 利用可能な機能調査"
created: 2026-04-11T00:00:00+09:00
author: master
tags: [cmux, socket-api, automation, websocket]
---

# cmux Socket API — 利用可能な機能調査

> ソース: https://cmux.com/docs/api および https://cmux.com/docs/browser-automation

## 重要: WebSocketではなく Unix Domain Socket

ユーザーは「WebSocket」と表現していたが、cmux が提供するのは **Unix Domain Socket** (/tmp/cmux.sock) ベースの JSON-RPC API。WebSocket (ws://) ではない点に注意。ただし、ソケットを介してJSON送受信するという基本的な操作感は近い。

## 接続情報

| ビルド | ソケットパス |
|--------|-------------|
| Release | `/tmp/cmux.sock` |
| Debug | `/tmp/cmux-debug.sock` |
| Tagged debug | `/tmp/cmux-debug-<tag>.sock` |

環境変数 `CMUX_SOCKET_PATH` でオーバーライド可能。

## リクエスト/レスポンス形式（JSON-RPC 風）

```json
// リクエスト（改行終端）
{"id":"req-1","method":"workspace.list","params":{}}

// レスポンス
{"id":"req-1","ok":true,"result":{"workspaces":[...]}}
```

**注意**: 旧 v1 形式 `{"command":"..."}` は非対応。

## アクセスモード

| モード | 説明 | 設定方法 |
|--------|------|---------|
| `off` | ソケット無効 | Settings UI または `CMUX_SOCKET_MODE=off` |
| `cmux processes only`（デフォルト） | cmux 内で起動したプロセスのみ接続可 | Settings UI |
| `allowAll` | ローカルプロセスなら任意に接続可 | `CMUX_SOCKET_MODE=allowAll` |

## 利用可能なメソッド一覧

### ワークスペース管理
| メソッド | 説明 |
|---------|------|
| `workspace.list` | 全ワークスペース列挙 |
| `workspace.create` | 新規ワークスペース作成 |
| `workspace.select` | ワークスペース切り替え |
| `workspace.current` | 現在のワークスペース取得 |
| `workspace.close` | ワークスペース閉鎖 |

### スプリット/サーフェース
| メソッド | 説明 |
|---------|------|
| `surface.split` | 分割ペイン作成（direction: left/right/up/down） |
| `surface.list` | 現ワークスペースのサーフェース列挙 |
| `surface.focus` | サーフェースにフォーカス |

### 入力制御
| メソッド | 説明 |
|---------|------|
| `surface.send_text` | テキスト入力送信 |
| `surface.send_key` | キープレス送信（enter/tab/escape 等） |

### 通知
| メソッド | 説明 |
|---------|------|
| `notification.create` | 通知送信 |
| `notification.list` | 全通知列挙 |
| `notification.clear` | 全通知クリア |

### ユーティリティ
| メソッド | 説明 |
|---------|------|
| `system.ping` | 疎通確認 |
| `system.capabilities` | 利用可能メソッド一覧と現在のアクセスモード |
| `system.identify` | フォーカス中のウィンドウ/ワークスペース/サーフェース情報 |

## 環境変数

| 変数 | 説明 |
|------|------|
| `CMUX_SOCKET_PATH` | ソケットパスオーバーライド |
| `CMUX_SOCKET_ENABLE` | ソケット強制有効/無効（1/0, true/false, on/off） |
| `CMUX_SOCKET_MODE` | アクセスモードオーバーライド |
| `CMUX_WORKSPACE_ID` | 現在のワークスペース ID（起動プロセスに自動設定） |
| `CMUX_SURFACE_ID` | 現在のサーフェース ID（起動プロセスに自動設定） |
| `TERM_PROGRAM` | ghostty に設定 |
| `TERM` | xterm-ghostty に設定 |

## CLI オプション（全コマンド共通）

| フラグ | 説明 |
|--------|------|
| `--socket PATH` | カスタムソケットパス |
| `--json` | JSON 形式出力 |
| `--window ID` | 特定ウィンドウをターゲット |
| `--workspace ID` | 特定ワークスペースをターゲット |
| `--surface ID` | 特定サーフェースをターゲット |
| `--id-format refs\|uuids\|both` | JSON 出力の識別子形式制御 |

## ブラウザ自動化（cmux browser コマンド群）

cmux の組み込みブラウザに対してプログラマティックに操作できる。

### 1. ナビゲーション
`identify`, `open`, `open-split`, `navigate`, `back`, `forward`, `reload`, `url`, `focus-webview`, `is-webview-focused`

### 2. 待機
`wait` — セレクター・テキスト・URL・ロード状態・JavaScript 条件が満たされるまでブロック

### 3. DOM 操作
`click`, `dblclick`, `hover`, `focus`, `check`, `uncheck`, `scroll-into-view`, `type`, `fill`, `press`, `keydown`, `keyup`, `select`, `scroll`

> `--snapshot-after` フラグで操作後の状態を即時検証できる

### 4. 検査
`snapshot`, `screenshot`, `get`, `is`, `find`, `highlight`

`get` のサブコマンド: `title`, `url`, `text`, `html`, `value`, `attr`, `count`, `box`, `styles`

`find` のアクセシビリティクエリ: `role`, `text`, `label`, `placeholder`, `alt`, `title`, `testid`, `first`, `last`, `nth`

### 5. JavaScript 実行・注入
`eval`, `addinitscript`, `addscript`, `addstyle`

### 6. フレーム・ダイアログ・ダウンロード
`frame`, `dialog`, `download`

### 7. 状態・セッションデータ
`cookies`（get/set/clear）, `storage`（local/session）, `state`（save/load）

### 8. タブ・ログ
`tab`, `console`, `errors`

#### 使用例

```bash
# ナビゲーション
cmux browser open https://example.com
cmux browser surface:2 navigate https://example.org/docs --snapshot-after

# 待機
cmux browser surface:2 wait --load-state complete --timeout-ms 15000
cmux browser surface:2 wait --selector "#checkout" --timeout-ms 10000

# DOM 操作
cmux browser surface:2 click "button[type='submit']" --snapshot-after
cmux browser surface:2 fill "#email" --text "user@example.com"

# JavaScript
cmux browser surface:2 eval "document.title"

# Cookie 管理
cmux browser surface:2 cookies get
cmux browser surface:2 cookies set session_id abc123 --domain example.com

# セッション保存
cmux browser surface:2 state save /tmp/session.json
cmux browser surface:2 state load /tmp/session.json
```

## 通知送信方法

### CLI
```bash
cmux notify --title "Task Complete" --body "Your build finished"
```

### OSC 777（RXVT 互換）
```bash
printf '\e]777;notify;My Title;Message body here\a'
```

### OSC 99（Kitty プロトコル、リッチ通知）
サブタイトルと通知 ID をサポート。複数行で送信可能。

## Socket API 直接呼び出し例

### Python
```python
import socket, json

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect("/tmp/cmux.sock")
req = json.dumps({"id": "req-1", "method": "workspace.list", "params": {}}) + "\n"
sock.sendall(req.encode())
data = sock.recv(4096)
print(json.loads(data))
```

### Shell（nc）
```bash
echo '{"id":"req-1","method":"workspace.list","params":{}}' | nc -U /tmp/cmux.sock
```

## cmux-team への活用可能性

| 現在の実装 | Socket API で改善できる点 |
|-----------|--------------------------|
| `cmux tree` CLI 呼び出し | `surface.list` + `workspace.list` で直接取得 |
| `cmux send` CLI 呼び出し | `surface.send_text` / `surface.send_key` で直接送信 |
| `cmux list-status` でステータス確認 | `system.identify` で現在状態を取得 |
| ブラウザ操作は未実装 | `cmux browser` コマンド群で自動化可能 |

**注意**: cmux-team の現実装は CLI ラッパー（`cmux.ts`）で全操作を行っているが、Socket API を直接使えばプロセス起動コストを省けて高速化できる可能性がある。ただし、CLI 経由の方が安定性・メンテナンス性が高いため、安易に切り替えるべきではない。

## Changelog から判明した履歴

- **v0.63.0**: `cmux tree` に per-surface TTY 追加、`set-color`/`clear-color` ワークスペースアクション
- **v0.60.0**: `rename-tab` ソケットコマンド追加
- **v0.53.0**: index ベース CLI API 廃止 → short ID refs（`surface:1`, `pane:2`）に統一、`CMUX_WORKSPACE_ID` 環境変数導入
