# タスク割り当て

## タスク内容

---
id: 294
title: auto-update の task モード廃止（notify のみ残す）
priority: medium
created_at: 2026-04-22T01:52:03.885Z
---

## タスク
## 問題

- `autoUpdate` のデフォルトは OFF で、有効にしても副作用リスク（Volta/nvm で意図しない Node に入る等）があり、推奨機能になっていない
- 中身は `npm install -g` 1発で、4層アーキテクチャに流す意義が薄い
- `self-update` コマンド、`cmux-team-update` kind の特別扱い、update タスクの heredoc プロンプトなど保守対象だけが積み上がっている
- 後続の「close-task 納品物明示強制化」において kind 分類の例外になる（`none` に寄せる必要がある）

## 修正内容

1. `autoUpdate` を `off | notify` の2値に縮約。`task` / `true` / `1` は破壊的に削除し、後方互換の legacy マッピングも撤去
2. `task` モード時の update タスク自動起票ロジックを削除（`daemon.ts` の `maybeScheduleUpdateTask` 等、既存 open タスク検出・`kind: cmux-team-update` skip ロジック含む）
3. CLI サブコマンド `cmux-team self-update` を削除（`cmdSelfUpdate`）
4. `notify` モードで TUI バナー表示（dashboard 側での表示、または update-notifier の標準バナー活用）
5. `kind: cmux-team-update` 特別扱いコードの削除（`task.ts` の kind コメント含む）
6. ドキュメント更新: CLAUDE.md の auto-update 節、README.md / README.ja.md、`docs/spec/` 該当ファイル

## 対象ファイル

- `skills/cmux-team/manager/daemon.ts`（update タスク起票ロジック、L3425〜3570 付近）
- `skills/cmux-team/manager/main.ts`（cmdSelfUpdate L4159〜, switch ケース L4711, resolveAutoUpdateMode 呼び出し）
- `skills/cmux-team/manager/schema.ts`（AutoUpdateMode 型から "task" / boolean を削除）
- `skills/cmux-team/manager/config.ts`（normalizeAutoUpdate, resolveAutoUpdateMode）
- `skills/cmux-team/manager/task.ts`（kind フィールドのコメント）
- `skills/cmux-team/manager/dashboard.tsx`（L346〜349 の legacy 表示、バナー）
- `skills/cmux-team/manager/main.test.ts`（L286〜397 の resolveAutoUpdateMode / normalizeAutoUpdate テスト）
- `skills/cmux-team/manager/daemon.test.ts`（L1408 付近の cmux-team-update kind テスト）
- `CLAUDE.md`（「auto-update（デフォルト OFF、3モード）」節）
- `docs/spec/` 該当ファイル

## 破壊的変更

- `CMUX_TEAM_AUTO_UPDATE=task` / `=1` / `=true` がエラーになる（`notify` / `off` / `0` / `false` のみ受理）
- `.team/config.json` の `autoUpdate: "task"` / `true` がエラーになる
- `cmux-team self-update` コマンドが消える

## 納品形態

この作業自体の納品は「ローカル feature ブランチを main に ff-only マージ」を想定（ff-only 失敗時は Conductor の標準エスカレーション経路）。

## 関連

- 後続: close-task 納品物明示強制化（このタスク完了後に着手）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-294-1776822723` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-294-1776822723
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-294-1776822723/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/294-auto-update-task-notify/runs/task-294-1776822723
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/294-auto-update-task-notify/runs/task-294-1776822723/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
