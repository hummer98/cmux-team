# タスク割り当て

## タスク内容

---
id: 138
title: conductor-role.md に /exit 禁止を明記する
priority: high
created_at: 2026-04-10T19:22:09.910Z
---

## タスク
## 背景

Dear プロジェクトで Conductor (surface:35) が T114 完了後に自発的に `/exit` を実行し、セッションが終了した。
Conductor は常駐セッションであり、タスク完了後も生き続けて次のタスク割り当てを待つのが正しい動作。

CLAUDE.md・メモリ・settings に汚染はなく、Claude が「タスク完了 → セッション終了」と自発的に推論した結果。
conductor-role.md には最初のバージョンから /exit 禁止が書かれていなかった（仕様の穴）。

## 修正内容

`skills/cmux-team/templates/conductor-role.md` に以下2箇所を追加:

### 1. 完了時の処理 ステップ9 を強化

現在:
> 9. **❯ プロンプトに戻る。次のタスクの割り当てを待つ。** daemon がリセット処理（`/clear` 送信）を行う。

変更後（/exit 禁止を明記）:
> 9. **❯ プロンプトに戻る。次のタスクの割り当てを待つ。** daemon がリセット処理（`/clear` 送信）を行う。**`/exit` でセッションを終了してはならない。Conductor は常駐セッションであり、タスク完了後もセッションを維持すること。**

### 2. 「やらないこと（厳守）」セクションに追加

> - **`/exit` でセッションを終了する** — Conductor は常駐セッション。タスク完了後は ❯ プロンプトで待機し、daemon の `/clear` を待つ


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-138-1775848929` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-138-1775848929
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-138-1775848929/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/138-conductor-role-md-exit/runs/task-138-1775848929
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/138-conductor-role-md-exit/runs/task-138-1775848929/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
