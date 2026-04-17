# 実装計画書: .envrc に CMUX_CLAUDE_HOOKS_DISABLED 追記の対話的確認

## 目的

`cmux-team start` 起動時、プロジェクトルートに `.envrc` がある場合に「`export CMUX_CLAUDE_HOOKS_DISABLED=1` を追記してよいか」をユーザーに対話的に確認する。
ユーザー所有ファイル（`.envrc`）は黙って編集せず、明示的同意を得るのが原則。

## 設計方針

- **TUI 起動より前**に同期実行する。Ink TUI（`startDashboard`）が stdin/stdout を奪うため、それより手前で readline プロンプトを表示する。
- 既存の `preflight.ts` が「issue を集めて報告」型なのに対し、こちらは「副作用を伴う対話」なので **新規モジュール** `envrc-prompt.ts` として切り出す。
- 状態の永続化は `.team/config.json` に追加するフィールド `envrcHookPromptSkipped: boolean` で行う。
- テスト/CI 環境用に `CMUX_TEAM_NO_PROMPT=1` または stdin が TTY でない場合は対話をスキップする（黙って何もしない）。

## 変更対象ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/envrc-prompt.ts` | **新規作成**。チェック・対話・追記・config 更新の全ロジック |
| `skills/cmux-team/manager/main.ts` | `envrcHookPromptSkipped` を `TeamConfig` に追加。`cmdStart` 内で `initInfra` 後・`startDashboard` 前に `ensureEnvrcHookPrompt(state)` を呼び出す |
| `skills/cmux-team/manager/daemon.ts` | `initInfra` で生成するデフォルト `config.json` に `envrcHookPromptSkipped: false` を追加（任意。なくても `?? false` で動くため、これは「明示しておく」だけ） |
| `skills/cmux-team/manager/envrc-prompt.test.ts` | **新規作成**。Bun テスト |

## .team/config.json スキーマ拡張

現状 `config.json` 用の Zod スキーマは存在せず、`main.ts:86` で `TeamConfig` interface として定義されているのみ。最小の変更で済ませるため、以下を行う:

### main.ts (interface 拡張)

```ts
interface TeamConfig {
  models?: {
    master?: string;
    conductor?: string;
    agent?: string;
  };
  envrcHookPromptSkipped?: boolean;  // 追加
}
```

### Zod スキーマ化(任意・推奨せず)

config.json 用の Zod スキーマは現状ないため、本タスクでは導入しない（スコープ外）。
`envrc-prompt.ts` 内では既存 `loadConfig()` 同様 `JSON.parse + interface キャスト` で扱う。

## envrc-prompt.ts 仕様

### エクスポート

```ts
export interface EnvrcCheckResult {
  action: "added" | "skipped_once" | "silenced" | "noop_no_envrc" | "noop_already_set" | "noop_silenced" | "noop_no_tty";
  warnings: string[];  // 例: "direnv が見つからないため direnv allow をスキップ"
}

export async function ensureEnvrcHookPrompt(projectRoot: string): Promise<EnvrcCheckResult>;
```

### 内部処理

1. **gating（対話プロンプトを出さない条件をすべて先にチェック）**
   - `process.env.CMUX_TEAM_NO_PROMPT` が truthy → `noop_silenced` (?) として扱い、ログ `envrc_check_skipped reason=env CMUX_TEAM_NO_PROMPT`
   - `!process.stdin.isTTY` → `noop_no_tty`、ログ `envrc_check_skipped reason=no_tty`
   - `.envrc` が存在しない → `noop_no_envrc`、ログ `envrc_check_skipped reason=no_envrc`
   - `.envrc` の本文に `CMUX_CLAUDE_HOOKS_DISABLED` の文字列が含まれる（値に関わらず）→ `noop_already_set`、ログ `envrc_check_skipped reason=already_set`
   - `.team/config.json` の `envrcHookPromptSkipped === true` → `noop_silenced`、ログ `envrc_check_skipped reason=user_silenced`

2. **対話プロンプト**
   - 仕様文言通り表示
   - `readline/promises` の `createInterface({ input: process.stdin, output: process.stdout })` → `rl.question(...)` で 1 行受け取る
   - 入力を trim。デフォルト（空文字 = Enter のみ） は `Y` 扱い

3. **分岐**

   | 入力（先頭1文字、大文字小文字区別あり） | 動作 |
   |---|---|
   | 空, `y`, `Y` | 追記 + `direnv allow` |
   | `n` | スキップ（今回のみ）。ログ `envrc_hook_prompt_declined reason=once` |
   | `N` | `.team/config.json` に `envrcHookPromptSkipped: true` を merge 保存。ログ `envrc_hook_prompt_silenced` |
   | その他 | `Y` 扱い（フォールバック）。仕様にない入力は厳密にエラーにせず、デフォルト動作で続行する方が UX が良い |

   仕様の表記が `[Y] 追記する [n] スキップ [N] 今後聞かない` で大文字小文字の区別あり。`Y/y` を「追加」、`n` を「今回スキップ」、`N` を「永続スキップ」とする。

4. **追記処理（"added" ケース）**
   - `.envrc` の末尾改行を保証してから以下を append:
     ```
     export CMUX_CLAUDE_HOOKS_DISABLED=1
     ```
   - `Bun.which("direnv")` で direnv 検出
     - あり → `execFile("direnv", ["allow", projectRoot])` を実行（失敗してもログのみで継続）
     - なし → `warnings.push("direnv が見つかりません — シェルを再起動するまで反映されません")`、ログ `direnv_not_found`
   - ログ `envrc_hook_disabled_added direnv=<true|false>`

5. **config 更新（"silenced" ケース）**
   - 既存 `config.json` を読み（存在しない/壊れていれば `{}` から開始）、`envrcHookPromptSkipped: true` を merge して書き戻す
   - JSON フォーマットは既存 (2-space indent + 末尾改行) に合わせる

### エラーハンドリング方針

- `.envrc` の読み書きや `direnv allow` の失敗で `cmux-team start` 全体を止めない（プロジェクトの本番ワークフローを阻害しない）
- 失敗は `log("error", ...)` または `*_failed` ログを残して握る（CLAUDE.md ロギングポリシー準拠）
- ただし、ユーザーが `Y` を選んだのに `.envrc` 追記に失敗した場合は `console.error` でも一行通知する（ユーザーは追記されたと思っているため）

## main.ts への組み込み

### TeamConfig 拡張

`main.ts:86-92` の `interface TeamConfig` に `envrcHookPromptSkipped?: boolean` を追加。

### 呼び出し位置

`main.ts:cmdStart` 内、以下の順序を維持:

1. preflight (`main.ts:192`)
2. `createDaemon` (`main.ts:198`)
3. `initSourceWatcher` / `initFileWatcher`
4. `initInfra(state)` (`main.ts:207`) — **ここで `.team/config.json` のデフォルトが生成される**
5. **【新規追加】** `await ensureEnvrcHookPrompt(PROJECT_ROOT)` ← TUI 起動前。`initInfra` の直後、`log("infra_ready")` の前 or 後（後でよい）
6. proxy 起動 (`main.ts:222-238`)
7. `startDashboard` (`main.ts:274`) ← Ink が stdin/stdout を奪う

```ts
// main.ts:208 付近
await initInfra(state);
await log("infra_ready");
await ensureEnvrcHookPrompt(PROJECT_ROOT);  // ← 追加
await log("daemon_started", `pid=...`);
```

`ensureEnvrcHookPrompt` は内部でログを出すため、main 側で結果値を使う必要はなく fire-and-forget でよい（`await` のみ必須）。

## ログイベント一覧（logger.ts の `log(event, detail)` を使用）

| event | detail 例 | 発生条件 |
|---|---|---|
| `envrc_check_skipped` | `reason=no_envrc` / `reason=already_set` / `reason=user_silenced` / `reason=no_tty` / `reason=env CMUX_TEAM_NO_PROMPT` | gating で抜けた |
| `envrc_hook_disabled_added` | `direnv=true` または `direnv=false` | 追記成功 |
| `envrc_hook_disabled_add_failed` | エラーメッセージ | 追記失敗 |
| `envrc_hook_prompt_declined` | `reason=once` | n 選択 |
| `envrc_hook_prompt_silenced` | （空） | N 選択 |
| `direnv_not_found` | （空） | direnv バイナリなし |
| `direnv_allow_failed` | エラーメッセージ | `direnv allow` の exit code != 0 |

## CMUX_TEAM_NO_PROMPT の扱い

- 値が truthy（空文字以外）であればプロンプトを完全スキップ。何もしない（追記もしないし silenced 状態にもしない）。
- E2E テスト（`skills/cmux-team/manager/e2e.ts`）と CI、および非対話シェルでの動作を保証するため。
- README やヘルプテキストへの追記は本タスクのスコープ外（dockeeper / docs-sync 側で扱う）。

## テスト方法

### Bun ユニットテスト (`envrc-prompt.test.ts`)

各ケースで `process.env.CMUX_TEAM_NO_PROMPT` を一時設定 / `process.stdin.isTTY` をモックする方法に注意（実機 stdin はテストでは TTY ではないことが多いため、デフォルトで `noop_no_tty` を返す)。
対話部分のテストは「stdin を文字列でインジェクトする」より、「`createInterface` を内部で呼ぶラッパー関数 `askYNQuestion(): Promise<"Y"|"n"|"N">` を export して、テストではそのラッパーをモック」する設計にすると簡潔。

最小限のテストケース:

| ケース | 入力 | 期待結果 |
|---|---|---|
| `.envrc` なし | — | `noop_no_envrc` |
| `.envrc` あり、`CMUX_CLAUDE_HOOKS_DISABLED` 既存 | — | `noop_already_set` |
| `config.envrcHookPromptSkipped=true` | — | `noop_silenced` |
| `CMUX_TEAM_NO_PROMPT=1` | — | `noop_silenced` |
| 非 TTY | — | `noop_no_tty` |
| 対話: `Y` 入力 | `.envrc` に追記される / config は不変 | `added` |
| 対話: `n` 入力 | `.envrc` も config も不変 | `skipped_once` |
| 対話: `N` 入力 | `.envrc` 不変 / config に `envrcHookPromptSkipped: true` | `silenced` |
| 対話: `Y` 入力 + direnv なし | `.envrc` に追記、warnings に direnv 警告 | `added` |

### 手動 E2E テスト

`docs/spec/05-install-and-infrastructure.md` のテスト手順に沿う:

1. テスト用ディレクトリで `git init && echo "source_up" > .envrc`
2. `cmux` 起動 → `cmux-team start` → 対話プロンプトが表示されることを確認
3. `Y` 選択 → `.envrc` に追記される、`direnv allow` が走ることを確認
4. 再度 `cmux-team start` → `noop_already_set` でスキップ
5. `.envrc` の `CMUX_CLAUDE_HOOKS_DISABLED` 行を消して `cmux-team start` → プロンプト再表示 → `N` 選択
6. `.team/config.json` に `envrcHookPromptSkipped: true` が記録されたことを確認
7. 再度 `cmux-team start` → `noop_silenced` でスキップ

## 完了条件

- `envrc-prompt.ts` が新規作成され、上記 8 ケースのテストが通る
- `main.ts` の `cmdStart` で TUI 起動前に呼び出されている
- `cmux-team start` を `.envrc` あり/なし両方で実行して期待動作することを確認
- ログ仕様に準拠したイベントが `.team/logs/manager.log` に記録される
- 既存テスト（`bun test` で実行できるもの）が壊れていない

## 補足: 本タスクの非スコープ

- README / docs/spec/ への記述追加（dockeeper / docs-sync 側で対応）
- `envrcHookPromptSkipped` を再度 `false` に戻す UX（リセットコマンド）— 必要になったら `cmux-team config reset envrc-prompt` 等を別タスクで
- `.envrc` 以外のシェル設定ファイル（`.zshrc` 等）への対応
- `direnv` 以外のツール（`asdf`, `mise` 等）への対応
