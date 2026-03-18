---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
description: "イシューの作成・一覧・クローズ・表示を管理する"
---

# /team-issue

`.team/issues/` のイシューを管理してください。

## サブコマンド判定

`$ARGUMENTS` を解析し、以下のいずれかの操作を実行する:

- `$ARGUMENTS` = "" または未指定 → **一覧表示**
- `$ARGUMENTS` が "create " で始まる → **新規作成**（"create " 以降がタイトル）
- `$ARGUMENTS` が "close " で始まる → **クローズ**（"close " 以降が ID）
- `$ARGUMENTS` が "show " で始まる → **詳細表示**（"show " 以降が ID）
- `$ARGUMENTS` がその他の文字列 → **新規作成のショートハンド**（文字列全体がタイトル）

---

## 操作: 一覧表示

### 手順

1. `.team/issues/open/` と `.team/issues/closed/` の全ファイルを読み込む
2. 各イシューの YAML フロントマターを解析
3. 一覧を表形式で表示:

```
## オープンイシュー (N件)

| ID  | タイトル                    | タイプ    | 起票者         | 作成日     |
|-----|---------------------------|----------|---------------|-----------|
| 001 | 認証トークンの有効期限設計   | decision | architect      | 2026-03-19 |
| 002 | DB接続のタイムアウト        | blocker  | implementer-1  | 2026-03-19 |

## クローズ済み (M件)

| ID  | タイトル                    | タイプ    | 起票者         | 作成日     |
|-----|---------------------------|----------|---------------|-----------|
| 000 | 初期設計の方針決定          | decision | architect      | 2026-03-18 |
```

イシューが 0 件の場合: 「オープンイシューはありません」

---

## 操作: 新規作成

### 手順

1. **次のイシュー番号を決定**:
   ```bash
   # open/ と closed/ の全ファイルから最大の ID を取得
   ls .team/issues/open/ .team/issues/closed/ 2>/dev/null | grep -oE '^[0-9]+' | sort -n | tail -1
   # → 最大 ID + 1。ファイルがなければ 001 から開始
   ```

2. **イシュー情報の収集**:
   タイトルは `$ARGUMENTS` から取得済み。以下を対話的に確認:
   - **タイプ**: decision / blocker / finding / question
   - **コンテキスト**: このイシューの背景（1-2 文）
   - **選択肢**（decision/question の場合）: 検討中のオプション
   - **推奨案**（あれば）

3. **イシューファイルを作成**:
   ファイル名: `.team/issues/open/NNN-<slug>.md`
   （slug はタイトルから英数字・ハイフンに変換、30 文字以内）

   ```markdown
   ---
   id: NNN
   title: "<タイトル>"
   type: <タイプ>
   raised_by: conductor
   created_at: <ISO 8601 タイムスタンプ>
   ---

   ## Context
   <コンテキスト>

   ## Options
   1. <選択肢 A> — メリット/デメリット
   2. <選択肢 B> — メリット/デメリット

   ## Recommendation
   <推奨案>
   ```

4. **作成確認**:
   作成したイシューの内容を表示。

---

## 操作: クローズ

### 手順

1. **イシューファイルを検索**:
   ```bash
   ls .team/issues/open/ | grep "^$ID"
   ```

2. **イシューが見つからない場合**:
   「ID: $ID のオープンイシューが見つかりません」と表示

3. **イシューファイルを移動**:
   ```bash
   mv .team/issues/open/NNN-*.md .team/issues/closed/
   ```

4. **クローズ情報を追記**:
   ファイル末尾に追記:
   ```markdown

   ---
   Closed at: <ISO 8601 タイムスタンプ>
   Resolution: <ユーザーに確認、または "closed by conductor">
   ```

5. **確認表示**:
   「イシュー #NNN をクローズしました: <タイトル>」

---

## 操作: 詳細表示

### 手順

1. **イシューファイルを検索**:
   `.team/issues/open/` と `.team/issues/closed/` の両方を検索:
   ```bash
   ls .team/issues/open/ .team/issues/closed/ 2>/dev/null | grep "^$ID"
   ```

2. **イシューが見つからない場合**:
   「ID: $ID のイシューが見つかりません」と表示

3. **イシューの全内容を表示**:
   ファイルの全内容を読み込んで整形表示。

---

## 前提チェック

すべての操作の前に:
- `.team/team.json` が存在すること
- `.team/issues/` ディレクトリが存在すること（なければ作成）

## 引数

`$ARGUMENTS` = サブコマンドと引数:
- "" → 一覧表示
- "create <title>" → 新規作成
- "close <id>" → クローズ
- "show <id>" → 詳細表示
- "<title>" → 新規作成のショートハンド
