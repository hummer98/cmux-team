---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
description: "会話中の知見をアーティファクトとして構造化・保存する"
---

# /artifact

会話中の調査結果・設計判断・セッション要約等を `.team/artifacts/` に構造化して保存します。

## サブコマンド判定

`$ARGUMENTS` を解析し、以下のいずれかの操作を実行する:

- `$ARGUMENTS` が "list" → **一覧表示**
- `$ARGUMENTS` が "show " で始まる → **内容表示**（"show " 以降が ID、例: A001）
- `$ARGUMENTS` が type キーワードで始まる → **新規作成**（type + タイトル）
- `$ARGUMENTS` がその他の文字列 → **新規作成**（タイトルのみ、type は対話で決定）
- `$ARGUMENTS` = "" → **新規作成**（type とタイトルを対話で決定）

type キーワード: `research`, `decision`, `session`, `spec`, `report`

---

## 操作: 新規作成

### 手順

1. **type の決定**:
   `$ARGUMENTS` の先頭が type キーワードならそれを使用。なければユーザーに確認:

   | type | 用途 |
   |------|------|
   | `research` | 調査結果・比較分析 |
   | `decision` | 設計判断とその理由（ADR 的） |
   | `session` | セッションの要約・発見事項 |
   | `spec` | 要件・仕様の整理 |
   | `report` | 分析レポート・振り返り |

2. **タイトルの決定**:
   `$ARGUMENTS` から type を除いた残りをタイトルとする。なければユーザーに確認。

3. **次の ID を決定**:
   ```bash
   ls .team/artifacts/ 2>/dev/null | grep -oE '^A[0-9]+' | sort | tail -1
   ```
   最大 ID + 1。ファイルがなければ A001 から開始。ゼロ埋め3桁。

4. **本文の生成**:
   現在の会話コンテキストから、type に応じた構造で要約を生成する。

   **type 別の本文構造**:

   - **research**: `## 背景` → `## 調査結果` → `## 比較・分析` → `## 結論`
   - **decision**: `## 背景` → `## 選択肢` → `## 決定` → `## 理由`
   - **session**: `## 目的` → `## 実施内容` → `## 発見・学び` → `## 次のアクション`
   - **spec**: `## 概要` → `## 要件` → `## 制約` → `## 未決事項`
   - **report**: `## 概要` → `## 詳細` → `## 結論` → `## 推奨事項`

5. **ファイル書き出し**:
   ディレクトリ: `.team/artifacts/`（存在しなければ作成）
   ファイル名: `Axxx-<slug>.md`（slug はタイトルから英数字・ハイフンに変換、30文字以内）

   ```markdown
   ---
   id: A001
   type: research
   title: "タイトル"
   created: <ISO 8601 タイムスタンプ>
   author: <現在のロール（master, conductor-N, agent-xxx）>
   task: <関連タスク ID（あれば、例: T038）>
   tags: [tag1, tag2]
   ---

   <本文>
   ```

   **フロントマター必須フィールド**: id, type, title, created, author
   **フロントマター任意フィールド**: updated, task, tags

6. **確認出力**:
   ```
   A001 を作成しました: タイトル
   → .team/artifacts/A001-slug.md
   ```

---

## 操作: 一覧表示

### 手順

1. `.team/artifacts/A*.md` の全ファイルを読み込む
2. 各ファイルの YAML フロントマターをパース
3. 番号順で表形式表示:

```
## Artifacts (N件)

| ID   | Type     | タイトル                          | 作成日     |
|------|----------|----------------------------------|-----------|
| A001 | research | ドキュメンテーションフレームワーク調査 | 2026-04-02 |
| A002 | decision | Artifacts システム設計             | 2026-04-02 |
```

ファイルが 0 件の場合: 「アーティファクトはありません」

---

## 操作: 内容表示

### 手順

1. `$ARGUMENTS` から ID を取得（"show A001" → "A001"、"show 001" → "A001"）
2. `.team/artifacts/` から該当ファイルを検索:
   ```bash
   ls .team/artifacts/ 2>/dev/null | grep -i "^A0*${ID}"
   ```
3. ファイルが見つからない場合: 「A001 のアーティファクトが見つかりません」
4. 見つかった場合: フロントマターのメタ情報 + 本文を整形表示

---

## 前提チェック

すべての操作の前に:
- `.team/artifacts/` ディレクトリが存在すること（なければ作成）

## 注意事項

- 会話の内容を正確に要約すること。捏造しない
- 既存のアーティファクトと重複する内容の場合、既存ファイルの `updated` を更新して追記することを提案する
- タスクとの関連が明らかな場合は `task` フィールドに記載する
- author は自分のロールを正確に記載する（master, conductor-1, etc.）
