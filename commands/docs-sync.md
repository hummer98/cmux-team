---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
description: "docs/spec/ と README を実装の現状に合わせて同期する"
---

# /docs-sync

`docs/spec/` と `README.md` / `README.ja.md` を実装・タスク履歴と照合し、乖離を検出して更新します。

## 引数

| 引数 | 動作 |
|------|------|
| （なし） | 差分を提示してユーザー確認後に更新 |
| `--dry-run` | 差分レポートのみ出力（ファイル変更なし） |
| `--auto` | 確認なしで自動更新 |

## 手順

### Step 1: docs/spec/ と README の最終更新コミットを確認

```bash
git log -1 --format="%H %ai %s" -- docs/spec/
git log -1 --format="%H %ai %s" -- README.md README.ja.md
```

それぞれのハッシュと日時を記録する。古いほうを `<base_hash>` としてベースにする。

### Step 2: それ以降の実装変更を収集

```bash
git log --oneline <base_hash>..HEAD -- skills/ commands/ bin/ package.json .claude-plugin/
```

コミットメッセージが不明瞭な場合は対応するタスクファイルを読む:

```bash
# closed タスクを一覧
python3 -c "
import json
data = json.load(open('.team/task-state.json'))
for tid, info in data.items():
    if info.get('status') == 'closed':
        print(tid, info.get('title',''))
"
```

### Step 3: docs/spec/ と README の各ファイルを読んで照合

以下を順に読み、収集した変更と照合する:

```bash
ls docs/spec/
ls README.md README.ja.md
```

差異を検出したら「更新が必要な箇所」としてリストアップする。README は CLI コマンド一覧・インストール手順・機能一覧が実装と一致しているか特に重点的に確認し、英日の対訳関係を維持すること。

### Step 4: 差分レポートを出力

```
## docs/spec/ + README 同期レポート

最終 docs 更新: <日時>
最終 README 更新: <日時>
検出コミット数: N件
参照 closed タスク数: N件

### 更新が必要なファイル
- docs/spec/XX-xxx.md: <変更内容の要約>
- README.md: <変更内容の要約>
- README.ja.md: <変更内容の要約>

### 変更不要なファイル
- docs/spec/YY-yyy.md: 変更なし
```

### Step 5: 更新実行

- `--dry-run` の場合: ここで終了
- デフォルトの場合: 差分レポートをユーザーに提示し「更新しますか？」と確認してから実行
- `--auto` の場合: 確認なしで実行

各ファイルを Edit ツールで更新する。削除すべき記述は除去し、追加すべき情報を適切なセクションに挿入する。

### Step 6: 完了報告

```
## 完了

更新したファイル:
- docs/spec/03-commands.md（/docs-sync コマンドを追加）
- docs/spec/04-templates.md（dockeeper の役割説明を更新）
- README.md / README.ja.md（CLI コマンド一覧を更新、英日同時）

スキップしたファイル:
- docs/spec/00-project-overview.md（変更なし）
```

## 注意事項

- `docs/spec/` は実装の「何を・なぜ」を記述する。内部実装コードの詳細は書かない
- `README.md` / `README.ja.md` はユーザーが最初に読むドキュメント。開発者向け内部仕様は入れない
- 英日 README はセクション構造・見出し・記述順を揃える（対訳関係を維持）
- 既存の文体・構造を大きく変えない
- 不明な変更は推測で書かず「要確認」として差分レポートに記載する
- コミットがない場合でも closed タスクがあれば反映対象になりうる
