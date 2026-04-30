# タスク割り当て

## タスク内容

---
id: 313
title: README に npm バッジ（version / 月間DL / 総DL）を追加
priority: low
created_by: surface:969
created_at: 2026-04-24T12:59:04.467Z
---

## タスク
## 目的

README.md / README.ja.md に npm 関連の shields.io バッジを追加し、現在の公開バージョンとダウンロード数が一目で見えるようにする。

## 追加するバッジ

npm パッケージ名は **`@hummer98/cmux-team`**（scoped）。既存の License バッジと同じ行に 3 つ追加する:

```markdown
[![npm version](https://img.shields.io/npm/v/@hummer98/cmux-team.svg)](https://www.npmjs.com/package/@hummer98/cmux-team)
[![npm downloads](https://img.shields.io/npm/dm/@hummer98/cmux-team.svg)](https://www.npmjs.com/package/@hummer98/cmux-team)
[![npm total downloads](https://img.shields.io/npm/dt/@hummer98/cmux-team.svg)](https://www.npmjs.com/package/@hummer98/cmux-team)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
```

順番は **version → monthly DL → total DL → License** を推奨（公開状況 → 利用状況 → ライセンスの流れ）。

## 変更対象

1. `README.md` — L5 付近の License バッジ行を上記 4 バッジに差し替え
2. `README.ja.md` — 同箇所を同じフォーマットで差し替え

両ファイルで**バッジ行が完全に一致する**ことを確認（URL・順序とも）。

## 確認方法

- `grep -n "shields.io" README.md README.ja.md` で同じ 4 行が並ぶことを確認
- GitHub 上で rendering を目視確認するのは後回しでよい（URL が正しければ shields.io 側でレンダーされる）

## 補足

- scoped package の DL 統計は npm 側の集計に遅延がある。publish 直後は `dm`/`dt` が 0 や "unknown" になることがあるが、バッジ URL 自体は正しいのでそのまま追加する
- このタスクではバージョンバンプやリリースは行わない（次回 release 時にバッジ付き README が公開される）

## 受け入れ条件

- README.md / README.ja.md 両方にバッジ 4 つが表示される
- バッジ URL / 順序が両ファイルで一致する
- 既存の見出し・本文に影響なし


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-313-1777035544` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-313-1777035544
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-313-1777035544/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/313-readme-npm-version-dl-dl/runs/task-313-1777035544
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/313-readme-npm-version-dl-dl/runs/task-313-1777035544/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
