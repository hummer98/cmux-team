# タスク割り当て

## タスク内容

---
id: 270
title: persistMainBranch で .team/ 未作成時に ENOENT で落ちるのを修正
priority: high
created_by: surface:199
created_at: 2026-04-19T06:57:22.855Z
---

## タスク
## 現象

新規プロジェクトで初回 \`cmux-team start\` を実行すると、\`.team/\` がまだ無い段階で
\`persistMainBranch\` が \`.team/config.json\` を writeFile しようとして ENOENT で落ちる。

**再現例（~/git/AIview で発生）:**

\`\`\`
yamamoto@mbp: ~/git/AIview (master *%>)
\$ cmux-team start --layout 16x9
...
ENOENT: no such file or directory, open '/Users/yamamoto/git/AIview/.team/config.json'
    path: "/Users/yamamoto/git/AIview/.team/config.json",
 syscall: "open",
   errno: -2,
    code: "ENOENT"

      at async persistMainBranch (skills/cmux-team/manager/main-branch.ts:96:9)
      at async cmdStart (skills/cmux-team/manager/main.ts:316:11)
\`\`\`

## 根本原因

\`cmdStart\` の実行順序が以下になっている:

1. \`resolveMainBranch\` で git 検出（OK）
2. \`persistMainBranch\` で \`.team/config.json\` 書き込み ← **ここで失敗**
3. \`createDaemon\` / \`initInfra\` で \`.team/\` を作成（到達せず）

T253 で main ブランチ未解決を fail-stop 化した際、\`source !== "config"\` で
常に \`persistMainBranch\` を呼ぶようになったが、初回起動時は \`.team/\` が
まだ存在しないケースが考慮されていない。

## 修正方針

\`skills/cmux-team/manager/main-branch.ts\` の \`persistMainBranch\` 先頭で
\`.team/\` を \`mkdir(..., { recursive: true })\` してから \`writeFile\` する。

\`\`\`typescript
export async function persistMainBranch(
  projectRoot: string,
  branch: string,
): Promise<void> {
  const teamDir = join(projectRoot, ".team");
  await mkdir(teamDir, { recursive: true });
  const configPath = join(teamDir, "config.json");
  // ... 既存の read-merge-write ロジック
}
\`\`\`

\`existsSync\` 分岐の前に mkdir を入れるだけで副作用は最小。既存ディレクトリが
あれば no-op になる。

## 対象ファイル

- \`skills/cmux-team/manager/main-branch.ts\` — \`persistMainBranch\` 先頭に mkdir 追加
- \`fs/promises\` から \`mkdir\` を import に追加

## 確認ポイント

- 新規プロジェクトで \`.team/\` が無い状態で \`cmux-team start\` を実行 → 正常起動する
- 既存プロジェクトで \`.team/config.json\` が既にある状態で起動 → 既存挙動維持（mainBranch 上書き）
- \`.team/\` だけあって \`config.json\` が無い状態で起動 → 新規 config.json 作成

## 関連

- T213（\`mainBranch\` 設定追加）
- T253（main ブランチ未解決を fail-stop 化）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-270-1776583549` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-270-1776583549
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-270-1776583549/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/270-persistmainbranch-team-enoent/runs/task-270-1776583549
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/270-persistmainbranch-team-enoent/runs/task-270-1776583549/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」Step 12 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
