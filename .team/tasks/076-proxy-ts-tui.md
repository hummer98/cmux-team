---
id: 076
title: proxy.ts にレート制限ヘッダー記録を追加し TUI 右上にトークン残量 % 表示
priority: medium
created_at: 2026-04-04T13:47:25.663Z
---

## タスク
## 背景

cmux-team は複数エージェントを同時実行するため API レート制限に当たりやすい。現在 proxy.ts は全リクエストを SQLite に記録しているが、レスポンスヘッダーのレート制限情報は保存していない。

## ゴール

1. proxy.ts で Anthropic API レスポンスのレート制限ヘッダーを記録する
2. TUI ダッシュボードの右上にトークン残量を % で表示する

## 変更内容

### 1. proxy.ts: レート制限ヘッダーの記録

Anthropic API レスポンスの以下のヘッダーを取得・保存:
- anthropic-ratelimit-tokens-remaining（残りトークン数、分単位ウィンドウ）
- anthropic-ratelimit-tokens-limit（トークン上限）
- anthropic-ratelimit-tokens-reset（リセット時刻）
- anthropic-ratelimit-input-tokens-remaining
- anthropic-ratelimit-output-tokens-remaining

### 2. daemon への残量データ伝達

proxy.ts → daemon 間でレート制限情報を共有:
- 案A: .team/rate-limit.json にファイル書き出し（シンプル）
- 案B: HTTP API に GET /api/rate-limit エンドポイント追加

### 3. dashboard.tsx: 右上にトークン残量 % 表示

TUI ダッシュボードのヘッダー領域（右上）に表示:
  Tokens: 85% ████████░░

- remaining / limit * 100 で % 算出
- 色分け: 50%以上=green, 20-50%=yellow, 20%未満=red
- データ取得できない場合は Tokens: -- と表示

### 4. 表示更新タイミング

- proxy.ts がリクエストを処理するたびにレート制限情報を更新
- TUI は既存の polling/debounce サイクルで読み取り

## 参考ツール
- ccflare (https://github.com/snipeship/ccflare) - 同様の proxy 型アプローチ
- claude-meter (https://github.com/abhishekray07/claude-meter) - レート制限ヘッダー解析

## 注意
- レート制限ヘッダーは分単位ウィンドウの残量であり、月間/週間残量ではない
- 表示ラベルで誤解を防ぐこと（例: Rate や TPM）
