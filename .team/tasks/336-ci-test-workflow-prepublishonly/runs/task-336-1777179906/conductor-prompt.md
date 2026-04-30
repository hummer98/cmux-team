# タスク割り当て

## タスク内容

---
id: 336
title: CI test workflow を整備（prepublishOnly 削除の埋め合わせ）
priority: medium
created_by: surface:42
created_at: 2026-04-26T00:16:54.850Z
---

## タスク
T334 のリリース作業で v4.9.0 が npm OIDC publish 段階で 30 分以上 hang した。原因は package.json の prepublishOnly = "cd skills/cmux-team/manager && bun test" が GHA Publish ステップの暗黙トリガーで全体実行され、A021（T327）に記録された bun test 全体実行 O(N^2) 級劣化問題に常時引っかかっていたこと。v4.9.1 では prepublishOnly を削除して release を通したが、これでリリース時のテスト実施ポイントが消えた。

## やること

PR / main push trigger で bun test を回す独立 GitHub Actions workflow を新設する。release.yml の Publish ステップとは独立させる（リリースを test の hang で詰まらせない）。

## 技術メモ

- bun test 全体実行は A021 で記録された O(N^2) 級劣化問題があり 13 分以上 hang する
- 暫定回避策（A021 §再現手順 5）: 個別ファイル iteration（`for f in *.test.ts state-machine/*.test.ts; do bun test "$f"; done`）なら 68 秒で全 pass
- CI 上では `--reporter=dots` も併用すると進捗が見える
- root cause（module-level singleton 累積疑い）の解消は別タスク

## 完了条件

- `.github/workflows/test.yml` 等で PR / main push 時に bun test が走る
- CI 経過時間が安定（5 分以内目標）
- 失敗時にちゃんと fail する（暫定回避ループでも個別ファイル fail を集約）
- `bun test` 全体実行は禁忌として README/CLAUDE.md に追記してよい

## 関連

- A021（T327）: bun test 全体実行ハング調査
- T334: v4.9.1 リリース（このタスクの起源）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-336-1777179906` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-336-1777179906
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-336-1777179906/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/336-ci-test-workflow-prepublishonly/runs/task-336-1777179906
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/336-ci-test-workflow-prepublishonly/runs/task-336-1777179906/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
