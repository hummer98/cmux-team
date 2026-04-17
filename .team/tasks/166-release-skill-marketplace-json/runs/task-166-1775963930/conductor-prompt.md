# タスク割り当て

## タスク内容

---
id: 166
title: /release skill に marketplace.json のバージョン更新を追加
priority: medium
created_at: 2026-04-12T03:18:50.541Z
---

## タスク
## 背景

`/release` skill は `package.json` と `.claude-plugin/plugin.json` のバージョンは更新するが、`.claude-plugin/marketplace.json` の `version` フィールドは更新していない。結果、marketplace.json が 3.14.0 → 3.41.0 まで大幅に乖離していた（現在は手動修正済み）。

## やること

`commands/` 配下にある `/release` に相当するスラッシュコマンド、またはリポジトリルートに skill 定義があるなら更新する。

`/release` の手順 4（バージョン更新）に以下を追記:

### 現状（skill 本文）

> ### 4. package.json と plugin.json のバージョンを更新
> Edit ツールで以下の2ファイルの \`version\` を新バージョンに更新する:
> - \`package.json\`
> - \`.claude-plugin/plugin.json\`

### 修正後

> ### 4. package.json / plugin.json / marketplace.json のバージョンを更新
> Edit ツールで以下の3ファイルの \`version\` を新バージョンに更新する:
> - \`package.json\`
> - \`.claude-plugin/plugin.json\`
> - \`.claude-plugin/marketplace.json\` （\`plugins[0].version\`）

## 完了条件

- `/release` skill 定義（projectSettings:release または対応するファイル）で marketplace.json 更新ステップが追加されている
- 実際のファイル位置は `.claude/commands/` 等に存在する可能性が高い。\`grep -rn "plugin.json" .claude/ commands/\` で探すこと
- marketplace.json 更新失敗時の挙動（ファイル存在しない場合等）も考慮

## 検証方法

次回 `/release` 実行時に marketplace.json のバージョンも更新されることを確認。

## 関連

- 今回 marketplace.json 3.14.0 → 3.41.0 手動修正（commit 48ad712）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-166-1775963930` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-166-1775963930
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-166-1775963930/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/166-release-skill-marketplace-json/runs/task-166-1775963930
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/166-release-skill-marketplace-json/runs/task-166-1775963930/summary.md` に書き出す。

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
