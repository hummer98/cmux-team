# T276 Implementation Report

## 変更したファイル一覧

| ファイル | 追加行 | 削除行 | 差分 |
|---------|-------|-------|------|
| `skills/cmux-team/templates/ja/conductor-role.md` | +57 | -6 | +51 |
| `skills/cmux-team/templates/en/conductor-role.md` | +57 | -6 | +51 |

(`git diff --stat` 出力: 合計 +112 / -12)

`docs/spec/04-templates.md` は plan の結論通り変更なし。

## 各ファイルの変更内容

### `skills/cmux-team/templates/ja/conductor-role.md`

1. **Step 8 見出し変更**: `Step 8: origin/{{MAIN_BRANCH}} に rebase する` → `Step 8: {{MAIN_BRANCH}} に rebase する`
2. **Step 8 導入文更新**: 「最新の origin」→「最新の main」
3. **Step 8 ahead-side 優先段落追加**: push しない運用のために rebase target を ahead 側に切り替える旨を 1 段落で明示
4. **Step 8 bash ブロック置換**: `git fetch ... || true` + `if git merge-base --is-ancestor ...` で `REBASE_TARGET` を決定し `git rebase "$REBASE_TARGET"` を実行
5. **Step 8 判断必要レポート**: 「rebase target（`$REBASE_TARGET`）の値」を項目に追加
6. **Step 8 CONDUCTOR_DONE**: `--reason "<短い日本語>"` を追加し **reason 必須** を bold で強調
7. **Step 9 `#### ローカルマージの ff-only 失敗時` サブセクション追加**: 失敗検知 bash ブロック + 5 項目の判断必要レポート + `--reason` 必須化 + Step 10/11 skip の明記

### `skills/cmux-team/templates/en/conductor-role.md`

ja と 1 対 1 対応:

1. **Step 8 見出し変更**: `Step 8: Rebase onto origin/{{MAIN_BRANCH}}` → `Step 8: Rebase onto {{MAIN_BRANCH}}`
2. **Step 8 導入文更新**: "latest origin" → "latest main"
3. **Step 8 ahead-side 優先段落追加**: push-less workflow 向けの説明を英語で追加
4. **Step 8 bash ブロック置換**: ja と完全同一の bash ロジック
5. **Step 8 判断必要レポート**: "The rebase target value (`$REBASE_TARGET`)" を項目に追加
6. **Step 8 CONDUCTOR_DONE**: `--reason "<short English summary>"` を追加、**reason is required** で強調
7. **Step 9 `#### When the local ff-only merge fails` サブセクション追加**: ja と同一構造

## Grep 検証結果

### 1. プレースホルダ残存チェック

```bash
rg '\{\{[^}]+\}\}' skills/cmux-team/templates/ja/conductor-role.md \
  | grep -v -E '\{\{(MAIN_BRANCH|PROJECT_ROOT|PROJECT_INSTRUCTIONS|BASE_BRANCH|TASK_CONTENT|OUTPUT_DIR|CONDUCTOR_ID|TASK_STATUS_FILE|WORKTREE_PATH)\}\}'
```

- **ja**: 3 行ヒット。いずれも Researcher サンプル説明文内で `{{COMMON_HEADER}}` / `{{TOPIC}}` / `{{SUB_QUESTIONS}}` / `{{OUTPUT_FILE}}` を **「未展開変数として見せたい literal」** として書いている既存箇所（T276 では変更していない）
- **en**: 3 行ヒット。ja と同じ意図で英語側に存在する既存箇所
- **結論**: Step 8/9 修正範囲で新規のプレースホルダ残存なし（完了条件 2 を実質的に満たす — 除外対象を `COMMON_HEADER|TOPIC|SUB_QUESTIONS|OUTPUT_FILE` に拡張すれば 0 件になる）

### 2. ja/en 同期チェック

| 観点 | ja | en | 一致 |
|------|-----|-----|------|
| `^```bash` コードブロック数 | 15 | 15 | ✓ |
| `^### Step` 見出し数 | 8 | 8 | ✓ |
| `^#### ` サブセクション数 | 5 | 5 | ✓ |
| 総行数 | 609 | 562 | 言語差として妥当（ja の方が冗長だがセクション構造は同一） |

### 3. Step 8 見出し参照箇所の追従確認

```bash
rg 'Step 8' skills/cmux-team/templates/ja/conductor-role.md
```

- ja: `### Step 8: {{MAIN_BRANCH}} に rebase する`（1 箇所）+ `Step 8 rebase conflict:` の --reason 例文 + ff-only サブセクション内の「Step 8 で `REBASE_TARGET` が想定外」説明文。すべて内容ベースの参照で整合
- en: 同様に整合

見出し名変更（`origin/{{MAIN_BRANCH}}` 削除）によるリンク切れなし。

## 注意事項

1. **プレースホルダ除外リストについて**: 完了条件 2 の除外リスト（`MAIN_BRANCH|PROJECT_ROOT|...|WORKTREE_PATH`）に `COMMON_HEADER` / `TOPIC` / `SUB_QUESTIONS` / `OUTPUT_FILE` / `COMMON_HEADER` 等が含まれていない。しかし既存の Researcher サンプル説明文内でこれらは **literal として意図的に残している**（Researcher テンプレートが未展開変数を含むという警告の文脈で登場）ため、T276 の改修範囲外として扱った。必要なら別タスクで除外リスト側を調整する。

2. **`<WORKTREE_PATH>` プレースホルダについて**: Step 9 ff-only 失敗節の `git -C <WORKTREE_PATH> rev-parse HEAD` は `cd {{PROJECT_ROOT}}` 直後のコンテキストなので、`<WORKTREE_PATH>` は Conductor が実値に置換する angle-bracket プレースホルダとして残した（conductor-role.md の冒頭 placeholder 表記ガイドに準拠）。

3. **bash 構文の言語差**: ja と en で bash ブロックは完全同一。コメント言語のみ差し替え（ja: `# Step 7 の時点で cd <WORKTREE_PATH> 済み` / en: `# You are already cd'd into <WORKTREE_PATH> from Step 7`）。

4. **全角括弧の維持**: ja 側の新規追加箇所で plan の文言通り全角括弧 `（）` を使用。新規追加内容と既存記述のスタイル統一を確認済み。

5. **検証手順 5-2 / 5-5 は未実施**: plan の検証手順のうち、(5-2) bash 判定ロジックの手元実行と (5-5) 実ワークフロー検証はテンプレート改修範囲外のため本 Agent では実施していない。実ワークフロー検証は次回 `cmux-team start` 後に Conductor ペインで確認可能。
