# タスク割り当て

## タスク内容

---
id: 356
title: loadPoolSummary 失敗時にログ/CLI メッセージを残す（T351 minor follow-up）
priority: medium
created_by: surface:122
created_at: 2026-04-26T22:04:17.326Z
---

## タスク
## 背景

T351 で `cmdStatus` の旧 in-line ロジックを `loadPoolSummary` (`pool-summary.ts`) に集約した際、旧コード (旧 main.ts:1485-1487) の `console.log("(token pool read failed: ${e?.message ?? e})")` が消失し、現状は `pool-summary.ts:125-129` の catch で silent に `null` を返している。

daemon 側の `refreshPoolSnapshot` は `log("error", ...)` で manager.log に残るが、CLI (`cmux-team status`) 側では tokens.db 破損や読み取り失敗を区別できない。

## やること

- `loadPoolSummary` の catch 節に optional callback `onError?: (e: Error) => void` を生やすか、throw 切替で CLI 側に握らせる
- CLI 側 `cmdStatus` で旧挙動相当の `console.log` を復元
- 動作 / 単体テスト (case: tokens.db 破損 → CLI に warning メッセージ)

## 関連

- T351 inspection.md §指摘事項 1
- 旧 `main.ts:1485-1487` (T351 commit 935b2a3 で削除)
- `skills/cmux-team/manager/pool-summary.ts:125-129`


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-356-1777571586` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-356-1777571586
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-356-1777571586/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/356-loadpoolsummary-cli-t351-minor-follow-up/runs/task-356-1777571586
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/356-loadpoolsummary-cli-t351-minor-follow-up/runs/task-356-1777571586/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
