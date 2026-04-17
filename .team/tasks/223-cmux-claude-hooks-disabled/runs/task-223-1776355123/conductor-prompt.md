# タスク割り当て

## タスク内容

---
id: 223
title: CMUX_CLAUDE_HOOKS_DISABLED 検出を環境変数ベースに修正
priority: medium
created_at: 2026-04-16T15:58:43.237Z
---

## タスク
## 背景

`envrc-prompt.ts` の「既に設定済み」判定が `.envrc` ファイル内の文字列一致でしか行われておらず、以下のケースで検知漏れが発生している:

- `.envrc.local` に書かれている
- `~/.zshenv` / `~/.zshrc` 等で export されている
- 親 `.envrc` から `source_up` で継承している
- cmux 起動コマンド等で外部から注入されている

本来は「このプロセスの環境変数として有効か」で判定すべき。

## 現状の問題コード

`skills/cmux-team/manager/envrc-prompt.ts:158-168`:

\`\`\`ts
let envrcContent = "";
try {
  envrcContent = await readFile(envrcPath, "utf-8");
} catch (e: any) {
  await log("error", \`envrc read failed: \${e.message}\`);
  return { action: "noop_no_envrc", warnings };
}
if (envrcContent.includes("CMUX_CLAUDE_HOOKS_DISABLED")) {
  await log("envrc_check_skipped", "reason=already_set");
  return { action: "noop_already_set", warnings };
}
\`\`\`

## 修正内容

1. `ensureEnvrcHookPrompt` の gating に環境変数チェックを追加する
   - 他の gating（TTY/no_envrc/user_silenced）より前、CMUX_TEAM_NO_PROMPT の直後あたりが妥当
   - `process.env.CMUX_CLAUDE_HOOKS_DISABLED` が truthy なら早期 return
   - log: \`envrc_check_skipped reason=already_in_env\`
   - 返り値: \`{ action: "noop_already_set", warnings: [] }\`
2. 既存の \`envrcContent.includes("CMUX_CLAUDE_HOOKS_DISABLED")\` チェックは削除
   - env チェックで上流カバーされる（\`.envrc\` に書かれていれば daemon 起動時点で direnv 経由で env に入っているはず）
   - ただし direnv allow されていないケースで誤判定になる可能性があれば両方残す選択肢もある — 実装者判断
3. テスト更新 (\`envrc-prompt.test.ts\`)
   - \`noop_already_set\` のトリガーを「env 変数セット」経由に差し替え
   - テスト前後で \`process.env.CMUX_CLAUDE_HOOKS_DISABLED\` を必ず復元する（他テストへのリーク防止）
   - ファイル内容ベースの既存テストは削除 or 残すなら新仕様に合わせる
4. \`EnvrcCheckResult\` の action の型は変更不要（\`noop_already_set\` を流用）

## 影響範囲

- \`skills/cmux-team/manager/envrc-prompt.ts\`
- \`skills/cmux-team/manager/envrc-prompt.test.ts\`

## 検証観点

- .envrc.local のみに export がある状態で cmux-team start しても過剰プロンプトが出ないこと
- .envrc に未設定でも shell で export CMUX_CLAUDE_HOOKS_DISABLED=1 してから起動すればプロンプトが出ないこと
- .envrc にも env にも未設定なら従来通りプロンプトが出ること
- 既存テストが全部 green


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-223-1776355123` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-223-1776355123
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-223-1776355123/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/223-cmux-claude-hooks-disabled/runs/task-223-1776355123
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/223-cmux-claude-hooks-disabled/runs/task-223-1776355123/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
