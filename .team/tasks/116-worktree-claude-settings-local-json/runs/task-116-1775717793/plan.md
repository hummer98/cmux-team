# Task 116 実装計画: worktree 作成時に `.claude/settings.local.json` をコピー

## 1. 背景と目的

`spawn-agent` が worktree の CWD で Claude Code を起動する際、`.claude/settings.local.json`（untracked）が無いと「初回セットアップ画面」で停止してしまう。`git worktree add` は tracked files のみチェックアウトするため、この untracked ファイルが欠落することが原因。

**対策**: `assignTask` の worktree 作成直後に、プロジェクトルートの `.claude/settings.local.json` を worktree 側にコピーする。

## 2. 現状把握

### 対象ファイル: `skills/cmux-team/manager/conductor.ts`

- `assignTask` 関数は `L201-L319` に定義されている
- worktree 作成は `L246-L248`
  ```ts
  await execFile("git", ["worktree", "add", worktreePath, "-b", branch], {
    cwd: projectRoot,
  });
  ```
- 続く `L251-L255` で `package.json` 検出時に `npm install` を走らせている（既存のブートストラップパターン）
- 挿入位置は **`L248`（worktree add 完了）と `L251`（npm install ブロック）の間**

### 既存の import 文（L4-L8）

```ts
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { readFile, mkdir, readdir, rm, stat } from "fs/promises";
import { join, relative } from "path";
```

### 既存のエラーハンドリングパターン

`assignTask` 全体が大きな try/catch（`L206-L318`）で包まれていて、例外発生時は `log("error", ...)` → `return null`（タスク割当失敗）となる。

一方、`npm install` は「失敗しても worktree 作成自体は成功扱いにしたい」ため、**inline の `.catch()` で個別にログしてフォールスルー**するパターンになっている（`L252-L254`）:

```ts
await execFile("npm", ["install"], { cwd: worktreePath }).catch(async (e: any) => {
  await log("error", `npm install failed in worktree: path=${worktreePath} ${e.message}`);
});
```

本タスクの「コピー失敗は fatal にしない」要件はこの npm install パターンと完全に一致するため、**同じ `.catch()` スタイル**を採用する。

### 前提確認

- プロジェクトルートに `.claude/settings.local.json` が実在（確認済み: 1658 bytes）
- worktree 作成直後は `.claude/` ディレクトリ自体が存在しない可能性が高いので、`mkdir({recursive: true})` でディレクトリを先に用意する必要がある

## 3. 変更内容

### 3.1 import 文の修正

| ファイル | 行 | 変更 |
|---|---|---|
| `skills/cmux-team/manager/conductor.ts` | L7 | `readFile, mkdir, readdir, rm, stat` → `readFile, mkdir, readdir, rm, stat, copyFile` |
| `skills/cmux-team/manager/conductor.ts` | L8 | `join, relative` → `join, relative, dirname` |

最終形:
```ts
import { readFile, mkdir, readdir, rm, stat, copyFile } from "fs/promises";
import { join, relative, dirname } from "path";
```

### 3.2 追加するコード

`conductor.ts` L249（`git worktree add` の execFile 直後、現状の空行）に以下を挿入する:

```ts
    // .claude/settings.local.json を worktree にコピー
    // （untracked なので worktree に含まれないが、Agent 起動時に必要）
    const settingsSrc = join(projectRoot, ".claude/settings.local.json");
    if (existsSync(settingsSrc)) {
      const settingsDst = join(worktreePath, ".claude/settings.local.json");
      await mkdir(dirname(settingsDst), { recursive: true })
        .then(() => copyFile(settingsSrc, settingsDst))
        .then(() => log("settings_copied_to_worktree", `worktree=${worktreePath}`))
        .catch(async (e: any) => {
          await log("error", `settings copy failed: worktree=${worktreePath} ${e.message}`);
        });
    }
```

### 挿入位置の目安

```
L246  await execFile("git", ["worktree", "add", worktreePath, "-b", branch], {
L247    cwd: projectRoot,
L248  });
L249  ← ここに新規ブロックを挿入（空行を挟んで）
      // worktree ブートストラップ
L251  if (existsSync(join(worktreePath, "package.json"))) {
```

挿入後は下のブロックが L10 ほど後ろにずれる。

## 4. エラーハンドリング戦略

| ケース | 挙動 |
|---|---|
| `settings.local.json` が存在しない | `existsSync` で早期 return（ログなし）。プロジェクトにそもそも設定ファイルが無いケースは正常系扱い |
| `.claude/` 作成失敗 | `.catch()` で `log("error", ...)`、worktree 割当は続行 |
| `copyFile` 失敗 | `.catch()` で `log("error", ...)`、worktree 割当は続行 |
| 成功 | `log("settings_copied_to_worktree", "worktree=<path>")` |

ポイント:
- **fatal にしない**。タスク割当ては続行し、Agent 起動後に Trust 承認スキルやユーザー介入で回避できる余地を残す
- `ENOENT` 等は既に `existsSync` ガードで防いでいるので、`.catch()` に入るのは権限エラーや I/O 系の想定外例外のみ
- ログイベント名は CLAUDE.md のポリシーに沿って `settings_copied_to_worktree`（状態変化）/ `error`（失敗）とする

## 5. テスト方針

### 5.1 単体テストの追加は **見送る**

理由:
- `conductor.test.ts` は現状存在せず、このタスクのために新設するコストが高い
- `assignTask` 全体は `git worktree add` / `cmux send` / `generateConductorTaskPrompt` など外部依存が多く、モック設計が重い
- `daemon.test.ts` は queue / task state の logical path に絞ったテストで、worktree 作成は触っていない（`L266` 付近は prompt 生成に worktree path を渡すだけのテスト）
- 本変更は「ファイルを 1 つコピーするだけ」のごく限定的な動作で、既存コードパターン（npm install のコピー）と 1:1 対応している

### 5.2 代わりに行うこと

- **動作確認（E2E）** を `検証手順` セクションで実施する
- 将来 `conductor.test.ts` を新設する場合に備え、テストしやすい位置（`assignTask` 本体ではなく独立した `copyLocalSettings(projectRoot, worktreePath)` 関数）へリファクタする選択肢はあるが、**今回は現状パターン（assignTask 内 inline）を踏襲**してスコープを最小化する

## 6. 検証手順

### 6.1 ビルド確認

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-116-1775717793/skills/cmux-team/manager
bun install
bun run tsc --noEmit  # or existing lint/typecheck
```

- `copyFile` / `dirname` の import が解決されること
- 型エラーが出ないこと

### 6.2 既存テストの回帰確認

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-116-1775717793/skills/cmux-team/manager
bun test
```

- `daemon.test.ts`, `proxy.test.ts`, `queue.test.ts`, `task.test.ts` が全て pass すること

### 6.3 手動動作確認

1. 本変更を含んだ `cmux-team` で新しいタスクを `cmux-team create-task` で作成し ready にする
2. daemon が Conductor に割当てる
3. 作成された worktree を確認:
   ```bash
   ls -la .worktrees/task-XXX-*/.claude/
   # settings.local.json があること
   diff .claude/settings.local.json .worktrees/task-XXX-*/.claude/settings.local.json
   # 差分ゼロ
   ```
4. `.team/logs/manager.log` に以下が記録されていること:
   ```
   settings_copied_to_worktree worktree=<path>
   ```
5. その後 `spawn-agent` で Agent を起動 → 初回セットアップ画面が出ずに通常通り起動すること（本タスクの元々の報告事象の解消確認）

### 6.4 異常系確認

- `.claude/settings.local.json` が存在しないプロジェクトで `assignTask` を実行 → コピーはスキップされ、ログは出ず、worktree 作成は従来どおり成功すること
- `.claude/settings.local.json` に読み取り権限がない状態で実行 → `error` ログが出るが `assignTask` は成功 `ConductorState` を返すこと（手動で `chmod 000` して確認可能）

## 7. 実装時の注意点

- **プロンプトソースオブトゥルース原則**: 本タスクはテンプレート (`templates/*.md`) を触らない。conductor.ts の実装のみ
- **npm install パターンへの寄せ**: `.catch()` スタイルは既存の npm install と同様にして、読み手の認知負荷を下げる
- **新規ファイル作成は不要**: 変更は `conductor.ts` 1 ファイル・import 2 行修正・ロジック 1 ブロック追加のみ

## 8. 影響範囲

| 項目 | 影響 |
|---|---|
| 外部 API | なし |
| ファイルシステム | worktree 内に `.claude/settings.local.json` が 1 つ増える（元ファイルのコピー） |
| パフォーマンス | 1 ファイル（~数 KB）の copyFile のみ。無視できる |
| セキュリティ | `.claude/settings.local.json` は元々ローカルファイル。worktree も同一ユーザー配下なので権限昇格等なし |
| 他プロジェクトへの波及 | cmux-team を使う全プロジェクトで自動的に機能する。オプトアウト手段は不要（存在チェックあり） |

## 9. 完了条件

- [ ] `conductor.ts` の import 2 行が修正されている
- [ ] `assignTask` 関数の worktree add 直後・npm install 前にコピーブロックが追加されている
- [ ] 既存テストが全て pass する
- [ ] 手動動作確認で worktree 内に `.claude/settings.local.json` がコピーされることを確認
- [ ] manager.log に `settings_copied_to_worktree` イベントが記録される
