# タスク割り当て

## タスク内容

---
id: 282
title: Update通知バナーが null のとき空 text を返すのをやめる（空白行除去）
priority: low
created_by: surface:427
created_at: 2026-04-20T22:10:24.748Z
---

## タスク
## 問題

TUI ダッシュボードのヘッダー直下に、常時 1 行の空白行が残っている。

## 原因

`skills/cmux-team/manager/dashboard.tsx:1163-1179` の Update 通知バナー実装で、`daemon.updateAvailable` が null のときも `ui.text("", { dim: true })` で**空の text 要素**を返している。`ui.column({ gap: 0 }, [...])` 内に空 text 要素が含まれるため、1 行分のスペースが常に占有される。

最新版で稼働している間（= 大半の時間）はずっと空行だけが残る UX。

## 修正内容

`dashboard.tsx` で Update バナー要素を組み立てる IIFE をやめ、`updateAvailable` が非 null のときだけ ui 要素を配列に含めるように書き換える。具体的には配列 spread で条件付き挿入:

```tsx
...(daemon.updateAvailable ? [buildUpdateBanner(daemon)] : []),
```

などの形にして、null のときは何も挿入しないようにする。

## 対象ファイル

- `skills/cmux-team/manager/dashboard.tsx` （1163-1179 付近）

## 確認方法

1. 最新版で `cmux-team start` → ヘッダー (`─ cmux-team v4.1.0 ...`) の直下が空行を挟まず `─ Master ─` セクションに続くこと
2. `state.updateAvailable` を手動で設定したユニットテスト or デバッグで、バナーが正しく表示されること（既存の表示経路は維持）
3. `notify` / `task` 両モードで実機確認できるとなお良い（任意）

## 優先度

low — 機能影響なし、見た目の改善のみ。


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-282-1776723042` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-282-1776723042
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-282-1776723042/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/282-update-null-text/runs/task-282-1776723042
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/282-update-null-text/runs/task-282-1776723042/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
