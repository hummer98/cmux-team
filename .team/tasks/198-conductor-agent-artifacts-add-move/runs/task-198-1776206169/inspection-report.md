# Inspection Report: T198

## 判定

- [x] **GO** — マージ可能
- [ ] **NOGO** — 修正必要

## Summary (one line)

plan.md の完了条件をすべて満たし、TypeScript コンパイル・機能テスト（move 動作）・curly-brace プレースホルダ静的チェック・ja/en 見出し構造一致をいずれも PASS。実装は plan 通りで品質基準に到達している。

## 検品結果

### 1. Plan 完了条件チェック

| # | 項目 | 結果 |
|---|------|------|
| 1 | `artifact.ts` に `unlink` 追加 + `addArtifact` が move 動作 | ✓ |
| 2 | `main.ts` の `artifacts add` が `--project-root` と `unlinkWarning` をハンドリング | ✓ |
| 3 | `i18n.ts` `help_artifacts` ja/en で move 明記 + `--project-root` 追記 | ✓ |
| 4 | `i18n.ts` `help_main` ja/en でも move 明記（en L538 / ja L1058 相当） | ✓ |
| 5 | `bun tsc --noEmit` エラー 0 | ✓ |
| 6 | 手動テスト T-2（move 動作 + `--project-root`） | ✓ |
| 7 | 後方互換（未指定時 `PROJECT_ROOT` フォールバック） | ✓ (コード `projectRootOverride ?? PROJECT_ROOT` で保証) |
| 8 | `conductor-role.md` 完了処理順序（summary → git add → 判定 → 登録 → commit → merge → remove → close） | ✓ |
| 9 | Step 5（調査系判定、①必須 + ②③補助） | ✓ |
| 10 | Step 6（`cmux-team artifacts add --project-root "$(pwd)"`） | ✓ |
| 11 | ja 版旧 Step 6（`{{OUTPUT_DIR}}` リテラル参照）削除 | ✓ |
| 12 | en 版に artifact 化ステップ新規追加 | ✓ |
| 13 | `{{OUTPUT_DIR}}` / `{{WORKTREE_PATH}}` を angle-bracket に統一 | ✓ |
| 14 | プレースホルダ表記説明段落追加 | ✓ |
| 15 | プロジェクト独自 `artifacts/` 非推奨段落追加 | ✓ |
| 16 | フロー分岐表に「調査系」レベル追加 | ✓ |
| 17 | Phase 0（Research）セクション新設 | ✓ |
| 18 | Researcher 用 prompt heredoc サンプル追加 | ✓ |
| 19 | 「`templates/*/researcher.md` を `--prompt-file` に直接渡してはならない」注記 | ✓ |
| 20 | `implementer.md` ja/en 警告ボックス追加 | ✓ |
| 21 | `researcher.md` ja/en 警告ボックス追加 | ✓ |
| 22 | ja/en 見出し構造一致（T-7） | ✓（29/29、順序一致） |
| 23 | `grep -c '{{OUTPUT_DIR}}'` ja/en conductor-role.md = 0（T-6 相当） | ✓ |

### 2. コード検証

#### 2-1. `skills/cmux-team/manager/artifact.ts`

| 項目 | 結果 | 備考 |
|------|------|------|
| `unlink` が `fs/promises` から import | ✓ | L4 `import { readdir, readFile, writeFile, mkdir, unlink } from "fs/promises"` |
| JSDoc が move 動作を明記 | ✓ | L159-169「move 動作」「srcPath を削除」「失敗時はログ警告だけを返す」と記載 |
| `writeFile` 成功後 `unlink(opts.srcPath)` を try/catch | ✓ | L227-232 |
| 失敗時は `unlinkWarning` に reason を格納（throw しない） | ✓ | `unlinkWarning = \`unlink failed: ${e?.message ?? e}\`` |
| 戻り値型 `{ id; destPath; unlinkWarning? }` | ✓ | L172 シグネチャ、L234 return 文ともに整合 |

#### 2-2. `skills/cmux-team/manager/main.ts`

| 項目 | 結果 | 備考 |
|------|------|------|
| `--project-root` を `getArg("project-root")` で受け取り | ✓ | L2815 `const projectRootOverride = getArg("project-root");` |
| `addArtifact({ projectRoot: projectRootOverride ?? PROJECT_ROOT, ... })` | ✓ | L2817 |
| `result.unlinkWarning` を stderr + `log("artifact_add_unlink_failed", ...)` | ✓ | L2825-2828 |

#### 2-3. `skills/cmux-team/manager/i18n.ts`

| 項目 | 結果 | 備考 |
|------|------|------|
| en `help_artifacts` `add <file>` 行 move 動作明記 | ✓ | "move a file into .team/artifacts/ (source is removed on success)" |
| en `help_artifacts` に `--project-root <path>` | ✓ | Options セクションに追加 |
| en `help_main` `artifacts add` 行 move 動作明記 | ✓ | "move a file into .team/artifacts/" |
| ja `help_artifacts` `add <file>` 行 move 動作明記 | ✓ | 「ファイルを .team/artifacts/ に **移動** する（成功時にソース削除）」 |
| ja `help_artifacts` に `--project-root <path>` | ✓ | Options セクションに追加 |
| ja `help_main` `artifacts add` 行 move 動作明記 | ✓ | 「ファイルを .team/artifacts/ に移動」 |
| 起動時の実際の help 表示確認 | ✓ | `artifacts --help` 実行で move 文言・`--project-root` 両方表示確認 |

### 3. テンプレート検証

#### 3-1. curly-brace プレースホルダ残存ゼロ

```
grep -c '{{OUTPUT_DIR}}' skills/cmux-team/templates/ja/conductor-role.md    → 0
grep -c '{{OUTPUT_DIR}}' skills/cmux-team/templates/en/conductor-role.md    → 0
grep -c '{{WORKTREE_PATH}}' skills/cmux-team/templates/ja/conductor-role.md → 0
grep -c '{{WORKTREE_PATH}}' skills/cmux-team/templates/en/conductor-role.md → 0
```

`{{PROJECT_ROOT}}` は Agent 起動手順（`PROMPT_DIR="{{PROJECT_ROOT}}/.team/prompts"`）と Step 8/9 の `cd {{PROJECT_ROOT}}` にのみ残存。これは `template.ts:generateConductorRolePrompt` で置換される正規の変数。

#### 3-2. 完了処理 12 ステップ順序

ja L326-487 / en L278-439 で確認:

| Step | 内容 | ja | en |
|------|------|-----|-----|
| 1 | 全フェーズ完了確認 | ✓ | ✓ |
| 2 | Agent タブ close | ✓ | ✓ |
| 3 | summary.md を `<OUTPUT_DIR>` に書き出す | ✓ | ✓ |
| 4 | `cd <WORKTREE_PATH>` + `git add -A` | ✓ | ✓ |
| 5 | 調査系判定 | ✓ | ✓ |
| 6 | [調査系のみ] artifact 登録 + `git add .team/artifacts/` | ✓ | ✓ |
| 7 | `git commit` | ✓ | ✓ |
| 8 | 納品（merge or PR） | ✓ | ✓ |
| 9 | worktree remove + branch -d | ✓ | ✓ |
| 10 | `cmux-team close-task` | ✓ | ✓ |
| 11 | 完了レポート表示 | ✓ | ✓ |
| 12 | `CONDUCTOR_DONE` 送信 | ✓ | ✓ |

#### 3-3. 調査系判定ロジック

ja L349-359 / en L301-311 で「**1 が true かつ (2 または 3) が true**」と明記。1（`git diff --cached --quiet`）は必須、2（キーワード）・3（レポートファイル）は補助条件。「2/3 ヒット」ではなく、正しく階層化されている。1 が false の場合「無条件で非調査系」と明記されており、判定例 3 ケース（修正系 / 実装系 / 純粋調査系）も列挙。

#### 3-4. `--project-root "$(pwd)"` フラグ使用

ja L395-400 / en L347-352 で確認:

```bash
cmux-team artifacts add "$SRC" \
  --project-root "$(pwd)" \
  --type <research|decision|session|spec|report> \
  --title "<タスク概要を 1 行で>"
```

env 上書き方式（`PROJECT_ROOT=$(pwd)`）は使われていない。旧案棄却理由も ja L392 / en L344 に明記。

#### 3-5. フロー分岐表に「調査系」+ Phase 0（Research）セクション

- 分岐表: ja L25-30 / en L25-30 に「調査系 / Research」行を追加（最上位レベル）。「コード変更ゼロ、調査系キーワード、または出力物がドキュメントのみ」の条件で「Phase 0 → Phase 4」フロー
- Phase 0: ja L42-54 / en L42-54 に新設。Researcher spawn → await → research.md 確認 → Plan/Design Review skip → Phase 4 へ

#### 3-6. Researcher spawn 用 heredoc サンプル + 注記

- heredoc サンプル: ja L195-248 / en L147-200 に `Researcher Agent 起動サンプル` セクションで完全なサンプルを提供
- 注記: ja L250-252 / en L202-204 に「`templates/{ja,en}/researcher.md` は `--prompt-file` に直接渡してはならない。必ず Conductor 内で heredoc で最終プロンプトを組み立てる」と明記

#### 3-7. プロジェクト独自 `artifacts/` 非推奨段落

ja L318-322 / en L270-274 の「完了時の処理」/ `Completion Procedures` 冒頭に非推奨段落あり。「repo 直下 `artifacts/` フォルダは .team/artifacts/ に一元化」「マイグレーションは task 側で手動」と記載。

### 4. 警告ボックス（implementer.md / researcher.md）

4 ファイル全てに「出力先のルール（重要）/ Output location rules (important)」警告ボックスが追加されている:

| ファイル | 位置 | 内容確認 |
|---------|------|----------|
| `ja/implementer.md` L113 | `## 出力` 直前 | OUTPUT_DIR 一元化・project-level `artifacts/` 非推奨・`.team/artifacts/` 直書き禁止・`artifacts/foo.md` は `OUTPUT_DIR/foo.md` 解釈・Conductor move 動作 5 項目全て記載 |
| `en/implementer.md` L113 | `## Output` 直前 | 同上（英訳） |
| `ja/researcher.md` L18 | `## 出力フォーマット` 直前 | 同上 |
| `en/researcher.md` L18 | `## Output Format` 直前 | 同上 |

### 5. ja/en 見出し diff

```
diff <(awk '/^###? /{print}' .../ja/conductor-role.md | nl) \
     <(awk '/^###? /{print}' .../en/conductor-role.md | nl)
```

→ 両方 29 見出し、順序完全一致。差分は言語違いのみ。Phase 0 → Phase 4、Step 5 → Step 12、Researcher サンプル位置、非推奨段落位置すべて対応。

### 6. `bun tsc --noEmit`

```
cd skills/cmux-team/manager && bun tsc --noEmit
EXIT=0
```

出力なし・エラー 0 件。タッチしたファイル（`artifact.ts` / `main.ts` / `i18n.ts`）いずれも新規エラーなし。T197 の「touched files zero errors」ルール充足。

### 7. 機能テスト（move 動作 + `--project-root`）

```bash
rm -rf /tmp/t198-inspect && mkdir -p /tmp/t198-inspect/.team/artifacts
cat > /tmp/t198-inspect/test-src.md << NOTE
# test source file
NOTE
bun .../main.ts artifacts add /tmp/t198-inspect/test-src.md \
  --project-root /tmp/t198-inspect \
  --type research --title "Inspector Move Test"
```

実行結果: `追加しました A001 → /tmp/t198-inspect/.team/artifacts/A001-test-src.md` / EXIT=0

検証:

| 項目 | 結果 |
|------|------|
| `test-src.md` が削除されている | ✓ (`ls /tmp/t198-inspect/` で source 消失確認) |
| `.team/artifacts/A001-test-src.md` が生成 | ✓ |
| frontmatter 正しく付与 | ✓ (`id: A001 / type: research / title: "Inspector Move Test" / created: 2026-04-15T... / author: master`) |
| stderr に unlink 警告なし | ✓ |

## Findings

### Critical

なし。

### Major

なし。

### Minor

1. **相対パス srcPath の解決について（任意）** — 機能テスト中、`cd /tmp/t198-inspect && bun main.ts artifacts add ./test-src.md --project-root "$(pwd)" ...` と相対パスで呼ぶと「ファイルが見つかりません」で失敗するケースを観測した。絶対パスで再実行すると正常動作するため、実用上は問題なし（Conductor テンプレート側の Step 6 サンプルは `"$SRC"`（絶対パス変数）を使うため該当しない）。ただし CLI として相対パスも受け付ける `main.ts:2809` の `filePath.startsWith("/") ? filePath : join(process.cwd(), filePath)` の挙動を将来的に再確認する余地あり。本 plan のスコープ外。

2. **design-review で m-3 として指摘された i18n 文面の短縮** — 英語 help の "move a file into .team/artifacts/ (source is removed on success)" は approved 扱いで実装済みだが、若干冗長。approved 済みなので修正不要。

## Fix Required

NOGO ではないため、修正必須項目なし。
