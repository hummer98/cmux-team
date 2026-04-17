# タスク割り当て

## タスク内容

---
id: 197
title: Inspector/Implementer/Planner テンプレートに touched-files 型エラーゼロ化ルールを追加
priority: medium
created_at: 2026-04-14T21:50:33.069Z
---

## タスク
# 目的

型エラーが Inspector を通過して塩漬け化するのを防ぐ。「触ったファイルのエラーはゼロにする」という touched-files ルールと、スコープ外の巨大修正を後続タスクに逃がすエスケープバルブを整備する。

## 背景

直近タスクの振り返りで以下の問題が判明した:

- T187 で update-notifier を追加した際 TS7016 が新規発生したが、「Minor 指摘」カテゴリで悪化件数の母集団から外され pass していた
- 結果として既存型エラーが溜まり、T190 のような専用クリーンアップタスクが必要になった
- 現状の Inspector ポリシーは「件数ベースの悪化なし」で新規エラーを検出しきれていない

## 方針（ユーザー合意済み）

1. **touched-files zero-errors ルール**: Inspector は `git diff main...HEAD --name-only -- '*.ts' '*.tsx'` で特定した touched files のみで `tsc --noEmit` をゼロにする必要がある（全体ベースの件数比較は撤去）
2. **エスケープバルブ**: touched ファイル内に out-of-scope な既存エラーがある場合、Implementer が `cmux-team create-task --depends-on <current-id>` で cleanup タスクを起票してから Inspector に pass させる
3. **Planner が先読み**: Planner 段階で touched 予定ファイルの既存エラーを確認し、plan に「本タスクで直す」「後続タスク化する」を宣言する

## 修正対象ファイル（6ファイル）

### 1. `skills/cmux-team/templates/{ja,en}/inspector.md`

- 型チェック手順を追加・明文化
- 実行コマンド例:
  \`\`\`bash
  TOUCHED=\$(git diff main...HEAD --name-only -- '*.ts' '*.tsx' | tr '\n' '|' | sed 's/|\$//')
  bunx tsc --noEmit 2>&1 | grep -E \"^(\$TOUCHED)\"
  \`\`\`
- 判定: 出力が空なら pass、1行でもあれば blocker
- 「Minor 指摘」で新規エラーを見逃す経路を禁止する旨を明記
- 既存の「件数ベース悪化判定」の記述があれば撤去

### 2. `skills/cmux-team/templates/{ja,en}/implementer.md`

- touched ファイル内に out-of-scope な既存型エラーを発見した場合の手順:
  1. まず本タスクの変更で直せるか評価
  2. 直すのがスコープ外（ファイル大規模refactor が必要等）と判断したら cleanup タスクを起票:
     \`\`\`bash
     cmux-team create-task \\
       --title \"cleanup: <元タスク名> で発見した既存型エラー修正\" \\
       --depends-on <current-task-id> \\
       --status ready \\
       --body \"...\"
     \`\`\`
  3. impl-report に「cleanup タスク T<id> に分離」と明記
- Inspector はこの起票履歴を確認して pass できる

### 3. `skills/cmux-team/templates/{ja,en}/planner.md`

- Planner 段階で触る予定のファイルの既存エラー状況を先に確認する手順を追加:
  \`\`\`bash
  bunx tsc --noEmit 2>&1 | grep -E \"^(<予定ファイル群>)\"
  \`\`\`
- plan.md に次の宣言を含める:
  - 「本タスクのスコープで解消するエラー」
  - 「後続タスクに分離するエラー（cleanup タスク予定）」
- これにより Implementer が現場判断で迷わない

## 注意事項

- ja/en は同じ内容を並行更新する（片方だけ更新しない）
- 既存の inspector.md の他チェック項目（lint, 手動テスト指示等）は温存する
- 「件数ベースで悪化なし」の記述がある箇所は削除 or 「touched-files ゼロ必須」に置換
- CLAUDE.md / docs/spec/04-templates.md にポリシー変更の影響があるか dockeeper 観点でも確認（このタスクのスコープ外だが必要なら後続タスク）

## 完了条件

- 6ファイル（ja/en × 3 role）の更新が完了
- inspector テンプレートに touched-files check コマンドが記載
- implementer テンプレートに --depends-on cleanup 起票手順が記載
- planner テンプレートに既存エラー先読み手順が記載
- \`tsc --noEmit\` で新規型エラーなし（touched-files ルール自己適用）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-197-1776203433` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-197-1776203433
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-197-1776203433/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/197-inspector-implementer-planner-touched-files/runs/task-197-1776203433
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/197-inspector-implementer-planner-touched-files/runs/task-197-1776203433/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
