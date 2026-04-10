# タスク割り当て

## タスク内容

---
id: 147
title: T146 cmux-team-guide スキルを skill-creator で検閲する
priority: medium
depends_on: [146]
created_at: 2026-04-10T22:36:35.274Z
---

## タスク
## 目的

T146 で作成された cmux-team-guide スキルの品質をskill-creatorの観点でレビューする。

## やること

1. T146 で作成された cmux-team-guide スキル（skills/ 配下）を読み込む
2. 以下の観点でレビュー:
   - スキルの description がトリガー条件として適切か
   - 蒸留された情報が docs/spec/ の内容と整合しているか
   - ユーザーが聞きそうな質問に答えられる網羅性があるか
   - 過剰な情報が含まれていないか（トークン効率）
   - SKILL.md のフォーマット・構造が他スキルと一貫しているか
3. 問題があれば修正する

## 参考

- 既存スキル: skills/cmux-team/SKILL.md, skills/cmux-agent-role/SKILL.md
- 仕様書: docs/spec/*.md
- README: README.md, README.ja.md


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-147-1775861063` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-147-1775861063
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-147-1775861063/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/147-t146-cmux-team-guide-skill-creator/runs/task-147-1775861063
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/147-t146-cmux-team-guide-skill-creator/runs/task-147-1775861063/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
