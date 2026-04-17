# Plan: findTemplateDir の探索順序を project-local → installed に反転

## 概要

`skills/cmux-team/manager/template.ts` の `findTemplateDir()` の探索順序を反転し、dev リポジトリで作業中は常に repo HEAD のテンプレートを優先使用するようにする。併せて `template_dir_resolved` ログを追加して、どちらのソースから解決したかを監査可能にする。

## 変更ファイル

- `/Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110/skills/cmux-team/manager/template.ts`（唯一の変更対象）

grep で `findTemplateDir` の参照は template.ts 内のみ（3 箇所）、外部呼び出し元はなし。

## 現状の把握

### template.ts:20-34（変更前）

```typescript
export function findTemplateDir(): string | null {
  // 1. daemon 自身からの相対パス（manager/ の兄弟 templates/）
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

### 内部呼び出し元（template.ts 内の 3 箇所、すべて既に async）

| 行 | 関数 | 呼び出しパターン |
|---|---|---|
| L43 | `generateMasterPrompt` (async) | `const templateDir = findTemplateDir();` |
| L55 | `generateConductorRolePrompt` (async) | `const templateDir = findTemplateDir();` |
| L83 | `generateConductorTaskPrompt` (async) | `const templateDir = findTemplateDir();` |

### 外部呼び出し元の確認（grep 結果）

`skills/cmux-team/` 配下で `findTemplateDir` を参照するのは template.ts のみ。外部モジュールは `generateMasterPrompt` / `generateConductorRolePrompt` / `generateConductorTaskPrompt` を経由するだけで、`findTemplateDir` を直接呼び出していない。よって `findTemplateDir` のシグネチャ変更は template.ts 内で完結する。

### PROJECT_ROOT 設定タイミング

`main.ts:82-83` で daemon 起動の非常に早い段階で以下が実行される:

```typescript
const PROJECT_ROOT = findProjectRoot();
process.env.PROJECT_ROOT = PROJECT_ROOT;
```

したがって、`template.ts` の `process.env.PROJECT_ROOT` 参照時には必ず値が入っている前提でよい（テストも `process.env.PROJECT_ROOT = testDir` を設定する）。

## 実装ステップ

### Step 1. `findTemplateDir()` を async 化して探索順序を反転

方針: **async 化して内部でログする**。

**理由（sync のまま呼び出し側でログする案との比較）:**

- 呼び出し側 3 箇所で同じログロジックを重複させることになる
- ログ用に `findTemplateDir` の戻り値を `{ path, source }` 構造体に変える必要があり、呼び出し側 3 箇所が影響を受ける
- 全呼び出し元（`generateMasterPrompt` / `generateConductorRolePrompt` / `generateConductorTaskPrompt`）が既に async なので、`await findTemplateDir()` への書き換えは最小（各 1 行）
- `logger.ts` の `log()` は async でありログ出力のために async 化は必然

結論: async 化して `findTemplateDir` 内部で `await log("template_dir_resolved", ...)` を呼ぶ。

**変更後の実装（イメージ）:**

```typescript
export async function findTemplateDir(): Promise<string | null> {
  // 1. プロジェクトローカル（dev リポジトリを最優先）
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const local = join(projectRoot, "skills/cmux-team/templates");
  const resolved1 = resolveLocalizedDir(local);
  if (resolved1) {
    await log("template_dir_resolved", `path=${resolved1} source=project_local`);
    return resolved1;
  }

  // 2. daemon 自身からの相対パス（installed package のフォールバック）
  const fromSelf = join(dirname(import.meta.path), "../templates");
  const resolved2 = resolveLocalizedDir(fromSelf);
  if (resolved2) {
    await log("template_dir_resolved", `path=${resolved2} source=installed`);
    return resolved2;
  }

  return null;
}
```

**ポイント:**

- `resolveLocalizedDir()` ヘルパーは変更しない（制約）
- 戻り値型を `string | null` → `Promise<string | null>` に変更
- 「見つからなかった場合」のログは追加しない（呼び出し側が throw するのでそこで検出可能）

### Step 2. 3 つの呼び出し側で `await` を追加

`template.ts` 内の 3 箇所を一行ずつ書き換える:

```typescript
// 変更前
const templateDir = findTemplateDir();
// 変更後
const templateDir = await findTemplateDir();
```

対象:

- L43（`generateMasterPrompt`）
- L55（`generateConductorRolePrompt`）
- L83（`generateConductorTaskPrompt`）

すべての呼び出し元関数は既に `async` なので、シグネチャ変更は不要。

### Step 3. 外部呼び出しが無いことを再確認

念のため作業開始時に以下を再実行して 0 件を確認する:

```bash
rg -n 'findTemplateDir' skills/cmux-team/
```

現状、ヒットするのは template.ts の 4 箇所（宣言 1 + 呼び出し 3）のみ。他に現れたら作業を止めて調査する。

## ログ追加

### 出力イベント

`template_dir_resolved`（新規）

### フォーマット

```
template_dir_resolved path=<解決されたパス> source=project_local|installed
```

例:

```
[2026-04-15T...+09:00] template_dir_resolved path=/Users/yamamoto/git/cmux-team/skills/cmux-team/templates/ja source=project_local
[2026-04-15T...+09:00] template_dir_resolved path=/Users/.../lib/node_modules/@hummer98/cmux-team/skills/cmux-team/templates/ja source=installed
```

### 出力箇所

`findTemplateDir()` 内部（async 化後、各 return 直前）。1 回の daemon ライフサイクルで `findTemplateDir` は Master / Conductor-role / Conductor-task 毎に呼ばれるため複数行出るが、診断情報として有用なのでそのまま出す（ループ内の高頻度呼び出しではない）。

### 方式選択理由（再掲）

- **sync のまま呼び出し側 3 箇所でログする案**: 同じロジックが 3 箇所に散り、重複と漏れのリスクがある
- **async 化して内部でログする案（採用）**: 呼び出し側は `await` を 1 行追加するだけ、ロジック集中、外部呼び出し元がないためシグネチャ変更の影響が閉じている

タスク本文も「後者の方がクリーン」と明記しており、これに一致する。

## 型エラー対応

### 方針

T197 の「touched-files 型エラーゼロ化ルール」を適用。今回触る `template.ts` 1 ファイルについて、変更後に型エラーを 0 件にする。

### 実行コマンド

作業ディレクトリで以下を実行:

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110/skills/cmux-team/manager
bun run tsc --noEmit 2>&1 | rg template\.ts
```

（`tsconfig.json` が manager/ 配下にある想定。無ければ `bun x tsc --noEmit` をリポジトリルートから実行して template.ts のエラーのみを確認する）

### 想定エラー

`findTemplateDir()` を async 化したことで、以下のような型エラーが発生する可能性がある:

1. **`await` 忘れ**: 呼び出し側が `Promise<string | null>` を `string | null` として扱うことによる型ミスマッチ
   - 対応: Step 2 で全 3 箇所に `await` を追加済みなので発生しないはず
2. **外部呼び出し元での型エラー**: template.ts 外で直接 `findTemplateDir()` を呼んでいる箇所
   - 対応: 事前 grep で 0 件を確認済み。発生したら該当箇所に `await` を追加
3. **既存の無関係な型エラー**: template.ts に以前から存在する型エラー
   - 対応: T197 ルールは「touched files に対して 0 件」なので、発見したら修正する

### 修正方針

エラー発生箇所が template.ts 内であれば実装者が即修正。template.ts 外の呼び出し元で発生した場合は、当該ファイルに `await` を追加し、必要なら呼び出し元関数を async 化する（ただし現時点で想定なし）。

## テスト計画

### 1. ユニットテスト（bun test）

既存の `daemon.test.ts:258` が `generateConductorTaskPrompt` を async で呼び出しているテストを持つ。`findTemplateDir` 自体の単体テストは無いが、このテストが通れば async 化の回帰は検知できる。

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110
bun test skills/cmux-team/manager/daemon.test.ts
```

**期待結果**: 「Conductor タスクプロンプトの生成」テストが green。テストは `testDir` を `PROJECT_ROOT` に設定するが、`testDir/skills/cmux-team/templates/` は存在しないので project-local フォールスルーし、`fromSelf`（dev repo 側 templates）が使われる → 従来通り動作する。

### 2. `findTemplateDir` を直接叩くスモークテスト

作業ディレクトリ内で以下を実行:

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110
PROJECT_ROOT=$(pwd) bun -e 'import("./skills/cmux-team/manager/template").then(async m => { const r = await m.findTemplateDir(); console.log("resolved:", r); })'
```

**期待結果**: `resolved: /Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110/skills/cmux-team/templates/ja`（または `/en`）が出る。ログには `template_dir_resolved path=... source=project_local` が記録される。

### 3. installed フォールバックの確認

`PROJECT_ROOT` を templates が存在しない一時ディレクトリに設定して実行:

```bash
cd /tmp && mkdir -p /tmp/notemplates
PROJECT_ROOT=/tmp/notemplates bun -e 'import("/Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110/skills/cmux-team/manager/template").then(async m => { const r = await m.findTemplateDir(); console.log("resolved:", r); })'
```

**期待結果**: `resolved: .../skills/cmux-team/templates/ja`（`fromSelf` から解決）が出る。ログには `source=installed` が記録される。

> **注:** ここでの `fromSelf` は worktree 内の `skills/cmux-team/templates/` を指すが、これは「daemon 自身が置かれているディレクトリの兄弟」という意味で、通常のユーザー環境では `~/.../node_modules/@hummer98/cmux-team/...` になる。挙動の確認にはこれで十分。

### 4. ログ出力の検証

上記テスト実行後に `manager.log` を確認する:

```bash
rg 'template_dir_resolved' /tmp/notemplates/.team/logs/manager.log
rg 'template_dir_resolved' .team/logs/manager.log
```

**期待結果**: それぞれ `source=project_local` / `source=installed` のログが 1 行以上記録されていること。

### 5. 型チェック

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110
bun run tsc --noEmit 2>&1 | rg template\.ts
# もしくは manager/ 内に tsconfig があれば:
cd skills/cmux-team/manager && bun run tsc --noEmit 2>&1 | rg template\.ts
```

**期待結果**: template.ts に関する行が 0 件（touched-files ゼロエラー）。

### 6. daemon 起動 E2E（任意・重）

実装者の裁量で実施。tmux / cmux 環境が用意できるなら:

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110
# 別セッションで cmux を起動し、以下を実行
CMUX_TEAM_POLL_INTERVAL=5000 bun run skills/cmux-team/manager/main.ts start
# 数秒待って停止
bun run skills/cmux-team/manager/main.ts stop
# ログ確認
rg 'template_dir_resolved' .team/logs/manager.log
```

**期待結果**: 起動時ログに `template_dir_resolved source=project_local path=<worktree>/skills/cmux-team/templates/ja` が出ていること。

## 完了条件

タスク本文の「完了条件」を チェックリスト化:

- [ ] `findTemplateDir()` が project-local → installed の順で探索する
- [ ] dev リポジトリ（作業ディレクトリ）で `findTemplateDir()` を呼んだ際に `skills/cmux-team/templates/*` が解決される（runtime prompt が repo HEAD のテンプレートから生成される）
- [ ] `PROJECT_ROOT` に templates が存在しない場所を設定した場合でも、installed フォールバック（`import.meta.path` 起点）が動作する
- [ ] daemon 起動ログに `template_dir_resolved path=... source=project_local|installed` が出力される
- [ ] T197 の touched-files 型エラーゼロ化ルール自己適用 — 変更後に `bun run tsc --noEmit` で template.ts のエラーが 0 件
- [ ] 既存の `daemon.test.ts` の「Conductor タスクプロンプトの生成」テストが通る

## スコープ外

タスク本文の「スコープ外」をそのまま転記:

- 既に走っている C[54] の救済（このタスクでは扱わない。手動で kill + restart）
- `.team/prompts/*.md` の自動再生成ロジック（別タスク）
- installed template の更新検知・警告（別タスク）

## 作業の順序（実装者向けサマリ）

1. `skills/cmux-team/manager/template.ts` を Read で確認
2. `findTemplateDir` を async 化 + 順序反転 + ログ追加
3. 内部の 3 箇所の呼び出しに `await` を追加
4. `rg findTemplateDir skills/cmux-team/` で外部呼び出しが無いことを再確認
5. `bun test skills/cmux-team/manager/daemon.test.ts` を実行
6. `bun run tsc --noEmit` で template.ts のエラーが 0 件であることを確認
7. スモークテスト（`bun -e 'import("./template")...'`）で project_local / installed 両経路を確認
8. コミット（粒度は別途 inspector / dockeeper の判断に従う）
