---
id: 030
title: Proxy を Manager ライフサイクルから分離し再起動時に接続を維持する
priority: high
created_at: 2026-03-30T07:47:16.750Z
---

## タスク
## 問題

Manager quit → start すると proxy が停止→再起動される。
既存の Master/Conductor セッションは ANTHROPIC_BASE_URL が古い proxy ポートを指したままになり、API 通信が切れる。

## 解決方針

proxy を Manager ライフサイクルから分離する:

1. Manager shutdown 時に proxy を stop() しない（分離）
2. Manager start 時に .team/proxy-port を読み取り、そのポートで既に proxy が生きていれば再利用する
3. proxy が死んでいる場合のみ新規起動（同じポートを優先）

### 変更対象ファイル

- skills/cmux-team/manager/main.ts: shutdown() から proxyHandle.stop() を除去。起動時に既存 proxy の生存確認を追加
- skills/cmux-team/manager/proxy.ts: 既存プロセスとの共存ロジック（ポート使用中なら起動スキップ）

### 注意点

- cmux-team stop（完全停止）時は proxy も停止する必要がある
- quit（ダッシュボード q キー）と stop を区別する
