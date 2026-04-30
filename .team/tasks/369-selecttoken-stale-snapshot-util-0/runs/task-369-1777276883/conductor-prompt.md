# タスク割り当て

## タスク内容

---
id: 369
title: selectToken: stale snapshot のリセット済み軸を util=0 として候補化
priority: medium
created_at: 2026-04-27T07:38:53.277Z
---

## タスク
## 問題

`selectToken` はスナップショットが30分以上未更新（stale）のトークンを丸ごと候補から除外している。
しかし `reset_5h_at` / `reset_7d_at` はスナップショットに記録されており、リセット時刻を過ぎた軸の utilization はすでに 0 にリセットされているはずなので、候補から外すのは過剰。

実例: @kami のスナップショットが50分前で stale 判定 → 候補外。実際には util_5h=1%, util_7d=14% で最も余裕があり、本来最優先で選ばれるべきだった。

## 変更方針

`selectToken` の stale 除外ロジックを以下に変更する:

1. stale（30分超未更新）かつ **reset_5h_at が現在時刻より過去** → util_5h = 0 に上書き
2. stale かつ **reset_7d_at が現在時刻より過去** → util_7d = 0 に上書き
3. stale かつ 5h/7d 両方ともリセット時刻が未来 → 従来通り除外（古い値が信用できない）
4. 上書き後のutil値でブロッカー判定（util_5h > 0.95）・スコア計算（0.3×5h + 0.7×7d）を実行

## 期待効果

長時間使われていないトークンがリセット時刻経過後に自動的に候補化される。
pool内に余裕のあるトークンがあれば適切に選ばれるようになる。


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-369-1777276883` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-369-1777276883
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-369-1777276883/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/369-selecttoken-stale-snapshot-util-0/runs/task-369-1777276883
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/369-selecttoken-stale-snapshot-util-0/runs/task-369-1777276883/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
