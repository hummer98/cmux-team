---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
description: "タスクの作成・一覧・クローズ・表示を管理する"
---

# /team-task

`.team/tasks/` のタスクを管理してください。

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

1. `.team/tasks/open/` と `.team/tasks/closed/` の全ファイルを読み込む
2. 各タスクの YAML フロントマターを解析
3. 一覧を表形式で表示:

```
## オープンタスク (N件)

| ID  | タイトル                    | タイプ    | ステータス | 起票者         | 作成日     |
|-----|---------------------------|----------|----------|---------------|-----------|
| 001 | 認証トークンの有効期限設計   | decision | ready    | architect      | 2026-03-19 |
| 002 | DB接続のタイムアウト        | blocker  | draft    | implementer-1  | 2026-03-19 |

## クローズ済み (M件)

| ID  | タイトル                    | タイプ    | 起票者         | 作成日     |
|-----|---------------------------|----------|---------------|-----------|
| 000 | 初期設計の方針決定          | decision | architect      | 2026-03-18 |
```

タスクが 0 件の場合: 「オープンタスクはありません」

---

## 操作: 新規作成

### 手順

1. **次のタスク番号を決定**:
   ```bash
   # open/ と closed/ の全ファイルから最大の ID を取得
   ls .team/tasks/open/ .team/tasks/closed/ 2>/dev/null | grep -oE '^[0-9]+' | sort -n | tail -1
   # → 最大 ID + 1。ファイルがなければ 001 から開始
   ```

2. **タスク情報の収集**:
   タイトルは `$ARGUMENTS` から取得済み。以下を対話的に確認:
   - **タイプ**: decision / blocker / finding / question
   - **コンテキスト**: このタスクの背景（1-2 文）
   - **選択肢**（decision/question の場合）: 検討中のオプション
   - **推奨案**（あれば）

3. **タスクファイルを作成**:
   ファイル名: `.team/tasks/open/NNN-<slug>.md`
   （slug はタイトルから英数字・ハイフンに変換、30 文字以内）

   ```markdown
   ---
   id: NNN
   title: "<タイトル>"
   type: <タイプ>
   status: draft
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

   **status について:**
   - `draft` — 作成直後。Manager は無視する（ユーザー確認待ち）
   - `ready` — 着手 OK。Manager が走査して Conductor を起動する

   新規作成時は常に `status: draft` で作成する。

4. **作成確認**:
   作成したタスクの内容を表示。

---

## 操作: クローズ

### 手順

1. **タスクファイルを検索**:
   ```bash
   ls .team/tasks/open/ | grep "^$ID"
   ```

2. **タスクが見つからない場合**:
   「ID: $ID のオープンタスクが見つかりません」と表示

3. **タスクファイルを移動**:
   ```bash
   mv .team/tasks/open/NNN-*.md .team/tasks/closed/
   ```

4. **クローズ情報を追記**:
   ファイル末尾に追記:
   ```markdown

   ---
   Closed at: <ISO 8601 タイムスタンプ>
   Resolution: <ユーザーに確認、または "closed by conductor">
   ```

5. **確認表示**:
   「タスク #NNN をクローズしました: <タイトル>」

---

## 操作: 詳細表示

### 手順

1. **タスクファイルを検索**:
   `.team/tasks/open/` と `.team/tasks/closed/` の両方を検索:
   ```bash
   ls .team/tasks/open/ .team/tasks/closed/ 2>/dev/null | grep "^$ID"
   ```

2. **タスクが見つからない場合**:
   「ID: $ID のタスクが見つかりません」と表示

3. **タスクの全内容を表示**:
   ファイルの全内容を読み込んで整形表示。

---

## 前提チェック

すべての操作の前に:
- `.team/team.json` が存在すること
- `.team/tasks/` ディレクトリが存在すること（なければ作成）

## 引数

`$ARGUMENTS` = サブコマンドと引数:
- "" → 一覧表示
- "create <title>" → 新規作成
- "close <id>" → クローズ
- "show <id>" → 詳細表示
- "<title>" → 新規作成のショートハンド
