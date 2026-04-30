# タスク割り当て

## タスク内容

---
id: 309
title: Metrics タブから重複する「統合（5h/7d）」セクションを削除
priority: medium
created_by: surface:969
created_at: 2026-04-24T08:17:22.235Z
---

## タスク
## 背景

Metrics タブの「統合（5時間 / 7日）」セクション（`dashboard-metrics.ts:317-331`）は、ヘッダー右端の `buildRateLimitDisplay`（`rate-limit-display.ts`）が出している `5h: 45% ██████░░░░ 2h3m` / `7d: 20% ██░░░░░░░░ 5d` と情報が重複している。しかも Metrics 側はパーセントのみで、バー・reset 時間・stale 判定が落ちた**劣化表示**になっている。

Metrics タブの本質はヘッダーに載せきれない detail（burn rate・role/task 別消費）なので、このセクションは削除する。

## 変更対象

1. **`skills/cmux-team/manager/dashboard-metrics.ts`**
   - L317-331 の unified セクション描画ブロックを削除
   - `MetricsData` interface の `unifiedFive` / `unifiedSeven` / 関連 JSDoc（L49-52）を削除

2. **`skills/cmux-team/manager/dashboard.tsx`**
   - L1830-1831 および L1871-1872 の `unifiedFive` / `unifiedSeven` の代入を削除

3. **`skills/cmux-team/manager/i18n.ts`**
   - `metrics_section_unified` キーを en（L786）/ ja（L1569）両方から削除

4. **`skills/cmux-team/manager/dashboard-metrics.test.tsx`**
   - テストフィクスチャから `unifiedFive: 0.4,` / `unifiedSeven: 0.2,`（L40-41）を削除
   - 他に assertion で unified 文言を参照していないか確認（現状 grep では該当なし）

## 受け入れ条件

- `bun test` が通る（既存テスト含む）
- `bun run typecheck`（または相当）が通る
- dashboard 起動後、Metrics タブに「統合」セクションが表示されないこと
- ヘッダーの `5h:` / `7d:` 表示は従来通り出ること

## 補足

- `daemon.rateLimit` 本体の `unified5hUtilization` / `unified7dUtilization` フィールドはヘッダーと throttle 判定で使用されているため**触らない**
- 削除する「統合」セクションは Metrics タブ UI の劣化ビューのみ


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-309-1777018642` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-309-1777018642
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-309-1777018642/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/309-metrics-5h-7d/runs/task-309-1777018642
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/309-metrics-5h-7d/runs/task-309-1777018642/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
