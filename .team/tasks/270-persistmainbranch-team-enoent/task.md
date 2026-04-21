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
