# 実装計画: `cmux-team artifacts add <file>` コマンド

## 概要

既存ファイルを `.team/artifacts/` にアーティファクトとして登録するサブコマンドを追加する。
ID（Axxx）は自動採番、フロントマターの有無に応じて生成/マージを行う。

## 変更ファイル一覧

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/artifact.ts` | `nextArtifactId()`, `addArtifact()` 関数を追加 |
| `skills/cmux-team/manager/main.ts` | `cmdArtifacts()` に `add` サブコマンド分岐を追加 |
| `skills/cmux-team/manager/i18n.ts` | ヘルプテキスト・エラー/成功メッセージを追加 |

## 詳細設計

### 1. artifact.ts への関数追加

#### 1-1. `nextArtifactId(projectRoot: string): Promise<string>`

- `loadArtifacts(projectRoot)` で既存アーティファクトを取得
- 各 `id` から数値部分を抽出（`A001` → `1`）
- 最大値 + 1 を `A` + 3桁ゼロパディングで返す
- アーティファクトが0件の場合は `A001` を返す

```typescript
export async function nextArtifactId(projectRoot: string): Promise<string> {
  const artifacts = await loadArtifacts(projectRoot);
  if (artifacts.length === 0) return "A001";
  const nums = artifacts
    .map(a => parseInt(a.id.replace(/^A/, ""), 10))
    .filter(n => !isNaN(n));
  const max = Math.max(0, ...nums);
  return `A${String(max + 1).padStart(3, "0")}`;
}
```

#### 1-2. `addArtifact(opts): Promise<{ id: string; destPath: string }>`

引数:
```typescript
interface AddArtifactOpts {
  projectRoot: string;
  srcPath: string;        // 元ファイルの絶対パス
  type?: string;          // --type
  title?: string;         // --title
  task?: string;          // --task
  tags?: string[];        // --tags
}
```

処理フロー:
1. `nextArtifactId()` で新規 ID を取得
2. 元ファイルを読み込む
3. フロントマター判定:
   - **既存フロントマターあり**: `parseArtifactMeta()` でパースし、以下を上書き/マージ:
     - `id` → 自動採番の値で常に上書き
     - `type` → CLI オプション指定があればそちら、なければ既存値を維持
     - `title` → CLI オプション指定があればそちら、なければ既存値を維持
     - `task` → CLI オプション指定があればそちら、なければ既存値を維持
     - `tags` → CLI オプション指定があればそちら、なければ既存値を維持
     - `created` → 既存値を維持（なければ現在時刻）
     - `updated` → 現在時刻を設定
     - `author` → 既存値を維持（なければ "master"）
   - **フロントマターなし**: 新規生成:
     - `id`: 自動採番
     - `type`: CLI オプション or `"research"`（デフォルト）
     - `title`: CLI オプション or ファイル名（拡張子除去、ハイフン→スペース）
     - `created`: 現在時刻（ISO 8601）
     - `author`: `"master"`
     - `task`: CLI オプション指定時のみ
     - `tags`: CLI オプション指定時のみ
4. フロントマター文字列を組み立て + 本文を結合
5. 宛先ファイル名: `{id}-{slug}.md`
   - slug: 元ファイル名から拡張子を除去（既に `Axxx-` prefix がある場合は除去）
6. `.team/artifacts/` ディレクトリが存在しなければ作成
7. 宛先にファイルを書き出す
8. `{ id, destPath }` を返す

フロントマター組み立て:
```typescript
function buildFrontmatter(meta: Partial<ArtifactMeta>): string {
  const lines = ["---"];
  lines.push(`id: ${meta.id}`);
  lines.push(`type: ${meta.type}`);
  lines.push(`title: "${meta.title}"`);
  lines.push(`created: ${meta.created}`);
  if (meta.updated) lines.push(`updated: ${meta.updated}`);
  lines.push(`author: ${meta.author}`);
  if (meta.task) lines.push(`task: ${meta.task}`);
  if (meta.tags && meta.tags.length > 0) {
    lines.push(`tags: [${meta.tags.join(", ")}]`);
  }
  lines.push("---");
  return lines.join("\n");
}
```

### 2. main.ts の cmdArtifacts() への追加

`cmdArtifacts()` 内、`--validate` 分岐の後、`show` 分岐の前に `add` サブコマンドを挿入する。

```typescript
// cmux-team artifacts add <file>
if (subCmd === "add") {
  const filePath = args[2];
  if (!filePath) {
    console.error(t("artifact_add_file_required"));
    process.exit(1);
  }
  // 絶対パスに変換
  const absPath = filePath.startsWith("/") ? filePath : join(process.cwd(), filePath);
  if (!existsSync(absPath)) {
    console.error(tf("artifact_add_file_not_found", { path: filePath }));
    process.exit(1);
  }
  const tagsRaw = getArg("tags");
  const result = await addArtifact({
    projectRoot: PROJECT_ROOT,
    srcPath: absPath,
    type: getArg("type"),
    title: getArg("title"),
    task: getArg("task"),
    tags: tagsRaw ? tagsRaw.split(",").map(s => s.trim()) : undefined,
  });
  console.log(tf("artifact_added", { id: result.id, path: result.destPath }));
  return;
}
```

import に `addArtifact` を追加:
```typescript
import { loadArtifacts, searchArtifacts, validateArtifact, addArtifact } from "./artifact";
```

### 3. i18n.ts のメッセージ追加

#### 英語（en）

固定メッセージ:
```
artifact_add_file_required: "Error: file path is required\nUsage: cmux-team artifacts add <file> [--type <type>] [--title <title>] [--task <id>] [--tags <tag1,tag2>]"
```

テンプレートメッセージ:
```
artifact_add_file_not_found: "Error: file not found: {path}"
artifact_added: "Added {id} → {path}"
```

ヘルプテキスト（`help_artifacts`）に `add` サブコマンドを追記:
```
Subcommands:
  (none)                  list artifacts (default)
  add <file>             add a file as an artifact
  show <id>              show artifact content
  search <query>         full-text search artifacts
```

Options に追記:
```
  --type <type>           (add) artifact type: research / decision / session / spec / report
  --title <title>         (add) artifact title
  --task <id>             (add) related task ID
  --tags <tag1,tag2>      (add) comma-separated tags
```

Examples に追記:
```
  cmux-team artifacts add ./research-notes.md
  cmux-team artifacts add ./design.md --type decision --title "Auth method selection"
```

#### 日本語（ja）

固定メッセージ:
```
artifact_add_file_required: "Error: ファイルパスを指定してください\nUsage: cmux-team artifacts add <file> [--type <type>] [--title <title>] [--task <id>] [--tags <tag1,tag2>]"
```

テンプレートメッセージ:
```
artifact_add_file_not_found: "Error: ファイルが見つかりません: {path}"
artifact_added: "追加しました {id} → {path}"
```

ヘルプテキスト・Options・Examples も同様に日本語版を追記。

### 4. エッジケース対応

| ケース | 対応 |
|--------|------|
| ファイルが存在しない | エラーメッセージ + exit(1) |
| `.team/artifacts/` ディレクトリ未作成 | `mkdirSync` で自動作成 |
| フロントマターがない `.md` ファイル | 新規フロントマターを付与 |
| フロントマターがあるファイル | id を自動採番で上書き、他は CLI オプション > 既存値 |
| `--type` に無効な値 | `validateArtifact()` は登録後の検証用なので、`add` 時にはそのまま受け入れる（既存の `list --validate` で後から検証可能） |
| 宛先ファイル名の衝突 | slug 生成で既存 `Axxx-` prefix を除去するため、ID が異なる限り衝突しない |

### 5. 実装順序

1. **artifact.ts**: `nextArtifactId()` と `addArtifact()` を追加（`buildFrontmatter()` も内部関数として）
2. **i18n.ts**: メッセージ追加（en, ja 両方）
3. **main.ts**: import 追加 + `cmdArtifacts()` に `add` 分岐追加
