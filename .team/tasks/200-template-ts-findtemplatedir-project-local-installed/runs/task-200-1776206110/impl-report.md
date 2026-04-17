# Implementation Report: T200 findTemplateDir 反転

## 変更ファイル

- `skills/cmux-team/manager/template.ts`:
  - `findTemplateDir()` を `async function findTemplateDir(): Promise<string | null>` に変更
  - 探索順序を **project-local → installed** に反転
  - 各 return 直前で `await log("template_dir_resolved", "path=... source=project_local|installed")` を出力
  - `generateMasterPrompt` / `generateConductorRolePrompt` / `generateConductorTaskPrompt` の 3 箇所の `findTemplateDir()` 呼び出しに `await` を追加
  - `resolveLocalizedDir()` ヘルパーは未変更
  - テンプレートファイル（`skills/cmux-team/templates/*.md`）も未変更

## 実行した検証

### 型チェック

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110/skills/cmux-team/manager
bun run tsc --noEmit
# exit=0（エラー 0 件）
```

`template.ts` に関する型エラーは 0 件。touched-files ゼロ化ルール（T197）を満たす。

### 既存テスト

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110
bun test skills/cmux-team/manager/daemon.test.ts
# 51 pass / 0 fail / 107 expect() calls / 3.10s
```

「Conductor タスクプロンプトの生成」を含む全 51 テストが green。

### スモークテスト（project_local）

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110
PROJECT_ROOT=$(pwd) bun -e 'import("./skills/cmux-team/manager/template").then(async m => { const r = await m.findTemplateDir(); console.log("resolved:", r); })'
```

結果:

```
resolved: /Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110/skills/cmux-team/templates/ja
```

ログ（`.team/logs/manager.log`）:

```
[2026-04-15T07:43:41+09:00] template_dir_resolved path=/Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110/skills/cmux-team/templates/ja source=project_local
```

worktree 内の `skills/cmux-team/templates/ja` が `source=project_local` として解決されたことを確認。

### スモークテスト（installed フォールバック）

```bash
mkdir -p /tmp/notemplates-t200
cd /tmp/notemplates-t200
PROJECT_ROOT=/tmp/notemplates-t200 bun -e 'import("/Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110/skills/cmux-team/manager/template").then(async m => { const r = await m.findTemplateDir(); console.log("resolved:", r); })'
```

結果:

```
resolved: /Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110/skills/cmux-team/templates/ja
```

ログ（`/tmp/notemplates-t200/.team/logs/manager.log`）:

```
[2026-04-15T07:43:48+09:00] template_dir_resolved path=/Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110/skills/cmux-team/templates/ja source=installed
```

`PROJECT_ROOT=/tmp/notemplates-t200` では project_local 経路にテンプレートが存在しないため `fromSelf` 経路（`import.meta.path` 起点）にフォールスルーし、`source=installed` としてログ出力された。plan.md に記載の通り、このスモークテストでは worktree 内 templates を指すが、ログの `source=installed` で installed 経路が発動したことが確認できる。

## 発見事項・懸念

- 特になし。plan.md の想定通りに動作した。
- `findTemplateDir()` のシグネチャ変更（`string | null` → `Promise<string | null>`）の影響は template.ts 内 3 箇所のみで完結（`rg 'findTemplateDir' skills/cmux-team/` で外部呼び出しが無いことを再確認済）。
- `resolveLocalizedDir()` は未変更、テンプレートファイルも未変更。

## plan.md の完了条件チェックリスト

- [x] findTemplateDir() が project-local → installed の順で探索する
- [x] dev リポジトリで worktree 内 templates が解決される（`source=project_local`）
- [x] PROJECT_ROOT に templates が存在しない場合 installed フォールバックが動作する（`source=installed`）
- [x] template_dir_resolved ログが出力される
- [x] touched-files 型エラーゼロ化（tsc --noEmit exit=0）
- [x] daemon.test.ts が通る（51 pass / 0 fail）
