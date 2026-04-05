# 実装計画: タスクに base_branch フィールドを追加し TUI に表示する

## 1. 概要

タスクにマージ先ブランチ（`base_branch`）を明示的に指定できるようにし、TUI ダッシュボードに表示する。Conductor テンプレートでもマージ先を参照できるようにする。

---

## 2. 変更ファイルと変更内容

### 2-1. `skills/cmux-team/manager/task.ts`

**TaskMeta インターフェースに `baseBranch` 追加**

```typescript
export interface TaskMeta {
  // ...既存フィールド
  baseBranch?: string;  // マージ先ブランチ（未指定時は暗黙的に main）
}
```

**`parseTaskMeta()` に `base_branch` パース追加**

L44 付近（`createdAt` パースの後）に追加:
```typescript
const baseBranch = unquote(fm.match(/^base_branch:\s*(.+)$/m)?.[1]?.trim() ?? "");
```

返却オブジェクト（L66-76）に追加:
```typescript
baseBranch: baseBranch || undefined,
```

### 2-2. `skills/cmux-team/manager/daemon.ts`

**TaskSummary インターフェースに `baseBranch` 追加（L21-29）**

```typescript
export interface TaskSummary {
  // ...既存フィールド
  baseBranch?: string;
}
```

**`taskList` 構築部分（L562-570）で `baseBranch` を伝播**

```typescript
state.taskList = combined.map((t) => ({
  // ...既存フィールド
  baseBranch: t.baseBranch,
}));
```

### 2-3. `skills/cmux-team/manager/dashboard.tsx`

**Nerd Font ヘルパー関数の追加（ファイル上部の定数定義エリア）**

```typescript
function nerdIcon(nerd: string, fallback: string): string {
  return process.env.CMUX_NERD_FONT === "0" ? fallback : nerd;
}
```

**`buildTaskRow()` に base_branch 表示を追加（L410-437）**

ステータスラベル `[${label}]` の後、タイトルの前にブランチ名を表示:

```typescript
const branchEl = task.baseBranch
  ? ui.text(`${nerdIcon("\ue0a0", "⎇")} ${task.baseBranch}`, { dim: true })
  : null;

return ui.row({ gap: 1 }, [
  ui.text(icon, colorStyle),
  ui.text(taskId, { bold: !isClosed, ...colorStyle }),
  ui.text(`[${label}]`, colorStyle),
  branchEl,                              // ← 追加
  buildTitleWithLinks(task.title, repoUrl, colorStyle),
  timeInfo ? ui.text(timeInfo, colorStyle) : null,
]);
```

表示例: `● T042 [running]  main  認証機能追加  3:20`

### 2-4. `skills/cmux-team/manager/main.ts`

**`cmdCreateTask()` に `--base-branch` オプション追加（L1023-1118）**

ヘルプテキスト（L1024-1044）に追加:
```
  --base-branch <branch>  マージ先ブランチ（任意、デフォルト: 指定なし → main にマージ）
```

引数取得（L1045-1049 付近）:
```typescript
const baseBranch = getArg("base-branch") || "";
```

frontmatter 生成（L1089-1098）に `base_branch` 行を追加:
```typescript
const content = `---
id: ${newId}
title: ${title}
priority: ${priority}${baseBranch ? `\nbase_branch: ${baseBranch}` : ""}${runAfterAll ? "\nrun_after_all: true" : ""}
created_at: ${new Date().toISOString()}
---

## タスク
${body}
`;
```

### 2-5. `skills/cmux-team/manager/template.ts`

**`generateConductorTaskPrompt()` に `baseBranch` パラメータ追加**

シグネチャ（L64-71）:
```typescript
export async function generateConductorTaskPrompt(
  projectRoot: string,
  taskRunId: string,
  taskId: string,
  taskContent: string,
  worktreePath: string,
  outputDir: string,
  baseBranch?: string       // ← 追加
): Promise<string> {
```

変数置換（L86-91）に追加:
```typescript
.replace(/\{\{BASE_BRANCH\}\}/g, baseBranch || "main（デフォルト）")
```

### 2-6. `skills/cmux-team/manager/conductor.ts`

**`assignTask()` で `baseBranch` を取得しテンプレートに渡す**

タスクファイルの frontmatter から `base_branch` を読み取り（L226-227 付近）:
```typescript
const baseBranch = taskContent.match(/^base_branch:\s*(.+)$/m)?.[1]?.trim();
```

`generateConductorTaskPrompt()` 呼び出し（L248-255）に `baseBranch` を追加:
```typescript
const promptFile = await generateConductorTaskPrompt(
  projectRoot, taskRunId, taskId, taskContent,
  worktreePath, outputDir, baseBranch
);
```

**重要:** worktree 作成時の `git worktree add` は引き続き HEAD（main）からブランチを切る。`base_branch` はマージ先の指定であり、worktree の起点ではない。

### 2-7. `skills/cmux-team/templates/conductor-task.md`

**マージ先ブランチセクションを追加**

「## 完了通知」の前に以下を追加:

```markdown
## マージ先ブランチ

このタスクの成果は `{{BASE_BRANCH}}` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。
```

### 2-8. `README.md` / `README.ja.md`

**Prerequisites セクションに Nerd Font 推奨記述を追加**

README.md（L20-25 付近、Prerequisites リストの末尾）:
```markdown
- [Nerd Font](https://www.nerdfonts.com/) (recommended) — enhances TUI dashboard icons
  ```bash
  brew install --cask font-hack-nerd-font
  ```
  Works without Nerd Font (falls back to Unicode symbols). Set `CMUX_NERD_FONT=0` to use fallback icons explicitly.
```

README.ja.md（L20-25 付近、前提条件リストの末尾）:
```markdown
- [Nerd Font](https://www.nerdfonts.com/)（推奨）— TUI ダッシュボードのアイコン表示が向上します
  ```bash
  brew install --cask font-hack-nerd-font
  ```
  Nerd Font がなくても動作します（Unicode シンボルにフォールバック）。`CMUX_NERD_FONT=0` を設定するとフォールバックアイコンを明示的に使用できます。
```

---

## 3. 変更の依存関係（実装順序）

```
1. task.ts     — TaskMeta に baseBranch 追加 + parseTaskMeta 拡張
      ↓
2. daemon.ts   — TaskSummary に baseBranch 追加 + taskList 構築で伝播
      ↓
3. dashboard.tsx — nerdIcon ヘルパー追加 + buildTaskRow で baseBranch 表示
      ↓ （並行可能）
4. main.ts     — create-task CLI に --base-branch オプション追加
      ↓ （並行可能）
5. template.ts — generateConductorTaskPrompt に baseBranch パラメータ追加
      ↓
6. conductor.ts — assignTask で baseBranch を取得して template に渡す
      ↓ （並行可能）
7. conductor-task.md — {{BASE_BRANCH}} 変数追加
      ↓
8. README.md / README.ja.md — Nerd Font 推奨記述追加
```

実質的な依存チェーン: 1 → 2 → 3（データフロー）、5 → 6 → 7（テンプレートフロー）。4, 8 は独立。

---

## 4. Nerd Font フォールバック戦略

### 設計判断: 環境変数 `CMUX_NERD_FONT` による制御

Nerd Font グリフ（`` U+E0A0）がターミナルで描画可能かを自動判定する確実な方法は存在しない。環境変数ベースで切り替える:

| 環境変数 | 動作 |
|---------|------|
| 未設定 / `CMUX_NERD_FONT=1` | Nerd Font アイコン（`` U+E0A0）を使用 **← デフォルト** |
| `CMUX_NERD_FONT=0` | Unicode フォールバック（`⎇` U+2387）を使用 |

**デフォルトを Nerd Font にする理由:**
- cmux-team のターゲットユーザーは開発者であり、Nerd Font インストール率が高い
- Nerd Font が未インストールでも豆腐（□）が表示されるだけで機能に影響なし
- `CMUX_NERD_FONT=0` で明示的にフォールバックを選択可能

**実装:** `dashboard.tsx` にヘルパー関数 `nerdIcon(nerd, fallback)` を定義。ブランチアイコン以外にも将来 Nerd Font アイコンを使う場合に再利用可能。

---

## 5. テスト方針

自動テストなしのため、以下を手動確認する。

### 確認項目

1. **タスク作成（CLI）**
   - `cmux-team create-task --title "テスト" --base-branch develop --status draft` → タスクファイルの frontmatter に `base_branch: develop` が含まれること
   - `--base-branch` 省略時 → タスクファイルに `base_branch` 行がないこと
   - `cmux-team create-task --help` → `--base-branch` の説明が表示されること

2. **パース（task.ts）**
   - `base_branch` ありのタスクファイルが正常にパースされ、`TaskMeta.baseBranch` に値が入ること
   - `base_branch` なしの既存タスクファイルが正常にパースされ、`baseBranch` が `undefined` であること

3. **TUI ダッシュボード表示**
   - `base_branch` 指定ありのタスクにブランチアイコン + ブランチ名が表示されること
   - `base_branch` 未指定のタスクにブランチ表示がないこと
   - `CMUX_NERD_FONT=0` 設定時に `⎇ develop` と表示されること（ → Nerd Font アイコンの代わり）

4. **Conductor テンプレート**
   - `base_branch` 指定ありのタスクで、生成プロンプトに正しいブランチ名が含まれること
   - 未指定時に「main（デフォルト）」と表示されること

5. **既存互換性**
   - `base_branch` を持たない既存タスクファイルが全て正常にパース・表示されること

---

## 6. README 追記内容の概要

| ファイル | セクション | 追加内容 |
|---------|-----------|---------|
| README.md | Prerequisites | Nerd Font を推奨項目として追加、`brew install` コマンド、フォールバック説明 |
| README.ja.md | 前提条件 | 同内容を日本語で記載 |

フォント名は `font-hack-nerd-font` を例示（一般的で入手しやすいため）。

---

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | Nerd Font 判定を自動にするか環境変数にするか | 環境変数 `CMUX_NERD_FONT` | 自動判定は不確実。環境変数なら確実に制御可能 |
| D2 | デフォルトを Nerd Font にするか Unicode にするか | Nerd Font をデフォルト | ターゲットユーザーが開発者。豆腐表示でも機能に影響なし |
| D3 | `base_branch` を worktree 作成時の起点にも使うか | マージ先の指定のみに使う | worktree は常に HEAD（main）から作成。base_branch は納品先（マージ先）の概念 |
| D4 | conductor-task.md にマージ手順全体を記載するか | ブランチ名の指定のみ記載し、手順は conductor-role.md に委譲 | DRY 原則。マージ手順の詳細は conductor-role.md が権威 |
