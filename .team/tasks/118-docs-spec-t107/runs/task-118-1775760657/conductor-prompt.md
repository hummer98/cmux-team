# タスク割り当て

## タスク内容

---
id: 118
title: docs/spec/ を最新実装に同期 (T107以降の変更反映)
priority: medium
created_at: 2026-04-09T18:50:54.361Z
---

## タスク
## 背景

`docs/spec/` の最終更新は `d23303e` (2026-04-05) で、それ以降 `skills/` `commands/` `bin/` `package.json` `.claude-plugin/` に **64件のコミット** が入っているが docs/spec/ に反映されていない。実装と仕様書の乖離が拡大している。

## やること

`/docs-sync` スキル（`cmux-team:docs-sync`）の手順に従って docs/spec/ を同期する。

### Step 1: ベースライン確認

```bash
git log -1 --format="%H %ai %s" -- docs/spec/
# → d23303e 2026-04-05 feat: Conductor 実装フロー4フェーズのテンプレート強化
```

### Step 2: 対象コミット収集

```bash
git log --oneline d23303e..HEAD -- skills/ commands/ bin/ package.json .claude-plugin/
```

主な変更カテゴリ（コミットログより抜粋）:
- **新機能**: delete-task コマンド、task-centric folder 集約、ダッシュボード TPM 5h/7d 表示、タスク時間管理(assignedAt)、worktree に `.claude/settings.local.json` コピー
- **バグ修正**: daemon_auto_restart 後の Master proxy 見失い、メモリリーク(interval/fs.watch)、Conductor starting 状態遷移、Master idle スピナー
- **設計変更**: workspace 分離(daemon が稼働 workspace を記録)、plan.md の出力先を OUTPUT_DIR に変更
- **リリース**: v3.27.0 → v3.31.0 まで複数リリース

### Step 3: closed タスク履歴の参照

`.team/task-state.json` の closed タスクから T97〜T116 あたりを参照し、コミットメッセージで不明瞭なものを補完する。

### Step 4: docs/spec/ 各ファイルと照合

以下の7ファイルを順に読み、上記の変更を反映すべき箇所を特定する:

- `docs/spec/00-project-overview.md` — プロジェクト概要・4層アーキテクチャ
- `docs/spec/01-skill-cmux-team.md` — cmux-team スキル仕様
- `docs/spec/02-skill-cmux-agent-role.md` — cmux-agent-role 仕様
- `docs/spec/03-commands.md` — スラッシュコマンド定義（delete-task 等の追加）
- `docs/spec/04-templates.md` — テンプレート仕様（4フェーズテンプレート等）
- `docs/spec/05-install-and-infrastructure.md` — インストール・インフラ
- `docs/spec/06-implementation-tasks.md` — 実装タスク定義

### Step 5: 差分レポート作成

以下のフォーマットで `.team/output/<taskRunId>/diff-report.md` に出力:

```
## docs/spec/ 同期レポート

最終 docs 更新: 2026-04-05 (d23303e)
検出コミット数: 64件
参照 closed タスク: T97〜T116

### 更新が必要なファイル
- docs/spec/03-commands.md: delete-task 追加、abort-task の Journal 対応
- docs/spec/XX-xxx.md: ...

### 変更不要なファイル
- docs/spec/YY-yyy.md: 変更なし
```

### Step 6: 実際の更新

差分レポートに従って Edit で各ファイルを更新する。

- 既存の文体・構造を大きく変えない
- 実装の「何を・なぜ」を記述する（内部実装コードの詳細は書かない）
- 不明な変更は推測で書かず diff-report.md に「要確認」として残す

## 検証

- `git diff docs/spec/` で差分を確認
- 追加した項目が実際のコード/コマンドと一致しているか目視確認
- リンク切れ・参照ズレがないか確認

## 完了条件

- docs/spec/ が T116 までの変更を反映している
- diff-report.md が output に保存されている
- `git diff docs/spec/` がレビュー可能な状態

## 参考

- スキル定義: `cmux-team:docs-sync`（起動時に読み込み可能）
- 実装コード: `skills/cmux-team/` 配下
- タスク履歴: `.team/task-state.json` + `.team/tasks/*/task.md`


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-118-1775760657` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-118-1775760657
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-118-1775760657/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/118-docs-spec-t107/runs/task-118-1775760657
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/118-docs-spec-t107/runs/task-118-1775760657/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
