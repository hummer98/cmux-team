# テンプレート i18n 対応 — 実装計画書

## 1. 設計方針の選択と理由

### 3つのアプローチの比較

| 方式 | メリット | デメリット |
|------|---------|-----------|
| **ディレクトリ分離** (`templates/ja/`, `templates/en/`) | 構造が明確、言語追加が容易、ファイル名が変わらない | `findTemplateDir()` の戻り値をロケール付きパスに変更する必要あり |
| **サフィックス** (`master.ja.md`, `master.en.md`) | フラット構造で見通しが良い、既存のディレクトリ構造を維持 | ファイル数が倍増（14→28）、`findTemplateDir()` の存在チェック（`master.md`）を変更する必要あり |
| **単一ファイル + セクション** | ファイル数が増えない | テンプレートが巨大化（各ファイル2倍）、パース処理が必要、可読性・メンテナンス性が著しく低下 |

### 選択: ディレクトリ分離方式

**理由:**

1. **既存コードへの影響が最小**: `findTemplateDir()` の戻り値に `/ja` or `/en` を付加するだけで、テンプレート読み込み側のファイル名参照（`master.md`, `conductor-role.md`, `conductor-task.md`）は一切変更不要
2. **i18n.ts との自然な統合**: `locale` の値（`"ja"` | `"en"`）がそのままサブディレクトリ名になる
3. **将来の言語追加が容易**: `templates/ko/` 等を追加するだけ。コード変更は `Locale` 型の拡張のみ
4. **ファイル名の安定性**: 全テンプレートのファイル名が同一のため、テンプレートを参照する他のコード（Conductor のプロンプト生成等）に影響なし

### ディレクトリ構造

```
skills/cmux-team/templates/
├── ja/                          # 日本語版
│   ├── common-header.md         # ← 新規作成（英語→日本語翻訳）
│   ├── master.md
│   ├── manager.md
│   ├── conductor.md
│   ├── conductor-role.md
│   ├── conductor-task.md
│   ├── researcher.md            # ← 新規作成（英語→日本語翻訳）
│   ├── architect.md
│   ├── planner.md
│   ├── design-reviewer.md
│   ├── implementer.md
│   ├── inspector.md
│   ├── dockeeper.md
│   └── task-manager.md
└── en/                          # 英語版
    ├── common-header.md         # ← 既存ファイルをそのまま移動（既に英語）
    ├── master.md
    ├── manager.md
    ├── conductor.md
    ├── conductor-role.md
    ├── conductor-task.md
    ├── researcher.md            # ← 既存ファイルをそのまま移動（既に英語）
    ├── architect.md
    ├── planner.md
    ├── design-reviewer.md
    ├── implementer.md
    ├── inspector.md
    ├── dockeeper.md
    └── task-manager.md
```

**デフォルト言語は英語 (en)**。`detectLocale()` が `ja` を検出できなかった場合は `en/` にフォールバックする。

## 2. template.ts の変更計画

### 2.1 findTemplateDir() の変更

現状: テンプレートディレクトリのルートパスを返す。
変更後: ロケールに応じたサブディレクトリパスを返す。

ロケール解決ロジックは2箇所（daemon 相対パス・プロジェクトローカル）で重複するため、ヘルパー関数で共通化する:

```typescript
import { locale } from "./i18n";

/** base ディレクトリからロケール付きテンプレートディレクトリを解決する */
function resolveLocalizedDir(base: string): string | null {
  const localized = join(base, locale);
  if (existsSync(join(localized, "master.md"))) return localized;
  // フォールバック: en
  const fallback = join(base, "en");
  if (existsSync(join(fallback, "master.md"))) return fallback;
  return null;
}

export function findTemplateDir(): string | null {
  // 1. daemon 自身からの相対パス
  const fromSelf = join(dirname(import.meta.path), "../templates");
  const resolved1 = resolveLocalizedDir(fromSelf);
  if (resolved1) return resolved1;

  // 2. プロジェクトローカル
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const local = join(projectRoot, "skills/cmux-team/templates");
  const resolved2 = resolveLocalizedDir(local);
  if (resolved2) return resolved2;

  return null;
}
```

**ポイント:**
- `resolveLocalizedDir()` ヘルパーで重複ロジックを共通化（Design Review Minor #5 対応）
- `locale` を import して使用（モジュールロード時に1回だけ評価される既存の仕組みをそのまま利用）
- ロケールディレクトリが存在しない場合は `en/` にフォールバック
- `generateMasterPrompt()`, `generateConductorRolePrompt()` は**変更不要**（`findTemplateDir()` の戻り値が変わるだけで、ファイル名の参照ロジックは同一）

### 2.2 generateConductorTaskPrompt() の BASE_BRANCH デフォルト値修正

**問題**: `template.ts:102` の `baseBranch || "main（デフォルト）"` が日本語ハードコードされており、英語環境のプロンプトに日本語テキストが混入する。

**修正**:
```typescript
import { locale } from "./i18n";

// generateConductorTaskPrompt() 内:
const defaultBranch = locale === "ja" ? "main（デフォルト）" : "main (default)";
content = content
  .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch || defaultBranch);
```

### 2.3 エラーメッセージの i18n 対応

**問題**: `template.ts` の3箇所のエラーメッセージ（行33, 47, 77）が日本語ハードコードされている:
- `"Template directory not found. npm install -g cmux-team を実行してください"`
- `"Conductor role template not found. npm install -g cmux-team を実行してください"`
- `"Conductor task template not found. npm install -g cmux-team を実行してください"`

**修正**: i18n.ts にメッセージを追加し、`t()` で参照する:

```typescript
// i18n.ts に追加:
template_dir_not_found: "Template directory not found. Please run: npm install -g @hummer98/cmux-team",
conductor_role_template_not_found: "Conductor role template not found. Please run: npm install -g @hummer98/cmux-team",
conductor_task_template_not_found: "Conductor task template not found. Please run: npm install -g @hummer98/cmux-team",
```

```typescript
// ja メッセージ:
template_dir_not_found: "Template directory not found. npm install -g @hummer98/cmux-team を実行してください",
conductor_role_template_not_found: "Conductor role template not found. npm install -g @hummer98/cmux-team を実行してください",
conductor_task_template_not_found: "Conductor task template not found. npm install -g @hummer98/cmux-team を実行してください",
```

```typescript
// template.ts で使用:
import { t } from "./i18n";

// 各 throw で:
throw new Error(t("template_dir_not_found"));
throw new Error(t("conductor_role_template_not_found"));
throw new Error(t("conductor_task_template_not_found"));
```

### 2.4 影響を受ける関数の確認

| 関数 | 変更 | 理由 |
|------|------|------|
| `findTemplateDir()` | **要変更** | ロケールサブディレクトリの解決ロジック追加 |
| `resolveLocalizedDir()` | **新規追加** | 重複ロジックの共通化ヘルパー |
| `generateMasterPrompt()` | **エラーメッセージのみ変更** | `t()` に置き換え |
| `generateConductorRolePrompt()` | **エラーメッセージのみ変更** | `t()` に置き換え |
| `generateConductorTaskPrompt()` | **BASE_BRANCH + エラーメッセージ変更** | `locale` でデフォルト値分岐 + `t()` に置き換え |

## 3. 英語版テンプレート作成の方針

### 3.1 翻訳ルール

1. **指示の意味は日英で同等** — 意訳はOKだが、指示の省略・追加はNG
2. **`{{VARIABLE}}` プレースホルダーはそのまま維持** — 変数名は英語のため変換不要
3. **コードブロック内のコマンドは変更しない** — `cmux-team spawn-agent` 等のCLIコマンドは共通
4. **コードブロック内のコメントは英語に** — コマンドと一緒にコピペされるため英語のほうが適切
5. **構造（見出しレベル、セクション順序）は同一に維持** — 差分管理を容易にするため

### 3.2 テンプレートカテゴリと翻訳量の見積もり

| カテゴリ | ファイル | 行数 | 翻訳量 | 備考 |
|---------|---------|------|--------|------|
| **大規模** | conductor.md, conductor-role.md | 308, 232 | 多 | bash スクリプトが多いため実際のテキスト量は行数ほど多くない |
| **中規模** | manager.md, master.md | 164, 145 | 中 | Manager は daemon 向け、Master はユーザー対話向け |
| **小規模** | planner.md, implementer.md, inspector.md, design-reviewer.md | 70, 78, 61, 60 | 少 | エージェントロール定義 |
| **最小** | conductor-task.md, researcher.md, architect.md, dockeeper.md, task-manager.md, common-header.md | 12-45 | 最小 | 短いテンプレート |

### 3.3 翻訳優先順位

1. **common-header.md** — 全エージェントの共通部分、最も影響範囲が広い（12行、最小）
2. **conductor-role.md, conductor-task.md, conductor.md** — Conductor 系はシステムの中核（合計 585行）
3. **master.md, manager.md** — ユーザー/daemon 向け（合計 309行）
4. **残りのエージェントロール** — researcher, architect, planner, design-reviewer, implementer, inspector, dockeeper, task-manager（合計 363行）

### 3.4 既に英語のテンプレート

`common-header.md` と `researcher.md` は**既に英語で記述されている**。これらは Step 1 で直接 `en/` に移動し、`ja/` 版は日本語に翻訳して新規作成する。

実際の翻訳方向:
- `common-header.md`: 英語（現状） → `en/` にそのまま移動、`ja/` 版を日本語で新規作成
- `researcher.md`: 英語（現状） → `en/` にそのまま移動、`ja/` 版を日本語で新規作成
- その他12ファイル: 日本語（現状） → `ja/` にそのまま移動、`en/` 版を英語で新規作成

## 4. 影響範囲

### 4.1 直接変更が必要なファイル

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/template.ts` | `findTemplateDir()` にロケール解決ロジック追加、`resolveLocalizedDir()` ヘルパー新規追加、`BASE_BRANCH` デフォルト値の `locale` 対応、エラーメッセージの `t()` 置き換え |
| `skills/cmux-team/manager/i18n.ts` | テンプレート関連エラーメッセージの追加（3件） |
| `skills/cmux-team/templates/ja/*.md` (14ファイル) | 現在の `templates/*.md` から移動（12ファイル）+ 新規翻訳作成（2ファイル: common-header, researcher） |
| `skills/cmux-team/templates/en/*.md` (14ファイル) | 現在の `templates/*.md` から移動（2ファイル: common-header, researcher）+ 英語版新規作成（12ファイル） |

### 4.2 変更不要なファイル（確認済み）

| ファイル | 理由 |
|---------|------|
| `manager/conductor.ts` | `generateConductorTaskPrompt()` を呼ぶだけ。template.ts の内部変更は透過的 |
| `manager/main.ts` (spawn-agent) | `--prompt-file` でプロンプトファイルのパスを渡すだけ。テンプレート選択は Conductor が行う |
| `manager/main.ts` (conductor) | `generateConductorRolePrompt()` を呼ぶだけ。template.ts の内部変更は透過的 |
| `manager/main.ts` (master) | `generateMasterPrompt()` → `.team/prompts/master.md` にコピー。template.ts の内部変更は透過的 |
| `manager/i18n.ts` | `detectLocale()` と `locale` の既存ロジックは変更不要。エラーメッセージの追加のみ |
| `manager/daemon.ts` | テンプレートに直接アクセスしない |
| `skills/cmux-agent-role/SKILL.md` | エージェント行動規範。テンプレートとは独立 |

### 4.3 パッケージング関連

| ファイル | 確認事項 |
|---------|---------|
| `.npmignore` | `templates/` が除外されていないことを確認（ディレクトリ指定でサブディレクトリも再帰的に含まれる） |
| `bin/postinstall.js` | **変更不要**。テンプレートコピーは行わない。`package.json` の `files` フィールド（`"skills/cmux-team/templates/"` — 再帰的にサブディレクトリを含む）で npm パッケージに同梱される。`findTemplateDir()` がパッケージインストール先から直接参照する |
| `package.json` | `files` フィールドに `"skills/cmux-team/templates/"` が含まれていることを確認するだけ。ディレクトリ指定は再帰的なので `templates/ja/` と `templates/en/` は自動的に含まれる |

## 5. テスト方針

### 5.1 ユニットレベルの確認

1. **`findTemplateDir()` の動作確認**:
   ```bash
   cd skills/cmux-team/manager

   # ja 環境
   CMUX_TEAM_LANG=ja bun -e 'import { findTemplateDir } from "./template"; console.log(findTemplateDir())'
   # → .../skills/cmux-team/templates/ja を返すこと

   # en 環境（デフォルト）
   CMUX_TEAM_LANG=en bun -e 'import { findTemplateDir } from "./template"; console.log(findTemplateDir())'
   # → .../skills/cmux-team/templates/en を返すこと

   # フォールバック確認
   CMUX_TEAM_LANG=zh bun -e 'import { findTemplateDir } from "./template"; console.log(findTemplateDir())'
   # → .../skills/cmux-team/templates/en を返すこと（デフォルト英語）
   ```

2. **テンプレート整合性チェック**:
   ```bash
   cd skills/cmux-team

   # 全テンプレートが ja/ と en/ の両方に存在すること
   diff <(ls templates/ja/) <(ls templates/en/)
   # → 差分なし

   # プレースホルダーの一致確認
   for f in templates/ja/*.md; do
     base=$(basename "$f")
     diff <(grep -o '{{[A-Z_]*}}' "templates/ja/$base" | sort -u) \
          <(grep -o '{{[A-Z_]*}}' "templates/en/$base" | sort -u)
   done
   # → 各ファイルで同一のプレースホルダーセットであること
   ```

### 5.2 E2E テスト

1. **日本語環境での起動**:
   ```bash
   CMUX_TEAM_LANG=ja cmux-team start
   # → .team/prompts/master.md が日本語であること
   # → .team/prompts/conductor-role.md が日本語であること
   ```

2. **英語環境での起動**:
   ```bash
   CMUX_TEAM_LANG=en cmux-team start
   # → .team/prompts/master.md が英語であること
   # → .team/prompts/conductor-role.md が英語であること
   ```

3. **タスク実行テスト（各言語）**:
   - タスクを作成し、Conductor に割り当てられること
   - Conductor が Agent を spawn する際、プロンプトが正しい言語で生成されること
   - Agent が正常に完了すること

## 6. 実装ステップ

### Step 1: ディレクトリ構造の作成と既存テンプレートの移動

**対象ファイル**: `skills/cmux-team/templates/*.md` → `skills/cmux-team/templates/ja/*.md` or `en/*.md`

```bash
cd skills/cmux-team/templates
mkdir -p ja en

# 既に英語のファイルは en/ に直接移動
mv common-header.md en/
mv researcher.md en/

# 残り12ファイル（日本語）は ja/ に移動
for f in *.md; do
  mv "$f" "ja/$f"
done
```

**完了条件**:
- `templates/en/` に `common-header.md`, `researcher.md` の2ファイルが存在すること
- `templates/ja/` に残り12ファイルが存在すること
- `templates/` 直下に .md ファイルがないこと

### Step 2: template.ts の変更

**対象ファイル**: `skills/cmux-team/manager/template.ts`, `skills/cmux-team/manager/i18n.ts`

変更内容:
1. `import { locale, t } from "./i18n"` を追加
2. `resolveLocalizedDir()` ヘルパー関数を新規追加
3. `findTemplateDir()` にロケール解決 + `en` フォールバックロジックを実装
4. `generateConductorTaskPrompt()` の `BASE_BRANCH` デフォルト値を `locale` で分岐
5. 3箇所のエラーメッセージを `t()` に置き換え
6. `i18n.ts` にテンプレート関連エラーメッセージを追加

**完了条件**:
- `findTemplateDir()` が `locale` に応じた正しいパスを返すこと
- `BASE_BRANCH` のデフォルト値が英語環境で `"main (default)"`、日本語環境で `"main（デフォルト）"` であること
- エラーメッセージが `locale` に応じた言語で表示されること

### Step 3: 英語版テンプレートの作成（Agent ロール）

**対象ファイル**: `skills/cmux-team/templates/en/` 配下

翻訳順:
1. `common-header.md` — 既に `en/` にあるのでそのまま。`ja/common-header.md` を日本語で新規作成
2. `researcher.md` — 既に `en/` にあるのでそのまま。`ja/researcher.md` を日本語で新規作成
3. `architect.md` (25行) — `ja/` から英語に翻訳して `en/` に作成
4. `dockeeper.md` (23行) — 同上
5. `task-manager.md` (22行) — 同上
6. `design-reviewer.md` (60行) — 同上
7. `inspector.md` (61行) — 同上
8. `planner.md` (70行) — 同上
9. `implementer.md` (78行) — 同上

**完了条件**: 各ファイルのプレースホルダーが `ja/` 版と一致すること

### Step 4: 英語版テンプレートの作成（システムロール）

**対象ファイル**: `skills/cmux-team/templates/en/` 配下

翻訳順:
1. `conductor-task.md` (45行)
2. `master.md` (145行)
3. `manager.md` (164行)
4. `conductor-role.md` (232行)
5. `conductor.md` (308行)

**完了条件**: 各ファイルのプレースホルダーとコードブロック内のコマンドが `ja/` 版と一致すること

### Step 5: パッケージング確認と整合性テスト

1. `.npmignore` が新しいディレクトリ構造を正しく扱うことを確認
2. `package.json` の `files` フィールドに `"skills/cmux-team/templates/"` が含まれていることを確認（サブディレクトリは再帰的に含まれるため変更不要のはず）
3. テンプレート整合性チェック（Section 5.1 のスクリプト）を実行

**完了条件**: `npm pack` で生成されるパッケージに `templates/ja/` と `templates/en/` の全ファイルが含まれること

### Step 6: E2E テスト

1. `CMUX_TEAM_LANG=ja cmux-team start` で日本語テンプレートが使用されることを確認
2. `CMUX_TEAM_LANG=en cmux-team start` で英語テンプレートが使用されることを確認
3. タスクの作成・実行が両言語で正常に動作することを確認

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | テンプレート分離方式 | ディレクトリ分離 | `findTemplateDir()` の変更が最小、ファイル名が安定、言語追加が容易 |
| D2 | 既存テンプレートの扱い | 英語ファイルは `en/`、日本語ファイルは `ja/` に直接移動 | SSOT を維持。各ファイルを正しい言語ディレクトリに初めから配置することで矛盾した中間状態を回避 |
| D3 | common-header.md と researcher.md の扱い | 既存（英語）を `en/` に移動、`ja/` 版を新規作成 | 現状が英語のため、英語→日本語の翻訳方向が正しい |
| D4 | フォールバック戦略 | locale ディレクトリ不在時は `en/` にフォールバック | デフォルト英語の要件に合致。未対応言語でもクラッシュしない |
| D5 | Conductor が Agent プロンプトを生成する際の言語 | template.ts 経由ではないため変更不要 | Conductor は `cat > $PROMPT_FILE` で直接プロンプトを書き出す。Conductor 自身が適切な言語のテンプレートで起動されていれば、生成するプロンプトも自然にその言語になる |
| D6 | i18n.ts の変更 | エラーメッセージ追加のみ | `detectLocale()` と `locale` エクスポートの既存ロジックは変更不要 |
| D7 | `findTemplateDir()` の重複コード | `resolveLocalizedDir()` ヘルパーで共通化 | 2箇所で同じロケール解決 + フォールバックロジックが必要なため、可読性向上のため共通化 |
| D8 | template.ts のエラーメッセージ | i18n.ts の `t()` で国際化 | 同ファイルを変更するため一緒に対処するのが自然。ユーザー向けメッセージの一貫性向上 |
| D9 | postinstall.js の扱い | 変更不要 | テンプレートコピーは行わない。`package.json` の `files` フィールドで npm パッケージに同梱される |

## 8. リスク

### 8.1 既存機能への影響

- **低リスク**: `findTemplateDir()` のみの変更で、呼び出し側の3関数はエラーメッセージの `t()` 置き換えのみ
- **対策**: 移行直後に `ja/` の内容が現行と完全一致することを `diff` で確認

### 8.2 Conductor の Agent プロンプト生成

- **リスク**: Conductor はテンプレートファイルを直接参照せず、`cat > $PROMPT_FILE` でプロンプトを動的生成する。テンプレートの i18n は Conductor 自身のプロンプト言語に依存する
- **対策**: Conductor のテンプレート（conductor.md, conductor-role.md）が正しく翻訳されていれば、Agent プロンプトも適切な言語で生成される。これは設計上の自然な帰結

### 8.3 パッケージングの互換性

- **リスク**: `package.json` の `files` フィールドがサブディレクトリを再帰的に含まない可能性（低リスク — npm の仕様上、ディレクトリ指定は再帰的）
- **対策**: Step 5 で `npm pack` の内容を明示的に確認

### 8.4 翻訳品質

- **リスク**: 日英間で指示の意味が乖離する可能性
- **対策**: プレースホルダー整合性チェックを自動化。レビューで内容の同等性を確認

### 8.5 BASE_BRANCH デフォルト値の混入

- **リスク**: `locale` import を忘れて修正漏れが発生する可能性
- **対策**: Step 2 で `findTemplateDir()` と同時に修正し、テストで英語環境のプロンプトに日本語が含まれないことを確認
