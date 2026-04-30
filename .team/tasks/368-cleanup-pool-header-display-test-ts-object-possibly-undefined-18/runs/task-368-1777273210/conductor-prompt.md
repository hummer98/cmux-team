# タスク割り当て

## タスク内容

---
id: 368
title: cleanup: pool-header-display.test.ts の Object possibly undefined 18 件
priority: medium
created_by: surface:233
created_at: 2026-04-27T06:53:54.595Z
---

## タスク
## 発見経緯

T354 (Metrics タブ書き換え) の plan §6.2 で「out-of-scope な既存型エラー」として分離した cleanup タスク。T354 のスコープ内ファイル (dashboard.tsx / dashboard-metrics.ts / rate-limit-display.ts / trace-store.ts / proxy.ts / config.ts) には型エラーが無く、本件は完全に独立している。

## 対象

- ファイル: `skills/cmux-team/manager/pool-header-display.test.ts`
- エラー: 18 件全て `TS2532: Object is possibly 'undefined'`
- 行: 33, 34, 39, 44, 49, 54, 59, 71-76, 88, 98, 110, 115, 135

## 方針

各 `tokens[N]` / `parts[N]` 直後に `?` を挿入するか、テストの fixture 配列を `as const` で固定長 tuple 化して non-null 推論を効かせる。テストの assertion ロジックには影響しない。

## スコープ

- 修正対象: `pool-header-display.test.ts` のみ
- 関連実装の変更不要


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-368-1777273210` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-368-1777273210
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-368-1777273210/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/368-cleanup-pool-header-display-test-ts-object-possibly-undefined-18/runs/task-368-1777273210
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/368-cleanup-pool-header-display-test-ts-object-possibly-undefined-18/runs/task-368-1777273210/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
