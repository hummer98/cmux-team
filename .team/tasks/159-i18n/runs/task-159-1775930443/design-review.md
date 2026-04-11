# Design Review: テンプレート i18n 対応

## 判定: Changes Requested

## サマリー

ディレクトリ分離方式の選択は適切であり、`findTemplateDir()` の変更が最小限に抑えられている良い設計。ただし、template.ts 内のハードコード日本語文字列がテンプレートコンテンツに混入する問題と、Step 1 の移行手順に矛盾がある点を修正すべき。

## Findings

### Critical（必ず修正が必要）

1. **template.ts の `BASE_BRANCH` デフォルト値が日本語ハードコード**

   `template.ts:102` で `baseBranch || "main（デフォルト）"` となっている。この値は `{{BASE_BRANCH}}` プレースホルダーを通じて conductor-task テンプレートに展開される。英語環境のユーザーが受け取るプロンプト内に日本語テキストが混入する。

   ```typescript
   // 現状（template.ts:102）
   .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch || "main（デフォルト）");
   ```

   **修正案**: i18n.ts のメッセージシステムを利用するか、`locale` に応じて切り替える:
   ```typescript
   import { locale } from "./i18n";
   // ...
   const defaultBranch = locale === "ja" ? "main（デフォルト）" : "main (default)";
   .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch || defaultBranch);
   ```

### Important（修正推奨）

2. **Step 1 の移行手順と Step 3.4 の翻訳方向が矛盾**

   Step 1 は `for f in *.md; do mv "$f" "ja/$f"; done` で全14ファイルを `ja/` に移動する。しかし Step 3.4 で指摘されている通り、`common-header.md` と `researcher.md` は**既に英語**で記述されている（本レビューで実ファイルを確認済み）。Step 1 を実行すると、英語のファイルが `ja/` に配置される矛盾した中間状態になる。

   Step 3 で「`ja/` からコピーして `en/` に配置。`ja/` 版を日本語に翻訳」と記述されているため最終結果は正しいが、手順が分かりにくく、実行者がミスしやすい。

   **修正案**: Step 1 を以下に修正:
   ```bash
   cd skills/cmux-team/templates
   mkdir -p ja en
   # 既に英語のファイルは en/ に移動
   mv common-header.md en/
   mv researcher.md en/
   # 残り12ファイル（日本語）は ja/ に移動
   for f in *.md; do
     mv "$f" "ja/$f"
   done
   ```

3. **template.ts のエラーメッセージが日本語ハードコード**

   `template.ts:33`, `template.ts:47`, `template.ts:77` のエラーメッセージ `"npm install -g cmux-team を実行してください"` が日本語固定。テンプレート i18n の直接のスコープではないが、同じファイルを変更するため一緒に対処するのが自然。

   **修正案**: i18n.ts にメッセージを追加するか、最低限 `locale` で分岐:
   ```typescript
   const templateNotFound = locale === "ja"
     ? "Template directory not found. npm install -g cmux-team を実行してください"
     : "Template directory not found. Please run: npm install -g @hummer98/cmux-team";
   ```

4. **postinstall.js の影響に関する誤解**

   計画書 Section 4.3 で「`postinstall.js` がサブディレクトリを含めてコピーすることを確認」と記載されているが、実際の `postinstall.js` はテンプレートのコピーを一切行わない（`bun install` + `claude plugin add` + `statusline.sh` コピーのみ）。テンプレートは `package.json` の `files` フィールド（`"skills/cmux-team/templates/"` — 再帰的に含まれる）により npm パッケージに同梱され、`findTemplateDir()` がパッケージインストール先から直接参照する。

   **影響**: `package.json` の `files` フィールドはディレクトリ指定でサブディレクトリを再帰的に含むため、`templates/ja/` と `templates/en/` は自動的にパッケージに含まれる。`postinstall.js` の変更は**不要**。計画書の記述を正確に修正すべき。

### Minor（あれば改善）

5. **`findTemplateDir()` の重複コード**

   提案されている実装では、ロケール解決 + `en` フォールバックのロジックが2箇所（daemon 相対パス・プロジェクトローカル）で重複している。ヘルパー関数で共通化すると可読性が向上する:
   ```typescript
   function resolveLocalizedDir(base: string): string | null {
     const localized = join(base, locale);
     if (existsSync(join(localized, "master.md"))) return localized;
     const fallback = join(base, "en");
     if (existsSync(join(fallback, "master.md"))) return fallback;
     return null;
   }
   ```

6. **テスト手順のパス表記**

   Section 5.1 のテストスクリプトで `templates/ja/*.md` と記載されているが、実行時のカレントディレクトリによっては `skills/cmux-team/templates/ja/*.md` が正しい。テストの実行場所を明記するか、フルパスで記述すべき。

7. **`findTemplateDir()` のユニットテスト方法**

   Section 5.1 で `bun run skills/cmux-team/manager/template.ts` とあるが、`template.ts` はモジュールであり直接実行しても `findTemplateDir()` の戻り値は出力されない。テスト用のスクリプトを用意するか、`bun -e 'import { findTemplateDir } from "./skills/cmux-team/manager/template"; console.log(findTemplateDir())'` のような方法が必要。

## Recommendations

Critical #1（BASE_BRANCH デフォルト値）と Important #2（Step 1 の移行手順）を修正してから実装に進むことを推奨する。

修正すべき箇所のまとめ:

1. **plan.md Section 2.1**: `findTemplateDir()` の変更に加え、`generateConductorTaskPrompt()` の `BASE_BRANCH` デフォルト値も `locale` 対応する旨を追記
2. **plan.md Section 6 Step 1**: `common-header.md` と `researcher.md` を最初から `en/` に移動する手順に修正
3. **plan.md Section 4.3**: postinstall.js の記述を「変更不要（テンプレートコピーは行わない。`package.json` の `files` フィールドで npm パッケージに同梱される）」に修正
4. **plan.md Section 4.1**: template.ts のエラーメッセージ i18n を影響範囲に追加（推奨）
