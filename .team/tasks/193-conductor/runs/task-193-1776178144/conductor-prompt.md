# タスク割り当て

## タスク内容

---
id: 193
title: Conductor 初期プロンプト削除 + タブ名を役割固定に
priority: medium
created_at: 2026-04-14T14:48:03.199Z
---

## 目的

1. Conductor の起動時に初期プロンプト（`conductor_wait_prompt` = 「あなたは Conductor スロットです...」）を UI に表示しないようにする。system prompt (`conductor-role.md`) は既に設定済みで待機ロジックは効くため、画面上の表示は不要。Master と挙動を統一する。
2. タブ名を常に **`[<surface番号>] <役割>`** 形式に戻す。状態・タスク ID・タイトル・アイコン（♦ / 絵文字）は削除し、`[xxx] Master` / `[xxx] Manager` / `[xxx] Conductor` / `[xxx] Agent` の4種のみにする。状態情報は TUI ダッシュボードのフッターで表示するため、タブ名で冗長に持つ必要がない。

## 背景

- Conductor 起動時の初期プロンプトは、UI 上で「待機中」を可視化する目的でのみ存在している。タスク割り当ては `/clear + プロンプト送信` で行っており、起動時に assistant ターンを1つ消費する必要がない（トークン節約、Master との挙動統一）。
- タブ名の動的更新は複数箇所（assignTask, resetConductor, resume, spawn-agent）に分散し、保守コスト・ログノイズ・rename 失敗時のハンドリングが散らばっている。フッター表示に集約することで全削除できる。

## 変更内容

### 1. Conductor 初期プロンプト削除

**`skills/cmux-team/manager/main.ts:1244-1248`**:
\`\`\`ts
// 初期プロンプトを決定
const initialPrompt = taskPromptFile
  ? \`\${taskPromptFile} を読んで指示に従って作業してください。\`
  : t(\"conductor_wait_prompt\");
claudeArgs.push(initialPrompt);
\`\`\`
→ \`taskPromptFile\` が指定された場合のみプロンプトを push する。未指定時（= 通常の待機起動）は何も push しない。

**\`skills/cmux-team/manager/i18n.ts\`**:
- \`conductor_wait_prompt\` エントリを検索し、未使用になったら削除（他で使っていないか \`rg \"conductor_wait_prompt\"\` で確認）。

### 2. タブ名を \`[<num>] <役割>\` 固定に

すべての \`renameTab\` 呼び出しを \`[<num>] <役割>\` に統一する。\`[\${num}]\` プレフィックスは残す（surface 識別に有用）。♦ / アイコン、タスク ID・タイトル、状態（idle / running）は削除。

| ファイル:行 | 変更前 | 変更後 |
|---|---|---|
| \`master.ts:35\` | \`\`[\${num}] Master\`\` | そのまま（変更不要） |
| \`main.ts:512\` | \`\`[\${num}] Manager\`\` | そのまま（変更不要） |
| \`conductor.ts:148\` (launchConductor 起動直後) | \`\`[\${num}] ♦ idle\`\` | \`\`[\${num}] Conductor\`\` |
| \`conductor.ts:445-454\` (assignTask 実行中の rename) | \`\`[\${num}] ♦ T\${taskId} \${shortTitle}\`\` | **ブロック全体を削除**（起動時に設定した \`[\${num}] Conductor\` のまま） |
| \`conductor.ts:559-561\` (resetConductor 戻し) | \`\`[\${num}] ♦ idle\`\` | **行を削除**（既に \`[\${num}] Conductor\` なので再設定不要） |
| \`main.ts:617\` (initializeLayout の resume rename) | \`\`[\${num}] ♦ T\${r.taskId} \${shortTitle}\`\` | **行を削除**（既に \`[\${num}] Conductor\` なので再設定不要） |
| \`main.ts:1546-1562\` (cmdSpawnAgent) | \`\`[\${num}] \${roleIcon} \${shortTitle}\`\` | \`\`[\${num}] Agent\`\`。\`roleIcons\`・\`shortTitle\`・\`roleIcon\` 変数も不要になれば削除 |

### 3. 関連クリーンアップ

- \`renameTab\` 失敗時のログ（\`conductor.ts:453\` など）は、rename 呼び出しを削除するなら連動して削除。
- \`formatSurface\` / ログ側の \`C[665]\` 表記は **維持**（logger.ts の T192 表記とタブ名は別）。

## 動作確認

1. \`cmux-team start\` で Conductor ペインに何もユーザーメッセージが表示されず、\`❯\` プロンプト待ち状態になること
2. タブ名が \`[xxx] Master\` / \`[xxx] Manager\` / \`[xxx] Conductor\` / \`[xxx] Agent\` の4種のみで、タスク実行中でも変化しないこと
3. タスクを割り当てた Conductor が正常に動作し、完了後に idle に戻ること
4. サブエージェント起動後、タブ名が \`[xxx] Agent\` になること
5. \`cmux-team status\` やダッシュボードで状態情報が引き続き取得できること（タブ名に依存していないこと）

## 補足

- \`CMUX_NO_RENAME_TAB=1\` 環境変数は既に設定済みで、Claude 側の自動 rename は抑止されているため追加作業不要。
- ランタイムプロンプト \`.team/prompts/*.md\` は派生物。テンプレートに手を入れる必要はない（今回の変更は main.ts の claudeArgs 組み立てだけ）。


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-193-1776178144` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-193-1776178144
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-193-1776178144/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/193-conductor/runs/task-193-1776178144
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/193-conductor/runs/task-193-1776178144/summary.md` に書き出す。

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
