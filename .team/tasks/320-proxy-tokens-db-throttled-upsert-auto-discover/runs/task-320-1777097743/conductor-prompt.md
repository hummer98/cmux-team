# タスク割り当て

## タスク内容

---
id: 320
title: proxy: tokens.db throttled UPSERT + auto-discover
priority: high
created_at: 2026-04-24T22:41:33.478Z
---

## タスク
## 概要

proxy.ts が Anthropic API レスポンスを受け取った際に、`~/.cmux-team/tokens.db` の `usage_snapshots` を throttled UPSERT する。
また、未登録アカウントを検出した場合は auto-discover 登録を行う。

依存: tokens.db schema + Keychain + CRUD ライブラリ（T318）

## 設計根拠

`.team/artifacts/A019-token-pool-design.md` / `A020-token-pool-probe.md` 参照。

## 実装内容

### 1. auth_hash の算出

- `proxy.ts` の fetch 呼び出し直前（`proxy.ts:425-439` 付近）で Authorization header を取得
- `sha256("Bearer " + token)` を計算し 12 文字 prefix を auth_hash として保持
- この auth_hash をリクエスト処理の context に持ち回す

### 2. usage_snapshots への throttled UPSERT

既存の `api_usage` INSERT とは別に、以下の条件でのみ `tokens.db` を更新（書き込み頻度を抑制）:
- `util_5h` または `util_7d` が前回値から 1pt（0.01）以上変化した場合
- `reset_5h_at` または `reset_7d_at` が変化した場合
- `unified_status` が変化した場合

既存の `.team/traces/traces.db` への api_usage INSERT は**変更しない**。

### 3. auto-discover

`auth_hash` が tokens.db に存在しない場合:
- `anthropic-organization-id` レスポンスヘッダーを取得
- tokens.db に INSERT:
  - `handle` = organization_id 先頭 4 文字（衝突時は 5, 6 文字と伸長）
  - `selectable = 0`, `tags = ["auto"]`, `plan = "unknown"`, `credential_source = "auto-discover"`
- 実 token は Keychain に**登録しない**（selectable=0 なので spawn には使われない）

### 4. tokens.db への接続管理

複数 cmux-team プロジェクトが同時に書き込む可能性があるため WAL モードを確認。
単一プロセス内では DB ハンドルを singleton として保持。

### 配置

- `skills/cmux-team/manager/proxy.ts`（既存ファイルへの追加）
- token-store.ts の CRUD 関数を呼び出す

## 検証

- Agent 実行後に `~/.cmux-team/tokens.db` の `usage_snapshots` に行が増えること
- utilization が変化しない場合は UPSERT されないこと（throttle が効いていること）
- auto-discover: 未登録 token で動作した場合に `selectable=0` のレコードが作成されること
- 既存の `.team/traces/traces.db` api_usage は変化しないこと
- `bun test` + `tsc --noEmit` が通ること


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-320-1777097743` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-320-1777097743
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-320-1777097743/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/320-proxy-tokens-db-throttled-upsert-auto-discover/runs/task-320-1777097743
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/320-proxy-tokens-db-throttled-upsert-auto-discover/runs/task-320-1777097743/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
