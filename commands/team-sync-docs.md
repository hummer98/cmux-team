---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
description: "ドキュメントをスペックと同期する"
---

# /team-sync-docs

`docs/` を `.team/specs/` の現在の状態と同期してください。

## 手順

### 1. 前提チェック

- `.team/team.json` が存在すること（なければ `/team-init` を案内）
- `.team/specs/` にファイルが存在すること

### 2. 現在のスペック状態の収集

`.team/specs/` 内の全ファイルを読み込む:
- `requirements.md` — 要件定義
- `research.md` — リサーチ結果
- `design.md` — 設計ドキュメント
- `tasks.md` — タスク一覧
- その他のスペックファイル

### 3. スナップショットとの差分検出

`.team/docs-snapshot/` と比較:

```bash
# スナップショットが存在しない場合は初回同期
ls .team/docs-snapshot/ 2>/dev/null

# 差分検出
diff -rq .team/specs/ .team/docs-snapshot/ 2>/dev/null
```

- スナップショットが存在しない場合: 全ファイルが「新規」扱い
- 差分がない場合: 「ドキュメントは最新です」と表示して終了

### 4. ドキュメント生成・更新

team.json からプロジェクト名を取得し、`docs/` 構造を生成:

#### ドキュメント構成

```
docs/
├── README.md               # プロジェクト概要（requirements.md ベース）
├── design.md               # 技術設計（design.md を整形）
├── tasks.md                # タスク一覧と進捗（tasks.md を整形）
└── research/               # リサーチ結果（あれば）
    └── <topic>.md
```

#### 生成ルール

**docs/README.md** (または既存の docs/README.md を更新):
- requirements.md から「概要」「目的」「機能要件」セクションを抽出
- ユーザー向けの読みやすい形式に整形
- 技術的な内部詳細は除外

**docs/design.md**:
- design.md の内容を整形
- 内部実装の詳細（ファイルパス等）は一般化
- Mermaid ダイアグラムはそのまま維持

**docs/tasks.md**:
- tasks.md の内容を進捗ステータス付きで表示
- 完了済み/進行中/未着手のステータスを反映

### 5. スナップショット更新

```bash
# 現在の specs/ をスナップショットとしてコピー
rm -rf .team/docs-snapshot/*
cp -r .team/specs/* .team/docs-snapshot/
```

### 6. 差分サマリーの表示

ユーザーに以下を表示:

```
## ドキュメント同期完了

### 変更内容
- 更新: docs/README.md (要件からの概要更新)
- 新規: docs/design.md (設計ドキュメント追加)
- 更新: docs/tasks.md (進捗ステータス反映)

### 次回同期で検出する変更
- .team/specs/ 内のファイルが変更された場合
```

### 7. git コミット（オプション）

ユーザーに確認: 「ドキュメントの変更を git commit しますか？」

YES の場合:
```bash
git add docs/
git commit -m "docs: sync documentation with current specs"
```

### 8. DocKeeper エージェント（オプション）

ドキュメントの品質をさらに向上させたい場合:
- ユーザーに確認: 「DocKeeper エージェントを起動してドキュメントを精査しますか？」
- YES の場合:
  1. `~/.claude/skills/cmux-team/templates/dockeeper.md` からプロンプトを生成
  2. エージェントを起動し、docs/ の整形・改善を実施
  3. 完了後に差分を表示

### 9. 状態更新

- team.json は更新しない（sync-docs はフェーズを変更しない補助コマンド）

## 引数

なし

## 注意事項

- `docs/` に既存のユーザー作成ドキュメントがある場合は上書きせず、マージを試みる
- スペックに機密情報が含まれていないか注意する（内部実装詳細の除外）
- docs-snapshot/ は gitignore されているため、同期状態はローカルのみで管理される
