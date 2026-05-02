# タスク割り当て

## タスク内容

---
id: 381
title: baseline 定期 snapshot 自動収集 + cohort 比較ツール
priority: medium
depends_on: [379]
created_at: 2026-04-29T01:09:29.074Z
---

## タスク
## 背景

T379 で実装する \`cmux-team metrics\` サブコマンドを使い、baseline period (CodeDNA 投入前) の計測を **連続的に** 蓄積する仕組みを構築する。日次 snapshot を artifact として記録し、4 週後に時系列 trend を分析できる状態にする。

背景・全体計画は **GitHub issue #44** 参照。

## やること

### 1. 日次 snapshot 自動収集

以下のいずれか (タスク内で運用観点から判断):

**案 A: cron / launchd**
- ホスト OS の cron / launchd で 1 日 1 回実行
- \`cmux-team metrics --since 1d --format json > .team/artifacts/Axxx-metrics-YYYYMMDD.md\`

**案 B: daemon 内 scheduled writer**
- \`skills/cmux-team/manager/\` 配下に scheduled job として実装
- daemon 起動中のみ動作 (落ちている時間は欠損)

→ 案 A が運用しやすければそちら。daemon の生存依存を避けたい

snapshot ファイルは \`.team/artifacts/Axxx-metrics-YYYYMMDD.md\` 命名 (artifact 通常 frontmatter 付き)。

### 2. cohort 比較ツール

\`cmux-team metrics --compare baseline:<period> codedna:<period>\` サブオプションを実装:

- 2 期間の per-task / 期間集計を並べる
- diff (% change) を表示
- 統計検定 (t-test or Wilcoxon) で有意性判定
- T380 spec で定義した警報閾値と照合し、撤退判定の signal を出力

### 3. baseline 期間の運用ガイド

\`docs/spec/11-metrics.md\` (T380 成果物) または artifact に以下を記録:

- baseline 開始日時 (本タスク完了後の最初の月曜)
- baseline 期間: 4 週
- evaluation 期間: CodeDNA 投入後 4 週 → 8 週 → 12 週
- 両期間とも task 件数と稼働時間を artifact に記録

## Done 判定

- 日次 snapshot が連続収集を開始 (最初の 1 日分の artifact が生成される)
- cohort 比較ツールが動作し、2 期間の diff + 統計検定結果を出力
- baseline 開始日時が docs に記録される
- 自動収集が落ちた場合の検知方法が決まっている (manager.log or 別 alert)

## 関連

- GitHub issue: https://github.com/hummer98/cmux-team/issues/44
- T379: metrics CLI 実装 (depends)
- T380: spec (本タスクと並行可能)


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-381-1777565435` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-381-1777565435
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-381-1777565435/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/381-baseline-snapshot-cohort/runs/task-381-1777565435
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/381-baseline-snapshot-cohort/runs/task-381-1777565435/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
