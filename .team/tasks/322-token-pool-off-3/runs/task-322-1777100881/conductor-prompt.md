# タスク割り当て

## タスク内容

---
id: 322
title: token pool 機能 OFF 設定の 3 階層実装
priority: medium
created_at: 2026-04-24T22:42:03.278Z
---

## タスク
## 概要

token pool 機能の有効/無効を 3 階層（env / project / global）で制御できるようにする。

依存: T321（spawn-agent selection ロジック）

## 優先順位（高 → 低）

1. **環境変数** `CMUX_TEAM_TOKEN_POOL=0` — 最優先、CI や一時的な無効化に使う
2. **プロジェクト設定** `.team/config.json` の `token_pool.enabled: false`
3. **グローバル設定** `~/.cmux-team/config.yaml` の `token_pool.enabled: true`
4. 未指定時は **false（opt-in）**

## 実装内容

- `isTokenPoolEnabled(projectRoot: string): boolean` 関数を実装
  - 上記の優先順位で評価して boolean を返す
- `cmdSpawnAgent` の冒頭で `isTokenPoolEnabled()` を呼び、false なら selection をスキップ
- `cmux-team start` の初期化ログに pool の有効/無効を出力

## 検証

- `CMUX_TEAM_TOKEN_POOL=0` で無効になること
- `.team/config.json: { "token_pool": { "enabled": false } }` で無効になること
- `~/.cmux-team/config.yaml: token_pool: { enabled: true }` + 他設定なし で有効になること
- 未設定時は無効（env 継承 fallback と同じ挙動）になること


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-322-1777100881` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-322-1777100881
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-322-1777100881/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/322-token-pool-off-3/runs/task-322-1777100881
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/322-token-pool-off-3/runs/task-322-1777100881/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
