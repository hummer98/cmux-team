# タスク割り当て

## タスク内容

---
id: 250
title: Conductor に broken 状態を導入し、エラーステートを idle に戻さない
priority: high
created_by: surface:47
created_at: 2026-04-17T18:25:41.371Z
---

## タスク
## 背景

A015（フォールバック動作の設計方針）の実装タスク (c) エラーステート喪失。

現状、`forceCloseDisconnectedConductor` → `resetConductor` で
disconnected が自動的に idle に戻り、エラーがあったこと自体が
追跡不能になる。直近の事例:

- surface 112/113 が PID 死亡 → disconnected → timeout → idle 化
- 次タスクに再利用されて問題がループ

## やること

1. ConductorState の status に `broken` を追加（schema.ts 更新）
2. `forceCloseDisconnectedConductor` (`daemon.ts:2157` 付近) を
   idle 化せず broken 状態で保持するよう変更
3. broken 状態の Conductor は次タスクの割当対象から除外する
   （assignTask の候補から外す）
4. ダッシュボード / status 出力で broken を可視化
5. ユーザーが明示的にクリアする CLI を追加:
   `cmux-team clear-conductor --surface <id>` または
   既存の `restart-task` / `abort-task` パスから明示的に reset

## 判断が必要なポイント

- broken からの回復経路: ユーザーが pane を手動で立て直した場合に
  自動検出して idle に戻すか、常に明示操作を要求するか
- PID 監視は broken 状態でも継続するか（可視化のため継続が望ましい）
- 既存の disconnected との違いを明確化（disconnected = 一時的な通信断、
  broken = 確定した異常状態）

## 参考

- A015 「決定」セクション 2 項
- CLAUDE.md 「エラーリカバリ」
- memory `feedback_error_recovery`


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-250-1776455800` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-250-1776455800
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-250-1776455800/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/250-conductor-broken-idle/runs/task-250-1776455800
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/250-conductor-broken-idle/runs/task-250-1776455800/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」Step 12 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
