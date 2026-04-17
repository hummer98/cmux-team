---
id: 225
title: direnv allow 未実行時に cmdStart / spawn-agent で fail-fast
priority: medium
created_at: 2026-04-16T20:20:44.328Z
---

## タスク
## 背景

`.envrc` が direnv allow されていない状態で cmux-team を起動すると、
\`CLAUDE_CODE_OAUTH_TOKEN\` 等の env が direnv により block され、
Conductor / Agent が意図しない認証経路（デフォルト credits 等）で
起動してしまう事故が発生しうる。特に spawn-agent は無警告で Agent を
起動するため、誤経路に気づきにくい。

## 方針

direnv.toml の \`[whitelist.prefix]\` による auto-approve は**採用しない**
（direnv のセキュリティモデルを外すため）。代わりに起動パスで
fail-fast するチェックを追加する。

## 修正内容

### 1. ヘルパー関数の追加

新規 util 関数（場所は実装者判断、\`envrc-prompt.ts\` 横に置くのが自然）:

\`\`\`ts
async function checkDirenvAllowed(projectRoot: string): Promise<
  | { status: \"ok\" }
  | { status: \"not_allowed\" }
  | { status: \"no_envrc\" }
  | { status: \"no_direnv\" }
> {
  // 1. .envrc が無ければ \"no_envrc\" （gating すり抜け OK）
  // 2. direnv バイナリが無ければ \"no_direnv\" （警告のみ、block しない）
  // 3. direnv status を実行し、\"Loaded RC allowed 1\" を含めば \"ok\"
  //    含まなければ \"not_allowed\"
}
\`\`\`

\`direnv status\` の stdout を parse する。正確なマーカー文字列は実装時に
\`direnv status\` の実出力で確認（allow 時: \"Loaded RC allowed 1\" /
未 allow 時: \"Found RC allowed 0\" など）。

### 2. cmdStart の冒頭にチェックを追加

\`skills/cmux-team/manager/main.ts\` の \`cmdStart\` の先頭（daemon 起動前、
envrcHookPrompt より前）で \`checkDirenvAllowed\` を実行。

- \`not_allowed\` → stderr にメッセージ出力して exit 1
  \`\`\`
  [cmux-team] .envrc が direnv allow されていません。
  以下を実行してから再度 cmux-team start してください:
    direnv allow
  \`\`\`
- \`no_direnv\` → 警告（既存の envrc-prompt.ts と同じ warnings に載せる）
- \`ok\` / \`no_envrc\` → そのまま続行

### 3. cmdSpawnAgent の冒頭にも同等チェック

\`cmdSpawnAgent\` の冒頭（throttle ガードより前）でも \`checkDirenvAllowed\`
を実行する。Conductor 経由で呼ばれる際に envrc が再び block 状態に
なっているケース（pull 後など）も検出できる。

- \`not_allowed\` → stderr に案内 + exit 1
- message format は cmdStart と揃える

### 4. テスト

\`envrc-prompt.test.ts\` と同じ方式で \`checkDirenvAllowed\` の単体テスト:
- \`.envrc\` 無し → \"no_envrc\"
- direnv path 差し替えで null → \"no_direnv\"
- direnv status stdout モックで allowed/not_allowed の両分岐

### 5. envrc-prompt.ts との関係

既存の \`envrc-prompt.ts\` は \`.envrc\` に \`CMUX_CLAUDE_HOOKS_DISABLED\`
を追記する処理の中で \`direnv allow\` を呼んでいる（:220）。
fail-fast チェックを cmdStart の **envrcHookPrompt より前** に置くと、
未 allow 状態では envrcHookPrompt 自体が実行されず、先に allow を
促す仕様になる。これは望ましい（順序として allow → append → reload）。

## 影響範囲

- \`skills/cmux-team/manager/envrc-prompt.ts\`（または新規ファイル）
- \`skills/cmux-team/manager/main.ts\` (cmdStart / cmdSpawnAgent)
- 対応するテスト

## 検証観点

- allow 未実行で cmux-team start → 明瞭なエラー + exit 1
- allow 後に cmux-team start → 正常起動
- .envrc が無いリポジトリでは従来通り起動
- direnv 未インストール環境では警告のみ（block しない）
- spawn-agent 単体でも未 allow なら同じ挙動
- cmux-team start 実行時に envrcHookPrompt が出る前に allow チェックが先行

## 参考

- T212: worktree の .envrc 生成削除コミット（5054a5d）
- 既存 allow 呼び出し: envrc-prompt.ts:220
- T223: envrc env 変数チェック（同じファイル領域を触るが独立スコープ）
