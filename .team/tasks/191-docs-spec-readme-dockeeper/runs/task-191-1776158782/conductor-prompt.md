# タスク割り当て

## タスク内容

---
id: 191
title: docs/spec と README を実装現状に同期（dockeeper）
priority: medium
created_at: 2026-04-14T09:26:22.162Z
---

## タスク
## 背景

README.md / README.ja.md に古い表記や仕様が残ったままになっており、dockeeper のスコープも `docs/spec/` のみだった。本日（2026-04-14）dockeeper テンプレート / SKILL / `/docs-sync` コマンドを README 対応に拡張済み。

拡張内容:
- `skills/cmux-team/templates/ja/dockeeper.md` / `en/dockeeper.md` に README.md / README.ja.md を対象追加
- `skills/dockeeper/SKILL.md` に README を対象ファイル表に追加、英日対訳維持の注意事項を追記
- `commands/docs-sync.md` の手順・レポート・注意事項を README 対応に拡張

本タスクは上記拡張を適用した dockeeper の**初回実行**を行い、蓄積した乖離を解消する。

## やること（dockeeper SKILL.md の手順に準拠）

1. **Step 1: 最終更新時点を確認**
   - `git log -1 --format="%H %ai %s" -- docs/spec/` と `-- README.md README.ja.md` を取得
   - 古い方を `<base_hash>` とする

2. **Step 2: 実装変更を収集**
   - `git log --oneline <base_hash>..HEAD -- skills/ commands/ bin/ package.json .claude-plugin/`

3. **Step 3: closed タスクで補完**
   - `.team/task-state.json` の closed タスクタイトルを俯瞰
   - 曖昧なコミットは `.team/tasks/<id>-*/task.md` を参照

4. **Step 4: 各ファイルと照合**
   - 対象: `docs/spec/*.md` 全 7 ファイル + `README.md` + `README.ja.md`
   - README は **CLI コマンド一覧・インストール手順・機能一覧・アーキテクチャ図** が実装と一致しているか重点確認
   - 英日は見出し・セクション構造・記述順を揃える（対訳関係維持）

5. **Step 5: 差分レポート出力 → ユーザー確認 → 更新**
   - 差分レポートを summary.md に書き出す
   - レポート形式は `commands/docs-sync.md` §Step 4 を参照（README 項目を含む）
   - 差分が大きい場合はセクション別に理由をコメント

6. **Step 6: 納品**
   - 差分をコミット（`docs: sync docs/spec and README with current impl`）
   - main にマージ

## 成功基準

- `docs/spec/*.md` と実装の乖離が 0（または「要確認」タグ付きで明示）
- `README.md` / `README.ja.md` の CLI コマンド一覧が `cmux-team --help` と完全一致
- 英日 README のセクション構造が一致
- 削除された機能・コマンドの記述が残っていない

## 特に確認してほしい最近の変更（closed タスクから）

- T181: await-agent 方式への移行（`cmux-team await-agent` CLI 追加、SESSION_ASK/asking 状態）
- T187: auto-update を update-notifier + タスク自動起票に再設計（`autoUpdate` 3モード: off/notify/task）
- T186 → T187 の破壊的変更（`enabled=<bool>` → `mode=<mode> source=<src>` ログフォーマット）
- レイアウト戦略 `wide` / `16x9` モード
- トレーサビリティ（API Proxy、`cmux-team trace`）

## 非ゴール

- `CHANGELOG.md` の更新（`/release` スキル担当）
- スクリーンショット・動画の差し替え
- 大規模な文体リライト（既存のトーンを維持）

## 参考

- dockeeper 仕様: `skills/dockeeper/SKILL.md`
- docs-sync 手順: `commands/docs-sync.md`
- dockeeper テンプレート: `skills/cmux-team/templates/ja/dockeeper.md` / `en/dockeeper.md`


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-191-1776158782` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-191-1776158782
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-191-1776158782/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/191-docs-spec-readme-dockeeper/runs/task-191-1776158782
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/191-docs-spec-readme-dockeeper/runs/task-191-1776158782/summary.md` に書き出す。

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
