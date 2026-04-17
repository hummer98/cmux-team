# Inspection Report: T200 findTemplateDir 反転

## 判定
**GO**

## 検証結果

### 1. 探索順序の反転
- 結果: OK
- 根拠: `skills/cmux-team/manager/template.ts:20-40`

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
    //    manager/template.ts → ../templates/
    const fromSelf = join(dirname(import.meta.path), "../templates");
    const resolved2 = resolveLocalizedDir(fromSelf);
    if (resolved2) {
      await log("template_dir_resolved", `path=${resolved2} source=installed`);
      return resolved2;
    }

    return null;
  }
  ```

  project-local（`process.env.PROJECT_ROOT || process.cwd()` + `skills/cmux-team/templates`）を最初に、installed（`dirname(import.meta.path) + ../templates`）を二番目に探索している。

### 2. async 化
- 結果: OK
- 根拠: `template.ts:20` — `export async function findTemplateDir(): Promise<string | null>`

### 3. 呼び出し側の await（3 箇所）
- 結果: OK
- 根拠:
  - `template.ts:49` (`generateMasterPrompt`): `const templateDir = await findTemplateDir();`
  - `template.ts:61` (`generateConductorRolePrompt`): `const templateDir = await findTemplateDir();`
  - `template.ts:89` (`generateConductorTaskPrompt`): `const templateDir = await findTemplateDir();`

  すべての呼び出し関数は元々 `async` のためシグネチャ変更は不要。

### 4. ログ追加
- 結果: OK
- 根拠:
  - `template.ts:26` — `await log("template_dir_resolved", \`path=${resolved1} source=project_local\`);`
  - `template.ts:35` — `await log("template_dir_resolved", \`path=${resolved2} source=installed\`);`

  それぞれの return 直前に出力されている。

### 5. resolveLocalizedDir() 非変更
- 結果: OK
- 根拠: `template.ts:11-18` — 実装は従来通り（`existsSync(join(localized, "master.md"))` チェック + `en` フォールバック）。シグネチャ・ロジックとも未変更。

### 6. 外部呼び出しの追従
- 結果: OK
- `rg 'findTemplateDir' skills/cmux-team/` 結果:

  ```
  skills/cmux-team/manager/template.ts:20:export async function findTemplateDir(): Promise<string | null> {
  skills/cmux-team/manager/template.ts:49:  const templateDir = await findTemplateDir();
  skills/cmux-team/manager/template.ts:61:  const templateDir = await findTemplateDir();
  skills/cmux-team/manager/template.ts:89:  const templateDir = await findTemplateDir();
  ```

  4 箇所（宣言 1 + await 付き呼び出し 3）のみで、すべて template.ts 内。外部呼び出しは存在しない。

### 7. 型チェック
- `bun run tsc --noEmit` の結果:

  ```
  (出力なし)
  exit=0
  ```

- template.ts 関連エラー件数: **0 件**
- 全体エラー件数: 0 件（exit=0）

T197 touched-files ゼロ化ルールを満たす。

### 8. 既存テスト
- `bun test skills/cmux-team/manager/daemon.test.ts` 結果:

  ```
  51 pass
  0 fail
  107 expect() calls
  Ran 51 tests across 1 file. [2.82s]
  ```

  すべて green。

### 9. スモークテスト（project_local）
- 実行:

  ```
  cd /Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110
  rm -f .team/logs/manager.log
  PROJECT_ROOT=$(pwd) bun -e 'import("./skills/cmux-team/manager/template").then(async m => { const r = await m.findTemplateDir(); console.log("resolved:", r); })'
  ```

- 結果: `resolved: /Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110/skills/cmux-team/templates/ja`
- ログ:

  ```
  [2026-04-15T07:47:19+09:00] template_dir_resolved path=/Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110/skills/cmux-team/templates/ja source=project_local
  ```

  期待通り `source=project_local` で解決された。

### 10. スモークテスト（installed フォールバック）
- 実行:

  ```
  rm -rf /tmp/notemplates-t200-inspection
  mkdir -p /tmp/notemplates-t200-inspection
  cd /tmp/notemplates-t200-inspection
  PROJECT_ROOT=/tmp/notemplates-t200-inspection bun -e 'import("/Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110/skills/cmux-team/manager/template").then(async m => { const r = await m.findTemplateDir(); console.log("resolved:", r); })'
  ```

- 結果: `resolved: /Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110/skills/cmux-team/templates/ja`
- ログ:

  ```
  [2026-04-15T07:47:22+09:00] template_dir_resolved path=/Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110/skills/cmux-team/templates/ja source=installed
  ```

  `PROJECT_ROOT` に templates が存在しないため project-local 経路はフォールスルーし、`fromSelf`（`import.meta.path` 起点）経路で解決された。ログも `source=installed` と正しく記録されている。

  注: スモークテスト環境では `fromSelf` が worktree 内の templates を指すため解決パス自体は project_local 経路と同じだが、`source=installed` ログで installed 経路が実際に発動したことが確認できる（plan.md の注記通り）。

## plan.md 完了条件チェック

- [x] findTemplateDir() が project-local → installed の順で探索する
- [x] dev リポジトリで worktree 内 templates が解決される（`source=project_local`）
- [x] PROJECT_ROOT に templates が存在しない場合 installed フォールバックが動作する（`source=installed`）
- [x] template_dir_resolved ログが出力される
- [x] touched-files 型エラーゼロ化（tsc --noEmit exit=0）
- [x] daemon.test.ts が通る（51 pass / 0 fail）

すべて完了。スコープ外への踏み込み（C[54] 救済、`.team/prompts/*.md` 自動再生成、installed 更新検知）なし。

## 発見事項・懸念

なし。plan.md どおりの変更が最小スコープで実装されている。シグネチャ変更（`string | null` → `Promise<string | null>`）の影響は template.ts 内で完結しており、外部呼び出し元は存在しない。

## GO → 完了
