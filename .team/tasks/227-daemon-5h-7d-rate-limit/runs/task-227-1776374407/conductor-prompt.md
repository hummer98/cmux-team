# タスク割り当て

## タスク内容

---
id: 227
title: daemon 再起動時に最後の 5h/7d rate limit を復元する
priority: medium
created_at: 2026-04-16T21:19:52.119Z
---

## タスク
## 背景

daemon の `state.rateLimit` は `RateLimitInfo | null` で in-memory のみに保持されており、`cmux-team start` で再起動すると null にリセットされる。次に API 応答が来るまで dashboard の 5h/7d 使用率バーが表示されない。

該当コード:
- `skills/cmux-team/manager/daemon.ts:73` — `rateLimit: RateLimitInfo | null`（型定義）
- `skills/cmux-team/manager/daemon.ts:226` — 初期値 null
- `skills/cmux-team/manager/proxy.ts:325, 360` — API 応答ヘッダーから更新
- `skills/cmux-team/manager/dashboard.tsx:228` `buildRateLimitDisplay()` — 表示

## ゴール

daemon 再起動後も、直前セッションで取得した最後の 5h/7d 使用率・リセット時刻が TUI に表示される。

## 方針（検討してほしい点）

1. **永続化先**: `.team/` 配下のどこに保存するのが適切か（例: `.team/rate-limit.json`, `.team/logs/` の一部, `task-state.json` 方式に倣った独自ファイル）
2. **書き込みタイミング**: proxy.ts で rateLimit を更新する度 or graceful shutdown 時のみ or 定期フラッシュ
3. **読み込みタイミング**: daemon boot で load → `state.rateLimit` に注入
4. **古いデータの扱い**: `unified5hReset` / `unified7dReset` は epoch 秒。リセット時刻を既に過ぎている場合の表示をどうするか（破棄 / そのまま stale 表示 / 「直前値」ラベル付き表示）
5. **unifiedStatus**（rate_limited 等の一過性ステータス）は復元するか、破棄するか

## 関連

- `schema.ts` の `RateLimitInfo` 型にそのまま JSON シリアライズ可能か確認
- `dashboard.tsx:918` の throttled 判定にも影響する可能性（古い値で throttled と誤判定しないか）

## 受け入れ条件

- daemon を一度起動→API 応答で rateLimit を更新→stop→再度 start の直後、`cmux-team status` ないし TUI に直前の 5h/7d 値が表示される
- reset 時刻を過ぎた値の表示方針が docs/spec に反映されている（もしくはコメントに明記）
- API プロキシが新しい応答を受け取った時点で上書きされることを確認


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-227-1776374407` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-227-1776374407
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-227-1776374407/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/227-daemon-5h-7d-rate-limit/runs/task-227-1776374407
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/227-daemon-5h-7d-rate-limit/runs/task-227-1776374407/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
