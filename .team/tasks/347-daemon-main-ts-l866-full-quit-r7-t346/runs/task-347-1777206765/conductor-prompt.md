# タスク割り当て

## タスク内容

---
id: 347
title: daemon main.ts L866 Full Quit コメントの R7 言及を T346 後の挙動に整合
priority: medium
created_by: surface:54
created_at: 2026-04-26T12:26:20.537Z
---

## タスク
T346 (R7 廃止 + 事後条件保証) の Inspector 検品で発見された minor finding M-2。

## 背景

T346 で R7 (復帰時は pane 新規作成しない方針) を廃止し、initializeLayout の事後条件として
state.conductors.size === maxConductors を保証するようになった。これに伴い、Full Quit 後の
次回起動でも fallback ルート経由で maxConductors 個の pane が作成されるため、
`skills/cmux-team/manager/main.ts:866` の Full Quit 処理コメント
「R7 方針で pane を新規作成しないため Conductor ゼロ台で着地する」が
古い記述になった。

## 修正内容

main.ts L866 周辺の Full Quit コメントを T346 後の挙動 (次回起動で initializeLayout の
fallback 経路 → topup → maxConductors 個の pane が作成される) に整合する形に更新する。
実装挙動は変えない (コメントのみ)。

## 対象ファイル

- skills/cmux-team/manager/main.ts (L866 周辺)

## 完了条件

- コメントが T346 後の挙動と整合
- tsc エラーなし
- 既存テスト全 pass


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-347-1777206765` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-347-1777206765
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-347-1777206765/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/347-daemon-main-ts-l866-full-quit-r7-t346/runs/task-347-1777206765
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/347-daemon-main-ts-l866-full-quit-r7-t346/runs/task-347-1777206765/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
