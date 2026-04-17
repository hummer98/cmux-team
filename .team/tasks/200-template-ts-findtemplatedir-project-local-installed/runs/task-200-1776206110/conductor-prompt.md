# タスク割り当て

## タスク内容

---
id: 200
title: template.ts: findTemplateDir の探索順序を project-local → installed に反転
priority: high
created_at: 2026-04-14T22:29:00.595Z
---

## タスク
# 背景

T197 実行中の C[54] が **古い conductor-role.md**（await-agent 導入前の read-screen + 30 秒ポーリング版）で動いている問題が観測された。

## 観測された時系列

| 時刻 | イベント | 状態 |
|---|---|---|
| 2026-04-14 14:46 | T181 merge（`f1c69c6` await-agent 方式移行） | repo HEAD は await-agent 版 |
| 2026-04-15 05:47:30 | C[54] `conductor_registered` | daemon が `generateConductorRolePrompt()` 実行 |
| 2026-04-15 05:47 | `.team/prompts/conductor-role.md` 生成（**旧内容**） | 当時の installed template を読んだ結果 |
| 2026-04-15 05:55 | globally installed template 更新（mtime 4/15 05:55、await-agent あり） | 8 分遅れで新版が npm install |
| 2026-04-15 06:50 | C[54] に T197 割り当て | Claude セッションは旧 prompt を保持したまま |
| 2026-04-15 06:57+ | A[79] spawn 後 read-screen + IDLE_COUNT ポーリング開始 | 廃止済み方式で監視（不安定） |

## 根本原因

`skills/cmux-team/manager/template.ts` の `findTemplateDir()` が以下の順序で探索している:

```typescript
export function findTemplateDir(): string | null {
  // 1. daemon 自身からの相対パス（manager/ の兄弟 templates/）  ← FIRST
  const fromSelf = join(dirname(import.meta.path), "../templates");
  const resolved1 = resolveLocalizedDir(fromSelf);
  if (resolved1) return resolved1;

  // 2. プロジェクトローカル  ← SECOND（path #1 が成功すると到達しない）
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const local = join(projectRoot, "skills/cmux-team/templates");
  const resolved2 = resolveLocalizedDir(local);
  if (resolved2) return resolved2;

  return null;
}
```

### 問題の構造

- cmux-team は `npm install -g @hummer98/cmux-team` でグローバルインストールされている
- `import.meta.path` は `~/.anyenv/.../lib/node_modules/@hummer98/cmux-team/skills/cmux-team/manager/template.ts` を指す
- その `../templates/` は **published npm 版のテンプレート**
- dev リポジトリ（`/Users/yamamoto/git/cmux-team`）で `cmux-team start` しても、daemon は **installed 版の古いテンプレート**を読む
- リリース直後の race（installed 版がまだ更新されていない瞬間に daemon 起動）で旧 prompt が runtime に焼き付けられる
- Conductor の Claude セッションは起動時のシステムプロンプトをコンテキストとして保持し続けるため、kill しない限り永遠に旧 prompt で動作する

## 方針

### 探索順序を反転する

```typescript
export function findTemplateDir(): string | null {
  // 1. プロジェクトローカル（dev リポジトリを最優先）  ← NEW FIRST
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const local = join(projectRoot, "skills/cmux-team/templates");
  const resolved1 = resolveLocalizedDir(local);
  if (resolved1) return resolved1;

  // 2. daemon 自身からの相対パス（installed package のフォールバック）  ← NEW SECOND
  const fromSelf = join(dirname(import.meta.path), "../templates");
  const resolved2 = resolveLocalizedDir(fromSelf);
  if (resolved2) return resolved2;

  return null;
}
```

### 期待する挙動

- **dev リポジトリ（git clone）で作業中**: `skills/cmux-team/templates/` が存在するので project-local を使う → 常に repo HEAD のテンプレート
- **通常のユーザー環境**: `skills/cmux-team/templates/` は存在しないので installed フォールバックを使う → published 版のテンプレート
- **race 条件の解消**: repo と installed のどちらが古くても、dev 環境では必ず repo 側（HEAD）が優先される

## 修正対象

### `skills/cmux-team/manager/template.ts:20-34`

`findTemplateDir()` の中で探索順序を入れ替える。既存の `resolveLocalizedDir()` ヘルパーは変更しない。

## ログ追加（任意）

どちらのパスを解決したかログに残すと将来の診断が楽:

```typescript
await log("template_dir_resolved", `path=${resolved1} source=project_local`);
// または
await log("template_dir_resolved", `path=${resolved2} source=installed`);
```

`findTemplateDir()` は現状 sync 関数なので、呼び出し側（`generateConductorRolePrompt` など）でログするか、該当関数を async 化して内部でログする。後者の方がクリーン。

## 完了条件

- `findTemplateDir()` が project-local → installed の順で探索する
- dev リポジトリで `cmux-team start` した際に runtime prompt が repo HEAD のテンプレートから生成される
- 通常のユーザー環境（`skills/cmux-team/templates/` が存在しない場所）でも従来通り installed テンプレートから生成される
- daemon 起動ログに `template_dir_resolved` が出る（任意だが推奨）
- T197 の touched-files 型エラーゼロ化ルール自己適用（新規エラーなし）

## スコープ外

- 既に走っている C[54] の救済（このタスクでは扱わない。手動で kill + restart）
- `.team/prompts/*.md` の自動再生成ロジック（別タスク）
- installed template の更新検知・警告（別タスク）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-200-1776206110
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-200-1776206110/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/200-template-ts-findtemplatedir-project-local-installed/runs/task-200-1776206110
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/200-template-ts-findtemplatedir-project-local-installed/runs/task-200-1776206110/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
