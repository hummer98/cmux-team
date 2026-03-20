---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
description: "チームを初期化し .team/ ディレクトリ構造を作成する"
---

# /team-init

現在のプロジェクトに `.team/` ディレクトリ構造を初期化してください。

## 手順

1. **cmux 環境チェック**:
   - `CMUX_SOCKET_PATH` が設定されているか確認
   - 設定されていない場合は警告を出す（初期化自体は可能）

2. **`.team/` ディレクトリ構造を作成**:
   ```
   .team/
   ├── team.json
   ├── specs/
   ├── output/
   ├── issues/
   │   ├── open/
   │   └── closed/
   ├── prompts/
   └── docs-snapshot/
   ```

3. **`team.json` を初期化**:
   ```json
   {
     "project": "<カレントディレクトリ名>",
     "description": "$ARGUMENTS",
     "phase": "init",
     "created_at": "<現在のISO 8601タイムスタンプ>",
     "agents": [],
     "completed_outputs": []
   }
   ```

4. **`.team/.gitignore` を作成**（エフェメラルなファイルを除外）:
   ```
   output/
   prompts/
   docs-snapshot/
   ```

5. **プロジェクトの `.gitignore` を確認**:
   - `.team/output/` と `.team/prompts/` が含まれていなければ追加を提案

6. **初期化結果のサマリーを表示**:
   - 作成したディレクトリ一覧
   - team.json の内容
   - 次のステップの案内（`/team-research` や `/team-spec` の紹介）

## 引数

`$ARGUMENTS` = プロジェクトの説明（オプション、team.json に記録）

## 注意事項

- `.team/` が既に存在する場合は上書きせず、既存の状態を表示する
- `.team/specs/` と `.team/issues/` は git 追跡対象にする（仕様とイシューは永続化）
- `.team/output/`, `.team/prompts/`, `.team/docs-snapshot/` はエフェメラル（git 除外）
