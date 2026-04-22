# タスク割り当て

## タスク内容

---
id: 295
title: close-task の納品物明示を強制化
priority: medium
depends_on: [294]
created_at: 2026-04-22T03:31:43.073Z
---

## タスク
## 問題

`close-task --journal "<自由テキスト1行>"` しかなく、納品方式（dev へマージ / ローカル feature マージ / PR / 成果ゼロ）が機械可読に記録されない。結果として「このタスクの成果物はどこにある？」を `task-state.json` から辿れず、`show-task` や dashboard でも追えない。人間が journal 文字列を目視で読んで推測する必要がある。

## 修正内容

### 1. CLI 仕様の拡張（`close-task`）

`--deliverable-kind <files|merged|pr|none>` を **必須**フラグとして追加。省略時 exit 1。

kind ごとの付随フラグも必須化:

| kind | 必須付随フラグ | 用途 |
|------|---------------|------|
| `files` | `--deliverable <path>` を1個以上（複数指定可） | 調査/設計ドキュメントを main にマージ済み |
| `merged` | `--merged-into <branch>` + `--merge-sha <sha>` | ローカルで feature → main マージ完了 |
| `pr` | `--pr-url <url>` | GitHub PR 提出（マージは人間判断） |
| `none` | 追加フラグなし | 成果ゼロでの close（理由は `--journal` に記述） |

`--journal` は全 kind で引き続き受理する（人間向けサマリー）。

### 2. スキーマ拡張

`task-state.json` の closed 行に構造化フィールドを保存:

\`\`\`ts
// schema.ts
type Deliverable =
  | { kind: "files"; files: string[] }
  | { kind: "merged"; branch: string; sha: string }
  | { kind: "pr"; prUrl: string }
  | { kind: "none" };

type TaskStateEntry = {
  status: "closed";
  closedAt: string;
  journal?: string;
  deliverable: Deliverable;  // closed 時は必須
  // ...
};
\`\`\`

既存の closed 行（deliverable なし）はマイグレーションせず NULL のまま読める設計にする。

### 3. Conductor テンプレ更新

Step 11 で kind を明示して呼ぶように書き換え。Step 9 の3分岐（ローカルマージ / PR / 調査系の files 納品）と kind を対応づける:

- ローカルマージ成功 → \`--deliverable-kind merged --merged-into <branch> --merge-sha <sha>\`
- PR 提出 → \`--deliverable-kind pr --pr-url <url>\`
- 調査/設計系（成果物を main に直接コミット） → \`--deliverable-kind files --deliverable <path> ...\`
- 成果ゼロ（調査したが変更不要と判断等） → \`--deliverable-kind none\`

対象テンプレ:
- \`skills/cmux-team/templates/{ja,en}/conductor-role.md\`（Step 11 L699〜703 付近、Step 9 L592〜652 付近）
- \`skills/cmux-team/templates/{ja,en}/conductor.md\`（Step 7 L270〜273 付近）
- \`skills/cmux-team/templates/{ja,en}/conductor-task.md\`（Step 11 記述 L40 付近）

### 4. 表示系

- \`dashboard.tsx\`: closed タスクに deliverable 情報を表示（kind + 要点）
- \`cmdShowTask\`（main.ts）: deliverable を整形表示
- \`trace-task\`: 必要に応じて deliverable 情報を付加

### 5. i18n / help

- \`i18n.ts\` の \`help_close_task\` を更新（新フラグ仕様を記載）

### 6. 前提

- T294（auto-update task モード廃止）完了後に着手。これで update タスクの kind=none 対応を考慮する必要がなくなる

## 対象ファイル

- \`skills/cmux-team/manager/main.ts\`（cmdCloseTask L3017〜3100、help 文言）
- \`skills/cmux-team/manager/schema.ts\`（Deliverable 型、TaskStateEntry 拡張）
- \`skills/cmux-team/manager/i18n.ts\`
- \`skills/cmux-team/manager/dashboard.tsx\`
- \`skills/cmux-team/templates/ja/conductor-role.md\`
- \`skills/cmux-team/templates/ja/conductor.md\`
- \`skills/cmux-team/templates/ja/conductor-task.md\`
- \`skills/cmux-team/templates/en/conductor-role.md\`
- \`skills/cmux-team/templates/en/conductor.md\`
- \`skills/cmux-team/templates/en/conductor-task.md\`
- テスト: \`skills/cmux-team/manager/main.test.ts\`, \`task.test.ts\`
- docs: \`docs/spec/\` 該当ファイル、CLAUDE.md の「通信プロトコル」節

## 破壊的変更

- 既存の \`close-task --journal "..."\` だけの呼び出しはすべて exit 1 になる
- 人間が手動で復旧のために close する際も kind 指定が必須

## 納品形態

本タスク自体の納品は「ローカル feature ブランチを main に ff-only マージ」を想定。ただし Conductor テンプレを自己書き換えするため、Step 9 のフロー検証を丁寧に行うこと。

## 依存関係

- \`depends_on: [T294]\`


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-295-1776828703` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-295-1776828703
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-295-1776828703/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/295-close-task/runs/task-295-1776828703
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/295-close-task/runs/task-295-1776828703/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
