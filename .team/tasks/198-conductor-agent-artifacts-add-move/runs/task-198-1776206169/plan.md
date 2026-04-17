# 実装計画: T198 — Conductor/Agent テンプレート見直し + `artifacts add` を move 化

## 改訂履歴

- 2026-04-15: Design Review 1 回目のフィードバックを反映（C-1, M-1, M-2, M-3, M-4, 順序整理）

## ゴール

1. `cmux-team artifacts add` を **copy → move** に変更し、ソース残存による二重管理を防ぐ
2. Conductor / Implementer / Researcher テンプレートに「成果物は OUTPUT_DIR に一元化、`artifacts/` 直書き禁止」ルールを明記
3. Conductor の完了処理で、**commit 前**に `artifacts add` を実行して worktree 内 `.team/artifacts/Axxx-*.md` をコミット対象に含める
4. 「調査系タスク」を軽微/中規模/大規模とは別の経路として明示し、Researcher ロール → Inspection のフローを復活
5. ja / en 両方を並行更新

**実装担当者は本 plan.md のみを見て作業を完遂できる粒度で記述する**。不明点はこの plan.md に留める。

## 事前調査結果（ソース・オブ・トゥルース）

### 現状の動作

| 対象 | 現状 | 備考 |
|------|------|------|
| `artifact.ts` `addArtifact()` | `writeFile(dest)` のみ。srcPath は残る | `fs/promises` から `readFile / writeFile / mkdir` のみ import。`unlink` 未使用。`opts.projectRoot` は既に受け取っている |
| `main.ts` `cmdArtifacts` → `add` | L2803-2825。`getArg("tags")` を含む 5 オプションを `addArtifact()` に渡し、`{ id, destPath }` を受けて `console.log(t("artifact_added"))` するだけ | ソースファイル削除ロジックなし。`--project-root` オプションは未対応 |
| `i18n.ts` `help_artifacts` (en L458-494 / ja L977-1013) | L466 / L985 に `add <file>` 行。"add a file as an artifact" / "ファイルをアーティファクトとして追加" | move 動作・`--project-root` は未言及 |
| `i18n.ts` `help_main` (en L537 / ja L1056) | 同じく "add a file as an artifact" / "ファイルをアーティファクトとして追加" | **全体ヘルプ側にも copy 的説明が残っているため、更新対象に含める必要がある** |
| `cmdSpawnAgent` (main.ts:1407-1581) | `--role` 文字列をそのまま env / ログ / team.json に記録。ホワイトリスト検証なし。モデル解決は `getModelForRole(config, "agent", …)` 固定キー | `--role researcher` は**既に動作可能**（コード変更不要） |
| `templates/ja/researcher.md`・`en/researcher.md` | 既に存在。`{{COMMON_HEADER}} / {{TOPIC}} / {{SUB_QUESTIONS}} / {{OUTPUT_FILE}}` を使用 | **`--prompt-file` に直接渡すと未展開変数が残るため、Conductor が bash heredoc で手組みする必要がある** |
| `template.ts` `generateResearcherPrompt()` | **存在しない** | Researcher プロンプト生成関数は未実装。Conductor が bash で prompt ファイルを組み立てる |
| `templates/ja/conductor-role.md` Step 6 | L267-292。`cmux-team artifacts add` を呼ぶが、`{{OUTPUT_DIR}}` / `{{PROJECT_ROOT}}` をリテラルで書いている | **これは既存バグ**。conductor-role.md では `{{PROJECT_ROOT}}` しか展開されないため、`{{OUTPUT_DIR}}` は runtime prompt に残る。本タスクで一緒に是正 |
| `templates/en/conductor-role.md` | **Step 6 の artifact 化ステップが存在しない**（L184-250） | ja との重大な drift。Step 6 = worktree 削除、Step 7 = close-task の順で進む |
| 複雑度分岐（ja L17-29 / en L17-29） | 軽微 / 中規模 / 大規模 の 3 レベル。調査系を別カテゴリとして扱う概念なし | 現状はすべて Implementer 経路に流れる |
| `implementer.md` (ja/en) | 出力先に `{{OUTPUT_FILE}}` を書くとのみ指示 | `artifacts/` 直書き禁止ルール未記載 |
| `researcher.md` (ja/en) | 同上 | 同上 |

### template.ts の展開対象（重要な前提）

`template.ts:58-77` の `generateConductorRolePrompt` は以下のみ置換する:

```ts
content = content.replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot);
```

一方 `generateConductorTaskPrompt` (L107-119) は `{{WORKTREE_PATH}}` / `{{OUTPUT_DIR}}` / `{{PROJECT_ROOT}}` / `{{CONDUCTOR_ID}}` / `{{TASK_CONTENT}}` / `{{BASE_BRANCH}}` を置換する。

**結論**: **`conductor-role.md` 内で curly brace `{{VAR}}` が有効なのは `{{PROJECT_ROOT}}` のみ**。他の変数（`OUTPUT_DIR` / `WORKTREE_PATH` 等）は `<OUTPUT_DIR>` / `<WORKTREE_PATH>` の **angle-bracket プレースホルダ** で書き、「タスク割り当てで指定された値に Conductor が置換して実行する」と説明する。これは既存 ja Phase 1〜4（L37, L44, L50, L60, L70, L76）で採用されている表記に揃える。

### PROJECT_ROOT と worktree の関係（重要な前提）

- `findProjectRoot()` (main.ts:47-61) は env `PROJECT_ROOT` を最優先、次に cwd から walk-up で `.team/` を探す
- Conductor spawn 時に env `PROJECT_ROOT=<main repo>` が焼き付く（main.ts:1506）
- 何も対策しないと、worktree 内で `cmux-team artifacts add` を実行しても dest は `<main repo>/.team/artifacts/` に書かれ、worktree の working tree には現れない → `git add` できない
- **対策（旧案）**: `PROJECT_ROOT=<WORKTREE_PATH>` を 1 コマンドだけプレフィックスで上書きする
- **対策（新案・採用）**: `cmux-team artifacts add --project-root <path>` フラグを新設する。env 上書き方式は `log()` が worktree 側 `.team/logs/manager.log` に書き込み、worktree 削除でログが消える副作用があるため棄却（下記 Q8 参照）

### OUTPUT_DIR の物理位置

- `template.ts:112` で `OUTPUT_DIR = join(projectRoot, outputDir)` = 常に main repo の `.team/output/<taskRunId>/`
- `.team/output/` は gitignore 済みなので worktree には物理的に存在せず、Agent/Conductor が main repo 側の絶対パスに読み書きする
- したがって、`artifacts add` の srcPath は main repo 側、destPath は `--project-root` で指定した worktree 側という **クロスパス move** になる
- fs.writeFile → fs.unlink の順で問題なく動作する（異なるディレクトリ間の移動と等価）

### 現在の Step 順序（ja L239-323 の要約）

```
1. 全フェーズ確認
2. Agent タブ close
3. cd <worktree>; git add -A; git diff --cached --quiet || git commit -m ...
4. Deliver（merge or PR）
5. summary.md 作成
6. [調査系のみ] cd {{PROJECT_ROOT}}; cmux-team artifacts add {{OUTPUT_DIR}}/summary.md ...  ← 既存バグ
7. worktree remove
8. close-task
9. 完了レポート表示
10. send CONDUCTOR_DONE
```

**問題**:
1. Step 3 でコード変更（0 件）を既にコミット済みのところに Step 6 で artifact ファイルが main repo 側に降ってくる。この artifact は worktree には存在せず、git 履歴にも残らない
2. Step 6 の bash 例が `{{OUTPUT_DIR}}` / `{{PROJECT_ROOT}}` を使っているが、conductor-role.md では `{{PROJECT_ROOT}}` しか展開されない → `{{OUTPUT_DIR}}/summary.md` というリテラルパスで実行されて失敗する（既存バグ）

## 変更方針

### A. `artifact.ts` を move 化

**対象**: `skills/cmux-team/manager/artifact.ts`

#### A-1. import に `unlink` を追加

L4 を変更:

```ts
// before
import { readdir, readFile, writeFile, mkdir } from "fs/promises";

// after
import { readdir, readFile, writeFile, mkdir, unlink } from "fs/promises";
```

#### A-2. `addArtifact` の先頭 JSDoc を move 動作を明記するものに差し替える

L159-161 を変更:

```ts
// before
/**
 * 既存ファイルをアーティファクトとして登録
 */

// after
/**
 * 既存ファイルをアーティファクトとして登録（move 動作）。
 *
 * srcPath の内容を読み取り、フロントマターを付与した上で
 * `{projectRoot}/.team/artifacts/<id>-<slug>.md` に書き出し、
 * 書き出し成功後に srcPath を削除する。
 *
 * srcPath の削除に失敗した場合は CLI 全体としては成功扱いにし、
 * 呼び出し側にはログ警告だけを返す（二重管理防止がメインゴールで、
 * srcPath の残存は手動で回収可能なため）。
 */
```

#### A-3. `addArtifact` 本体末尾で `unlink(srcPath)` を呼ぶ

L213-218 を変更:

```ts
// before
  const destPath = join(artifactsDir, destFileName);
  await writeFile(destPath, output, "utf-8");

  return { id, destPath };
}

// after
  const destPath = join(artifactsDir, destFileName);
  await writeFile(destPath, output, "utf-8");

  // move 動作: 書き出し成功後にソースを削除。失敗しても CLI は成功扱い。
  let unlinkWarning: string | undefined;
  try {
    await unlink(opts.srcPath);
  } catch (e: any) {
    unlinkWarning = `unlink failed: ${e?.message ?? e}`;
  }

  return { id, destPath, unlinkWarning };
}
```

#### A-4. 戻り値の型を拡張

L162 の戻り値型を変更:

```ts
// before
export async function addArtifact(opts: AddArtifactOpts): Promise<{ id: string; destPath: string }> {

// after
export async function addArtifact(
  opts: AddArtifactOpts,
): Promise<{ id: string; destPath: string; unlinkWarning?: string }> {
```

**注**: `opts.projectRoot` は既に `AddArtifactOpts` で受けており、内部の destPath 計算にも利用されているため変更不要（M-3 対応で `--project-root` フラグを新設しても artifact.ts 側の変更は発生しない）。

### B. `main.ts` の `cmux-team artifacts add` 呼び出し側で警告ログ + `--project-root` フラグ受け取り

**対象**: `skills/cmux-team/manager/main.ts`

#### B-1. L2815-2823 の呼び出し箇所に `--project-root` の取り込みと unlink 警告ハンドリングを追加

```ts
// before
    const tagsRaw = getArg("tags");
    const result = await addArtifact({
      projectRoot: PROJECT_ROOT,
      srcPath: absPath,
      type: getArg("type"),
      title: getArg("title"),
      task: getArg("task"),
      tags: tagsRaw ? tagsRaw.split(",").map(s => s.trim()) : undefined,
    });
    console.log(t("artifact_added", { id: result.id, path: result.destPath }));
    return;

// after
    const tagsRaw = getArg("tags");
    const projectRootOverride = getArg("project-root");
    const result = await addArtifact({
      projectRoot: projectRootOverride ?? PROJECT_ROOT,
      srcPath: absPath,
      type: getArg("type"),
      title: getArg("title"),
      task: getArg("task"),
      tags: tagsRaw ? tagsRaw.split(",").map(s => s.trim()) : undefined,
    });
    console.log(t("artifact_added", { id: result.id, path: result.destPath }));
    if (result.unlinkWarning) {
      // move 動作: dest 書き出しは成功したが src 削除に失敗した場合。
      // CLI は成功扱い（exit 0）だが、ログと stderr に警告を残す。
      console.error(`warning: source file not removed (${result.unlinkWarning}). Please remove ${absPath} manually.`);
      await log("artifact_add_unlink_failed", `src=${absPath} dest=${result.destPath} reason=${result.unlinkWarning}`);
    }
    return;
```

**重要**:
- `projectRootOverride` を導入することで、Conductor は `--project-root "$(pwd)"` を渡して worktree 内の `.team/artifacts/` に書き出せる
- `log()` は `process.env.PROJECT_ROOT` を参照するため **env を上書きしない限り main repo 側の `.team/logs/manager.log` にログが残る**。これにより unlink 失敗時の観測性が保たれる
- `log` は `logger.ts` からすでに import 済み（main.ts 冒頭参照）。未 import なら追加すること

### C. i18n.ts の help 文言更新（ja/en、`help_artifacts` と `help_main` 両方）

**対象**: `skills/cmux-team/manager/i18n.ts`

**修正対象行（`rg -n` で再確認済み）**:

| locale | セクション | 行 | 対応 |
|--------|----------|-----|------|
| en | help_artifacts | L466 (`add <file>` の行) | move 文言に差し替え + `--project-root` 追記 |
| en | help_artifacts | L458 (section description) | move 動作を 1 行追記 |
| en | help_main | L537 (`cmux-team artifacts add <file>` の行) | move 文言に差し替え |
| ja | help_artifacts | L985 (`add <file>` の行) | move 文言に差し替え + `--project-root` 追記 |
| ja | help_artifacts | L977 (section description) | move 動作を 1 行追記 |
| ja | help_main | L1056 (`cmux-team artifacts add <file>` の行) | move 文言に差し替え |

#### C-1. 英語 `help_artifacts` — `add <file>` 行 (L466) と説明

```
// before (L466)
  add <file>             add a file as an artifact

// after
  add <file>             move a file into .team/artifacts/ (source is removed on success)
```

同 section の options エリアに `--project-root <path>` を追記（`--tags` 行の直後）:

```
  --project-root <path>   (add) override project root (destination .team/artifacts/ lives under this)
```

section description (L458 `help_artifacts:` の直下 1 行):

```
// before
cmux-team artifacts -- manage artifacts

// after
cmux-team artifacts -- manage artifacts (add moves the file, not copy)
```

#### C-2. 日本語 `help_artifacts` — `add <file>` 行 (L985) と説明

```
// before (L985)
  add <file>             ファイルをアーティファクトとして追加

// after
  add <file>             ファイルを .team/artifacts/ に **移動** する（成功時にソース削除）
```

options エリアに追加:

```
  --project-root <path>   (add) プロジェクトルートを上書き（dest の .team/artifacts/ がここ基準になる）
```

section description (L977 `help_artifacts:` の直下 1 行):

```
// before
cmux-team artifacts -- アーティファクト管理

// after
cmux-team artifacts -- アーティファクト管理（add は move 動作）
```

#### C-3. `help_main` の更新（en L537 / ja L1056）

en L537:

```
// before
  cmux-team artifacts add <file>                   add a file as an artifact

// after
  cmux-team artifacts add <file>                   move a file into .team/artifacts/
```

ja L1056:

```
// before
  cmux-team artifacts add <file>                   ファイルをアーティファクトとして追加

// after
  cmux-team artifacts add <file>                   ファイルを .team/artifacts/ に移動
```

**注**: help_artifacts 側の文面は `--project-root` オプションを列挙するが、help_main 側はコマンド一覧なので move 動作の言及のみで十分（冗長回避 = m-3 対応）。

### D. `conductor-role.md` Step 4〜7 の改訂 + 完了処理順序の変更（ja/en 両方）

**対象**: `skills/cmux-team/templates/ja/conductor-role.md`, `skills/cmux-team/templates/en/conductor-role.md`

**重要**: en 版は現状 Step 6 = worktree 削除であり artifact 化ステップが存在しない。ja 版と同じ構造に揃える必要がある。

**重要（C-1 対応）**: conductor-role.md 内で curly brace `{{VAR}}` が有効なのは `{{PROJECT_ROOT}}` のみ。**`OUTPUT_DIR` / `WORKTREE_PATH` / `CONDUCTOR_ID` / `TASK_STATUS_FILE` 等は angle-bracket `<VAR>` プレースホルダで書く**（= 既存 Phase 1〜4 の慣習に揃える）。1 文明記:

```markdown
> **プレースホルダ表記について**: このロール定義で `{{PROJECT_ROOT}}` は実際の絶対パスに置換されるが、
> `<OUTPUT_DIR>` / `<WORKTREE_PATH>` / `<CONDUCTOR_ID>` 等の angle-bracket 表記は
> 「タスク割り当て時に conductor-task.md で渡された値を Conductor が埋める」ことを意味する。
> bash で実行する際は environment variable か実値に置換してから実行する。
```

#### D-1. 完了処理 Step の新しい順序（共通）

以下の順序に書き換える:

```
1. 全フェーズ完了確認
2. Agent タブ close (cmux-team kill-agent)
3. summary.md を <OUTPUT_DIR> に書き出す
4. cd <WORKTREE_PATH>; git add -A
5. [調査系判定] git diff --cached --quiet を使って判定
6. [調査系のみ] cmux-team artifacts add --project-root "$(pwd)" ... + 生成された .team/artifacts/Axxx-*.md を git add
7. git diff --cached --quiet || git commit -m "..."
8. 納品（merge or PR）
9. worktree remove + branch -d
10. cmux-team close-task
11. 完了レポートを画面表示
12. cmux-team send CONDUCTOR_DONE
```

**従来との差分**:
- summary.md 作成を commit の**前**に移動
- `git add -A` を先に実行してから調査系判定を行う（`git diff --cached --quiet` で一貫性のある判定）
- artifact 登録を commit の**前**に移動（従来は worktree 削除後）
- 調査系判定ロジックを明示（従来は「コード変更なし or キーワード」とだけ書いてあった）

#### D-2. Step 5（調査系判定）の具体ルール（共通）

テンプレ本文に以下を追加する:

```markdown
### Step 5: 調査系タスクかどうかを判定

**必ず `git add -A` の直後に判定すること。** タイミングを間違えると `git diff --cached` の結果が変わる。

以下の条件で判定する:

1. **(必須) コード・ドキュメント変更ゼロ**: `git diff --cached --quiet` が true（exit 0）。
   `git add -A` の**直後**に実行すること。
2. **(補助) タスク本文のキーワード**: タスク本文に「調査」「artifact」「まとめ」「ベストプラクティス」「レポート」「research」「report」「investigate」「summary」「best practice」のいずれかを含む
3. **(補助) 出力ディレクトリの成果物**: `<OUTPUT_DIR>` に `research.md`, `report.md`, `findings.md`, `notes.md` など summary.md 以外のレポート系 Markdown が存在する

**判定**: **1 が true かつ (2 または 3) が true** なら「調査系」とみなす。

- 1 が false（何かしら staging 済み変更がある）なら**無条件で非調査系**。実装・修正を含むタスクは Step 6 を skip する。
- 1 が true でも 2 と 3 が両方 false なら非調査系（例: 純粋な typo 修正で summary.md しかない）。

判定例:
- 「プロキシのバグを**調査**して修正してください」→ 1 false（修正コードを commit） → 非調査系 ✓
- 「auth のベストプラクティスを**まとめて**実装例を書いてください」→ 1 false（実装例を commit） → 非調査系 ✓
- 「X のドキュメントを調査してレポートを書いてください」→ 1 true + 2 true + 3 true → 調査系 ✓

迷う場合は非調査系扱いで構わない（artifact 化しそこねても summary.md が commit に含まれるので情報は失われない）。
```

#### D-3. Step 6（artifact 登録）の具体コマンド（共通）

```markdown
### Step 6: [調査系のみ] artifact を登録（commit 前に実行）

#### 6-1. 登録対象ファイルを選ぶ

優先順位:
1. `<OUTPUT_DIR>` 直下に `research.md` / `report.md` / `findings.md` 等のレポート系ファイルがあれば最優先
2. なければ `summary.md`

```bash
OUTPUT_DIR="<OUTPUT_DIR>"  # タスク割り当てで指定された値に置換する
SRC=""
for f in research.md report.md findings.md notes.md; do
  if [ -f "$OUTPUT_DIR/$f" ]; then SRC="$OUTPUT_DIR/$f"; break; fi
done
[ -z "$SRC" ] && SRC="$OUTPUT_DIR/summary.md"
```

#### 6-2. `--project-root` フラグで worktree に登録

**重要**: `cmux-team artifacts add` は move 動作（ソース削除）であり、destPath は
`<project-root>/.team/artifacts/Axxx-<slug>.md` に決まる。
この Step の目的は、destPath を **worktree 内**に配置して次の git commit に
含めることなので、`--project-root "$(pwd)"` で明示的にフラグ指定する。

（旧案の `PROJECT_ROOT=$(pwd)` env 上書きは **ログ出力先まで worktree に流れ、worktree 削除でログが消える** 副作用があるため棄却した。）

```bash
# この時点で cd <WORKTREE_PATH> 済みであること（Step 4）
cmux-team artifacts add "$SRC" \
  --project-root "$(pwd)" \
  --type <research|decision|session|spec|report> \
  --title "<タスク概要を 1 行で>"
```

`--type` の選び方:
- `research` — コード調査・技術調査・ドキュメント発掘系（迷ったらこれ）
- `decision` — 設計判断・方針決定系
- `session` — セッション要約
- `spec` — 要件・仕様整理
- `report` — 分析レポート・検品レポート

#### 6-3. 生成された artifact を git add する

move 動作なので `<OUTPUT_DIR>/research.md` は削除済み（`<OUTPUT_DIR>` は gitignore 配下なので影響なし）。
dest は `./.team/artifacts/Axxx-<slug>.md` に現れているので、再度 `git add` で staging する:

```bash
git add .team/artifacts/
```

#### 6-4. 登録された artifact ID を控える

`cmux-team artifacts add` の stdout から `Axxx` を拾い、後段の完了レポートの
【成果】項目に記載する。
```

#### D-4. Step 7（commit）の修正

ja L239-244 / en L191-196 の commit ステップを以下に置換（番号振り直し後の Step 7）:

```bash
# after (ja)
# この時点で cd <WORKTREE_PATH> 済みで、Step 4 で git add -A、
# 調査系なら Step 6 で .team/artifacts/ も追加済み
git diff --cached --quiet || git commit -m "feat: <タスク概要>"
```

en 側も同じ意味の英語文で書く（`# already cd'd to <WORKTREE_PATH>...`）。

#### D-5. ja 版 旧 Step 6（L267-292）の削除

ja L267-292 は新 Step 6 に吸収済みなので完全に削除する。併せて、旧 Step 6 内で使われている `{{OUTPUT_DIR}}` / `{{PROJECT_ROOT}}` のリテラル参照は既存バグだったため、この削除により是正される。

#### D-6. en 版 新規 Step の挿入

en 版は元々 artifact 化ステップが存在しない。Step 5（summary.md 作成）と commit の間に **新しい 3 ステップ**（git add → 調査系判定 → artifact 登録）+ **commit 順序の入替え**を挿入し、番号を振り直す。

#### D-7. 「プロジェクト独自の `artifacts/` フォルダ慣習は非推奨」の 1 段落追加（共通）

完了処理セクション冒頭または末尾に以下を追加:

```markdown
> **プロジェクト独自の `artifacts/` フォルダは非推奨**
>
> 一部プロジェクトは repo 直下に `artifacts/` フォルダを持つ慣習があるが、
> cmux-team 管理下のアーティファクトは `.team/artifacts/Axxx-*.md` に一元化する。
> 既存の project-level `artifacts/` はタスク側で手動マイグレーションする（本スキルは触らない）。
```

### E. 複雑度分岐に「調査系」レベルを追加 + Researcher ロール復活（ja/en 両方）

**対象**: ja L17-29 / en L17-29 の「フロー分岐」セクション

#### E-1. レベル表に「調査系」を追加

```markdown
| レベル | 条件 | フロー |
|--------|------|--------|
| **調査系** | コード変更ゼロ、タスク本文が「調査してほしい」「まとめてほしい」「レポートを書いてほしい」系、または出力物が research.md / report.md / notes.md 等のドキュメントのみ | Phase 0（Research）→ Phase 4（Inspection） |
| **軽微** | typo, 設定値変更, コメント修正, 単一ファイルのドキュメント修正 | Phase 3（Implementer）のみ |
| **中規模** | ... | ... |
| **大規模** | ... | ... |
```

判断基準の箇条書きに追加:

```markdown
- コード変更ゼロ + 調査系キーワード → 調査系（Researcher 経路）
```

#### E-2. Phase 0（Research）セクションを新設

Phase 1（Plan）の直前に挿入:

```markdown
### Phase 0: Research（調査系タスクのみ）

Researcher Agent を spawn し、調査レポート（research.md または report.md）を
`<OUTPUT_DIR>` に書き出させる。

1. Researcher 用 prompt ファイルを **Conductor が bash heredoc で手書きする**
   - `templates/<locale>/researcher.md` は `{{COMMON_HEADER}}` / `{{TOPIC}}` / `{{SUB_QUESTIONS}}` / `{{OUTPUT_FILE}}` 等の未展開変数を含むため、**`--prompt-file` に直接渡してはならない**（渡すと Agent に未展開のまま流れる）
   - `template.ts` に `generateResearcherPrompt()` は存在しない。Conductor 自身がテンプレートを参考に最終プロンプトを組み立てる
2. `cmux-team spawn-agent --role researcher --prompt-file <上記ファイル>` で Agent 起動
3. Agent の完了を `cmux-team await-agent` で待つ
4. `<OUTPUT_DIR>/research.md` が作成されていることを確認
5. **Plan / Design Review は skip**（調査は実装計画を必要としない）
6. Phase 4（Inspection）に進み、Inspector にレポート品質を検品させる
```

**注意**: 上記ブロックは ja/en 両方に入れる。英訳は意味を保って書く。

#### E-3. Researcher 用 prompt ファイル組み立てサンプル（共通、E-2 直下）

既存の impl agent 起動手順（ja L85-108 / en 対応箇所）と同じ構造で以下のサンプルを追加:

```bash
# Researcher prompt ファイルを Conductor が heredoc で手書き
PROMPT_DIR="{{PROJECT_ROOT}}/.team/prompts"
AGENT_ID="<CONDUCTOR_ID>-researcher-$(date +%s)"
PROMPT_FILE="${PROMPT_DIR}/${AGENT_ID}.md"
OUTPUT_DIR="<OUTPUT_DIR>"

mkdir -p "$PROMPT_DIR"

cat > "$PROMPT_FILE" << RESEARCHER_PROMPT
## Role: Researcher

あなたは cmux-team の Researcher Agent です。以下のトピックを調査し、
結果を ${OUTPUT_DIR}/research.md に書き出してください。

## リサーチトピック

<タスク本文から抜き出した調査対象を 1-3 行で>

## サブ質問（任意）

- <調査すべき質問 1>
- <調査すべき質問 2>

## 出力フォーマット

${OUTPUT_DIR}/research.md に Markdown で書き出すこと。以下のセクション構成を推奨:

1. 概要
2. 調査結果（サブ質問ごと）
3. 参考文献・出典
4. 結論・推奨事項

## 作業境界

- コード変更は行わない（調査と文書化のみ）
- \`.team/artifacts/\` には直接書かない（Conductor が完了処理で登録する）
- \`<OUTPUT_DIR>\` 以外には成果物を書かない

RESEARCHER_PROMPT

cmux-team spawn-agent \
  --conductor-surface "$CMUX_SURFACE" \
  --role researcher \
  --task-title "<調査トピック>" \
  --prompt-file "$PROMPT_FILE"

cmux-team await-agent --agent-surface <spawn の出力から> --conductor-surface "$CMUX_SURFACE"
```

**重要コメント（サンプル直下に付記）**:

```markdown
> `templates/{ja,en}/researcher.md` は人間向けのリファレンスで、`{{COMMON_HEADER}}` 等の未展開変数を含む。
> `--prompt-file` に直接渡してはならない。必ず上記のように Conductor 内で heredoc で最終プロンプトを組み立てる。
> impl agent の heredoc と同じパターン（ja 既存 L85-108）。
```

#### E-4. Agent 起動手順の既存サンプルの直後に `--role researcher` の 1 行例を追加

既存の spawn-agent サンプル（ja/en の impl agent 例）の直後に、短く:

```bash
# 調査系タスクの例は Phase 0 セクション参照
```

**確認済み事項**: `cmdSpawnAgent` (main.ts:1407-1581) は `--role` をホワイトリスト検証していないため、`researcher` 文字列はそのまま env / team.json / ログに通る。`getModelForRole(config, "agent", …)` は固定キー `"agent"` を使用するため、モデル解決に支障なし。**main.ts への変更は不要**。

### F. `implementer.md` / `researcher.md` に「出力先のルール」警告ボックスを追加

**対象**:
- `skills/cmux-team/templates/ja/implementer.md`
- `skills/cmux-team/templates/en/implementer.md`
- `skills/cmux-team/templates/ja/researcher.md`
- `skills/cmux-team/templates/en/researcher.md`

#### F-1. `implementer.md` (ja) — L113 の `## 出力` セクション直前に追加

```markdown
> **出力先のルール（重要）**
> - 成果物は OUTPUT_DIR 以下にのみ書く（`{{OUTPUT_FILE}}` などテンプレート変数に従う）
> - リポジトリルート直下の `artifacts/` フォルダには書かない（deprecated）
> - `.team/artifacts/` にも直接書かない（Conductor が `cmux-team artifacts add` で登録する）
> - タスク本文に `artifacts/foo.md` 等のリテラルパスが書かれていても、それは慣習的な指示であり、
>   実際には `OUTPUT_DIR/foo.md` に書くこと
> - Conductor が完了処理で `cmux-team artifacts add` を実行し、
>   `.team/artifacts/Axxx-<slug>.md` に **move**（ソース削除）する
```

#### F-2. `implementer.md` (en) — L113 の `## Output` 直前に追加

```markdown
> **Output location rules (important)**
> - Write deliverables only under OUTPUT_DIR (follow template vars such as `{{OUTPUT_FILE}}`)
> - Do not write to the repo-level `artifacts/` folder (deprecated)
> - Do not write directly to `.team/artifacts/` (the Conductor registers deliverables via `cmux-team artifacts add`)
> - Even if the task body literally says `artifacts/foo.md`, interpret it as a conventional label and write to `OUTPUT_DIR/foo.md`
> - The Conductor will **move** (not copy) the file into `.team/artifacts/Axxx-<slug>.md`
>   during completion processing
```

#### F-3. `researcher.md` (ja) — L18 の `## 出力フォーマット` 直前に同じ警告ボックスを追加

researcher 向けは「リサーチ成果物を OUTPUT_DIR に書け」という点を強調するが文面は implementer と共通で良い。

#### F-4. `researcher.md` (en) — L18 の `## Output Format` 直前に同じ警告ボックスを追加

### G. スコープ外（本 plan では触らない）

- PreToolUse hook で `.team/artifacts/*.md` への Write をブロック（task.md で明示的にスコープ外）
- 既存の project-level `artifacts/` ディレクトリの手動マイグレーション
- `--copy` フラグの新設

## ファイル変更リスト（実装順序）

| # | ファイル | 変更内容 | 依存 |
|---|----------|----------|------|
| 1 | `skills/cmux-team/manager/artifact.ts` | A-1〜A-4（unlink import、JSDoc、move 実装、戻り値型拡張） | なし |
| 2 | `skills/cmux-team/manager/main.ts` | B-1（`--project-root` 取り込み + artifact_add_unlink_failed 警告出力） | #1（型） |
| 3 | `skills/cmux-team/manager/i18n.ts` | C-1, C-2（`help_artifacts` ja/en）+ C-3（`help_main` ja/en 計 2 行） | なし（#1〜#2 と並行可） |
| 4 | `skills/cmux-team/templates/ja/conductor-role.md` | D（完了処理順序入替え + Step 4/5/6 新設 + 旧 Step 6 削除 + プレースホルダ表記修正） + E（Phase 0 Research + 調査系レベル + Researcher heredoc サンプル） | なし（ドキュメント）|
| 5 | `skills/cmux-team/templates/en/conductor-role.md` | D（en 版は artifact ステップ自体が欠落しているため挿入）+ E | #4 と並行可 |
| 6 | `skills/cmux-team/templates/ja/implementer.md` | F-1（警告ボックス） | なし |
| 7 | `skills/cmux-team/templates/en/implementer.md` | F-2（警告ボックス） | #6 と並行可 |
| 8 | `skills/cmux-team/templates/ja/researcher.md` | F-3（警告ボックス） | なし |
| 9 | `skills/cmux-team/templates/en/researcher.md` | F-4（警告ボックス） | #8 と並行可 |

**推奨順序**: #1 → #2 → #3（コア CLI）→ #4/#5（conductor-role.md 並行）→ #6/#7 → #8/#9

**理由**:
- CLI の挙動（move 化 + `--project-root`）が先に固まっていないと conductor-role.md の記述が検証できない
- conductor-role.md は ja/en の構造が drift しているため、片方ずつ書き換えた直後に diff を取って揃えるのが最も安全
- implementer/researcher の警告ボックスは独立変更なので最後に一括で

## テスト手順（実装後に必ず実施）

### T-1. TypeScript コンパイル確認

```bash
cd skills/cmux-team/manager
bun build --target=bun --outdir=/tmp/cmux-team-build main.ts 2>&1 | tee /tmp/build.log
# or
bunx tsc --noEmit
```

- エラー 0 件を確認
- `addArtifact` の戻り値型変更が呼び出し側（main.ts:2815）に伝播していること

### T-2. `cmux-team artifacts add` 手動検証（move 動作 + `--project-root`）

```bash
cd /tmp
mkdir -p /tmp/t198-test && cd /tmp/t198-test
mkdir -p .team/artifacts
cat > test-note.md << 'EOF'
# Test note
This is a test artifact.
EOF

# 実行（--project-root で指定）
bun run <repo>/skills/cmux-team/manager/main.ts artifacts add ./test-note.md \
  --project-root "$(pwd)" \
  --type research --title "Move test"

# 検証
ls test-note.md               # → No such file（src が削除された）
ls .team/artifacts/           # → A001-*.md が存在
cat .team/artifacts/A001-*.md # → フロントマターが付与されている
```

期待結果:
- stdout: `✓ Added artifact A001 → .team/artifacts/A001-*.md`
- stderr: 空（unlink 成功）
- src (`test-note.md`) は削除済み
- dest (`.team/artifacts/A001-*.md`) が存在しフロントマターあり

### T-3. `--project-root` なしの後方互換確認

```bash
# 従来どおり env PROJECT_ROOT または cwd から findProjectRoot() が解決する
cd <main repo>
bun run skills/cmux-team/manager/main.ts artifacts add /tmp/sample.md --type report --title "Compat test"
# → <main repo>/.team/artifacts/ に書かれる
```

### T-4. `unlink` 失敗時の警告ログ検証（任意）

readonly ディレクトリで src を作る等、unlink が失敗する状況を作る（スキップ可。A-3 のコードを目視レビューで確認）。

### T-5. help 文言の表示確認

```bash
cmux-team artifacts --help           # locale=en → "move a file into .team/artifacts/..."
LANG=ja_JP.UTF-8 cmux-team artifacts --help   # locale=ja → "ファイルを .team/artifacts/ に 移動 ..."
cmux-team --help                     # help_main 側も move 文言に変わっていること
```

### T-6. conductor-role.md の変数展開確認

```bash
# template.ts:generateConductorRolePrompt を叩いて .team/prompts/conductor-role.md を生成
# {{PROJECT_ROOT}} が置換され、<OUTPUT_DIR> / <WORKTREE_PATH> は angle-bracket のまま残ることを確認
grep -c '{{OUTPUT_DIR}}' .team/prompts/conductor-role.md   # → 0 件（全て削除されている）
grep -c '{{WORKTREE_PATH}}' .team/prompts/conductor-role.md # → 0 件
grep -c '<OUTPUT_DIR>' .team/prompts/conductor-role.md     # → 複数件（angle-bracket に統一されている）
```

**注意**: `{{WORKTREE_PATH}}` / `{{OUTPUT_DIR}}` は `conductor-role.md` では**展開されない**（template.ts:72 は `{{PROJECT_ROOT}}` のみ置換）。テンプレ本文に curly brace で書いてしまうと runtime prompt にそのまま残り bash が失敗する。**実装時はこの注意を守ること**。

### T-7. ja/en テンプレートの構造一致チェック

```bash
diff <(awk '/^###? /{print}' skills/cmux-team/templates/ja/conductor-role.md) \
     <(awk '/^###? /{print}' skills/cmux-team/templates/en/conductor-role.md)
```

期待結果: 見出しの数・順序が揃っている（内容が ja/en で対応する）

### T-8. 実機 E2E（任意、時間があれば）

- `cmux-team start` で daemon を立ち上げ、調査系タスクを 1 つ作成
- Conductor が Phase 0 → Phase 4 経路を取り、commit 前に artifact 登録が走ることをログで確認
- worktree 内に `.team/artifacts/Axxx-*.md` が現れ、コミットに含まれることを確認

## リスク・留意点

### R-1. unlink 失敗時の CLI exit code

方針: **exit 0 を維持**し、stderr に warning + ログに `artifact_add_unlink_failed` を残す。

理由:
- 主目的（`.team/artifacts/Axxx-*.md` の生成）は成功している
- unlink 失敗は権限問題 / 既に削除済み / 共有ストレージ問題で起きるが、いずれもクリティカルではない
- exit != 0 にすると Conductor の bash スクリプトが後続処理（commit / merge）を skip してしまい、成果物が失われる

### R-2. srcPath が absolute / relative 両方のケース

`main.ts:2809` で既に `filePath.startsWith("/") ? filePath : join(process.cwd(), filePath)` を実施済み。unlink は absolute path で呼ばれるので問題なし。

### R-3. `--project-root` フラグ採用による副作用の排除

- 旧案の `PROJECT_ROOT="$(pwd)" cmux-team artifacts add ...` 方式は `log()` が worktree 側 `.team/logs/manager.log` に書き込むため、worktree 削除でログが消失する（特に unlink 失敗時のトレース情報が失われる逆説）
- 新案（採用）では `log()` は main repo 側に書かれるため、unlink 失敗時の観測性が保たれる
- `artifact.ts` 側は既に `opts.projectRoot` を受けているのでロジック変更不要
- `main.ts` 側の変更は `--project-root` オプションを `getArg` で受け取るだけで小さい

### R-4. 既存の project-level `artifacts/` ディレクトリとの干渉

- 一部プロジェクト（Dear 等）が repo 直下に `artifacts/` フォルダを持つ慣習がある
- 本変更はそのフォルダを直接操作しない
- `implementer.md` / `researcher.md` の警告ボックスで「書かないこと」を明示する
- マイグレーションはタスク側で手動実施（スコープ外）

### R-5. 調査系判定の決定論性

- ① `git diff --cached --quiet` は決定論的な指標。staging 後に判定することで ① の真偽が一意に決まる
- ②③ は補助条件で、①が true のときのみ効く
- コード変更があるタスクは無条件で非調査系となり、誤判定しない
- 判定に迷う場合は非調査系扱いで構わない（summary.md は常に commit に含まれるため情報は失われない）

### R-6. Researcher ロール spawn の確認事項

- **確認済み**: main.ts:1407-1581 の `cmdSpawnAgent` は `--role` を任意文字列として受理
- **確認済み**: `getModelForRole(config, "agent", ...)` は固定キー `"agent"` を使うので role 文字列の違いはモデル解決に影響しない
- **確認済み**: `templates/{ja,en}/researcher.md` が既に存在
- **重要**: `templates/*/researcher.md` は `{{COMMON_HEADER}}` 等の未展開変数を含むため **`--prompt-file` に直接渡してはならない**。Conductor が heredoc で最終プロンプトを組み立てる必要がある（E-3 のサンプル参照）

### R-7. en/ja drift の恒久対策

本 plan での修正後、両者の見出し構造が一致することを T-7 で担保する。今後の修正でも必ず両方を更新する（CLAUDE.md の「プロンプト編集ルール」に準拠）。

### R-8. `.team/prompts/*.md`（ランタイム）の扱い

CLAUDE.md の「プロンプト編集ルール」に従い、**テンプレートのみを修正**する。`.team/prompts/conductor-role.md` は次回の `cmux-team start` で再生成されるので直接は触らない。ただし現行セッションで動いている Conductor は再起動するまで新しい conductor-role.md を読まないため、実機検証する場合は `cmux-team stop && cmux-team start` で再起動する。

### R-9. `.team/artifacts/` ID 採番の並行書き込みレース（備考・スコープ外）

本 plan の範囲外だが、Conductor が複数並行で `cmux-team artifacts add` を叩くと `nextArtifactId()` が read-then-write でアトミックでないため、同じ ID を返しうる。完了処理のフローは 1 タスク = 1 Conductor であり並行発生しないので直ちに問題にはならないが、将来的に並行処理が発生する場合はファイルロック or 乱数 suffix などを検討する必要がある。備考として残す。

## 完了条件

実装者チェックリスト:

- [ ] `artifact.ts` に `unlink` が追加され、`addArtifact` が move 動作になっている
- [ ] `main.ts` の `artifacts add` 呼び出し側が `--project-root` オプションと `unlinkWarning` をハンドリング
- [ ] `i18n.ts` の `help_artifacts` ja/en 両方で help 文言が「move」を明記し、`--project-root` を追記
- [ ] `i18n.ts` の `help_main` ja/en 両方（en L537, ja L1056）でも「move」を明記
- [ ] `bun build` / `tsc --noEmit` でコンパイルエラーなし
- [ ] 手動テスト T-2 で move 動作を確認（src 削除 + dest 作成 + フロントマター、`--project-root` 有効）
- [ ] 手動テスト T-3 で `--project-root` なしの後方互換を確認
- [ ] `conductor-role.md` ja/en 両方で以下を反映:
  - [ ] 完了処理の順序: summary.md → git add -A → 調査系判定 → [調査系のみ]artifact 登録 + git add → commit → merge → worktree remove → close-task
  - [ ] Step 5（調査系判定、① `git diff --cached --quiet` 必須 + ②③ 補助）新設
  - [ ] Step 6（`cmux-team artifacts add --project-root "$(pwd)"`）新設
  - [ ] ja 版の旧 Step 6（L267-292、`{{OUTPUT_DIR}}` リテラル参照のバグ含む）を削除
  - [ ] en 版に artifact 化ステップを新規追加（従来は存在しなかった）
  - [ ] **conductor-role.md 内で `{{OUTPUT_DIR}}` / `{{WORKTREE_PATH}}` を使っている箇所を全て `<OUTPUT_DIR>` / `<WORKTREE_PATH>` angle-bracket に統一**（`{{PROJECT_ROOT}}` のみ curly brace のまま）
  - [ ] プレースホルダ表記の説明を 1 段落で明記
  - [ ] プロジェクト独自 `artifacts/` 非推奨の 1 段落を追加
  - [ ] フロー分岐表に「調査系」レベルを追加
  - [ ] Phase 0（Research）セクションを新設
  - [ ] Researcher 用 prompt ファイルを heredoc で組み立てる bash サンプルを追加
  - [ ] 「researcher.md を `--prompt-file` に直接渡してはならない」の注記を追加
- [ ] `implementer.md` ja/en 両方で「出力先のルール」警告ボックスを追加
- [ ] `researcher.md` ja/en 両方で同警告ボックスを追加
- [ ] `diff` で ja/en の見出し構造が一致（T-7）
- [ ] `grep -c '{{OUTPUT_DIR}}' skills/cmux-team/templates/{ja,en}/conductor-role.md` が 0（T-6 相当の静的チェック）

## 備考

- **未変更ファイル**: `template.ts`, `cmux.ts`, `daemon.ts`, `conductor.ts` など CLI 以外のコアロジックは一切触らない
- **レビュー観点**: Inspector フェーズでは T-1（コンパイル）、T-2/T-3（move + `--project-root` 動作）、T-6（プレースホルダ静的チェック）、T-7（ja/en 構造一致）を必ず実施する
- **ロールバック**: artifact.ts / main.ts / i18n.ts は独立しているので、問題があればファイル単位で revert 可能
- **行番号の再確認**: 実装時は `rg -n` で行番号をその都度確認すること（特に `add <file>` 行は en L466 / ja L985、`help_main` 側の `artifacts add` 行は en L537 / ja L1056）
