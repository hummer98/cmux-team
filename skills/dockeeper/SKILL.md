---
name: dockeeper
description: >
  Use when synchronizing docs/ and README with the current implementation state.
  Triggers: user says "docs を同期", "ドキュメント更新", "仕様書更新", "README 更新",
  "sync docs", or /docs-sync command is invoked.
  Provides: git log analysis, task-based diff detection, docs/spec/ + README.md / README.ja.md update.
---

# dockeeper: ドキュメント同期

`docs/spec/` と `README.md` / `README.ja.md` を実装の現状に合わせて同期するスキル。

## 役割

実装が先行し、ドキュメントが追いついていないケースを検出して更新する。
判断材料として `git log` と `.team/tasks/` の closed タスクを使う。

対象は大きく 3 系統:
- `docs/spec/*.md` — 統合仕様書（実装の「何を・なぜ」）
- `README.md` / `README.ja.md` — ユーザー向けインストール・入門ガイド（英日対訳）
- `skills/cmux-team-guide/SKILL.md` — ユーザー向けヘルプ・リファレンス（CLI コマンド一覧・TUI・トラブルシューティング）

## 同期手順

### 1. docs/spec/ の最終更新時点を確認

```bash
git log -1 --format="%H %ai %s" -- docs/spec/
```

→ `<base_hash>` と `<last_updated>` を記録する。

### 2. それ以降の実装変更を収集

```bash
# ベースハッシュ以降のコミット（実装ファイルに絞る）
git log --oneline <base_hash>..HEAD -- skills/ commands/ bin/ package.json .claude-plugin/
```

### 3. closed タスクで補完

```bash
# closed タスクの一覧（タイトルと本文で何が実装されたか把握）
cat .team/task-state.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
for tid, info in data.items():
    if info.get('status') == 'closed':
        print(tid, info.get('title',''))
"
```

変更内容が曖昧なコミットは、対応するタスクファイル (`.team/tasks/Txxx-*.md`) を読んで補完する。

### 4. docs/spec/ および README と照合

対象ファイル:

| ファイル | 内容 |
|---------|------|
| `docs/spec/00-project-overview.md` | プロジェクト概要・アーキテクチャ |
| `docs/spec/01-skill-cmux-team.md` | cmux-team スキル仕様 |
| `docs/spec/02-skill-cmux-agent-role.md` | cmux-agent-role スキル仕様 |
| `docs/spec/03-commands.md` | スラッシュコマンド定義 |
| `docs/spec/04-templates.md` | エージェントテンプレート仕様 |
| `docs/spec/05-install-and-infrastructure.md` | インストール・インフラ構成 |
| `docs/spec/06-implementation-tasks.md` | 実装タスク定義 |
| `README.md` | ユーザー向け入門ガイド（英語） |
| `README.ja.md` | ユーザー向け入門ガイド（日本語） |
| `skills/cmux-team-guide/SKILL.md` | ユーザー向けヘルプ・リファレンス |

各ファイルを読み、収集した変更内容と照合して差異を検出する。README は CLI コマンド一覧・インストール手順・機能一覧が実装と一致しているか特に重点的に確認する。英日は対訳関係を維持する。`skills/cmux-team-guide/SKILL.md` は CLI コマンド一覧・レイアウト説明・TUI キーボードショートカット・トラブルシューティングが実装と一致しているか確認する。

### 5. 更新または差分レポート出力

モードによって動作が異なる:

| モード | 動作 |
|--------|------|
| `--dry-run` | 差分レポートのみ出力。ファイルは変更しない |
| （デフォルト） | ユーザーに差分を提示し、確認後に更新 |
| `--auto` | 確認なしで自動更新 |

差分レポートの形式:

```
## docs/spec/ 同期レポート

最終更新: <last_updated>
対象コミット: N件
対象 closed タスク: N件

### 更新が必要なファイル

#### docs/spec/03-commands.md
- `/docs-sync` コマンドの追加（T098）
- `master.md` の「タスクへの補足・追加指示」セクション追加（T097相当）

#### docs/spec/04-templates.md
- `dockeeper.md` テンプレートの役割説明を更新

### 変更不要なファイル
- 00-project-overview.md — 変更なし
- 01-skill-cmux-team.md — 変更なし
```

## 注意事項

- `docs/spec/` は「実装と同期された仕様書」。内部実装詳細は書かない
- `README.md` / `README.ja.md` は「ユーザーが最初に読むドキュメント」。開発者向け内部仕様は入れない
- 英日 README はセクション構造・見出し・記述順を揃える（対訳関係を維持）
- 削除されたファイル・機能の記述は除去する
- 既存の文体・構造を維持する（大幅なリフォーマットはしない）
- 不明な変更は推測で書かず、差分レポートに「要確認」として記載する
