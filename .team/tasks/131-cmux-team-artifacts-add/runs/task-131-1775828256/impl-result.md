# 実装結果: `cmux-team artifacts add <file>`

## 変更ファイル一覧

### 1. `skills/cmux-team/manager/artifact.ts`
- `nextArtifactId(projectRoot)`: 既存アーティファクトの最大 ID + 1 を自動採番
- `buildFrontmatter(meta)`: フロントマター YAML 文字列を組み立てる内部関数
- `addArtifact(opts)`: 既存ファイルをアーティファクトとして `.team/artifacts/` に登録
  - フロントマターあり: 既存値をベースに CLI オプションで上書き、`id` は自動採番で常に上書き
  - フロントマターなし: 新規フロントマターを生成（デフォルト type=research, author=master）
- import に `writeFile`, `mkdir`, `basename` を追加

### 2. `skills/cmux-team/manager/i18n.ts`
- 英語/日本語の固定メッセージ追加: `artifact_add_file_required`
- 英語/日本語のテンプレートメッセージ追加: `artifact_add_file_not_found`, `artifact_added`
- `help_artifacts`（en/ja）: Subcommands に `add <file>` を追記、Options に `--type`, `--title`, `--task`, `--tags` の (add) 用説明を追記、Examples に `add` の例を追記
- `help_main`（en/ja）: `artifacts add <file>` の行を追加

### 3. `skills/cmux-team/manager/main.ts`
- import に `addArtifact` を追加
- `cmdArtifacts()` に `add` サブコマンド分岐を追加（`--validate` の後、`show` の前）
- `getArg()` で `--type`, `--title`, `--task`, `--tags` を取得
- `t()` で i18n 対応のエラー/成功メッセージを出力

## 動作確認結果

| テストケース | 結果 |
|-------------|------|
| `artifacts --help` | add サブコマンドがヘルプに表示される |
| フロントマターなしファイルの add | 新規フロントマター生成、ID 自動採番、正常登録 |
| フロントマター付きファイルの add | ID 上書き、既存値維持、CLI オプションで tags 上書き、updated 設定 |
| ファイルパス未指定 | エラーメッセージ + exit(1) |
| 存在しないファイル指定 | エラーメッセージ + exit(1) |

## 注意点・残課題

- `tf()` 関数は計画書に記載されていたが実際には存在しない。`t(key, vars)` で統一（既存パターンに合わせた）
- テスト用に作成したアーティファクト（A008, A009）は削除済み
