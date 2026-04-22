# T296 Inspection

## 判定

GO

## 検品結果

### 1. 差分

`git diff --stat` の結果、変更は指定の 4 ファイルのみ。それぞれ 1 行ずつの置換で、合計 4 insertions / 4 deletions。無関係な編集・空白の混入・改行コード変更なし。

```
 README.ja.md                             | 2 +-
 README.md                                | 2 +-
 skills/cmux-team/templates/en/manager.md | 2 +-
 skills/cmux-team/templates/ja/manager.md | 2 +-
 4 files changed, 4 insertions(+), 4 deletions(-)
```

### 2. 書き換え内容

- **README.md** (L110): `cmux-team close-task --task-id <id> --deliverable-kind <files|merged|pr|none> [kind-specific flags] [--journal <text>]` に更新。仕様通り。
- **README.ja.md** (L110): `cmux-team close-task --task-id <id> --deliverable-kind <files|merged|pr|none> [kind 別フラグ] [--journal <text>]` に更新。仕様通り。
- **skills/cmux-team/templates/en/manager.md** (L73): `cmux-team close-task ...` に抽象化。kind 別詳細を書かない方針に沿う。
- **skills/cmux-team/templates/ja/manager.md** (L73): `cmux-team close-task ...` に抽象化。kind 別詳細を書かない方針に沿う。

### 3. rg 検証

- **旧署名残存**: 0 件（`rg "close-task --task-id" docs/ CLAUDE.md README.md README.ja.md skills/cmux-team/templates/ | rg -v "deliverable-kind"` で空）
- **新仕様残存**: 12 件（conductor-role.md en/ja 各 4 行、conductor.md en/ja 各 1 行、conductor-task.md en/ja 各 1 行）。新仕様の説明文を誤って消していない。

### 4. 隣接箇所スポットチェック

- README.md / README.ja.md: 修正行の前後（create-task / update-task / abort-task / restart-task / delete-task / await-task）は破壊されていない。表の構造も維持。
- manager.md en/ja: 修正行の前後（`task_assigned` ログ出力ブロック / **Fallback** 行 / 「daemon が自動的に完了処理を行う」説明）は破壊されていない。

### 5. 表記

- README.md の `[kind-specific flags]` は英語表記として自然。`<...>` は必須引数、`[...]` は任意という表記慣習とも整合。
- README.ja.md の `[kind 別フラグ]` は日本語表記として自然。CLAUDE.md の「kind 別フラグは排他」という表現とも整合する。

OK。
