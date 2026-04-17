# T223 実装計画書 — envrc-prompt の env 変数チェック追加

## 1. 概要

`ensureEnvrcHookPrompt` の gating に「`process.env.CMUX_CLAUDE_HOOKS_DISABLED` が truthy なら早期 return」を追加し、`.envrc.local` / `~/.zshenv` / `source_up` / 外部注入 など `.envrc` 本体以外で設定されたケースの検知漏れを解消する。

## 2. 設計判断

### 2.1 ファイル内容チェックの扱い — **両方残す**

タスク指示では「削除推奨」だが、以下の理由で **env チェックとファイル内容チェックの両方を残す** 判断とする。

**両方残す根拠:**

- `.envrc` に `export CMUX_CLAUDE_HOOKS_DISABLED=1` が書いてあるが **direnv allow 未実行** のケースでは、env 変数は未設定のまま。
- この状態で env チェックのみにすると、既に書いてある export 行があるにもかかわらず再度プロンプトが表示され、`Y` を選ぶと **`appendExportLine` が重複行を追記** する。これはユーザー体験として明確に劣化する（毎回起動のたびに重複行が増える可能性）。
- env チェック + file チェックの順で両方残せば、direnv allow 漏れケースも静かに skip でき、コスト（数行の if 文と test 1 件）も小さい。

**順序:** env チェック → file チェックの順。env の方がより「実際に有効か」を表す真値に近く、また `.envrc` が書かれていない / 読めないケースでも早期 return できて効率的。

**ログ区別:**

- env でヒット: `envrc_check_skipped reason=already_in_env`（タスク指示準拠）
- file でヒット: `envrc_check_skipped reason=already_in_envrc`（既存の `reason=already_set` から改名 — env と区別できるように）

### 2.2 envOverride の型拡張 — **追加する**

既存の `envOverride?: { CMUX_TEAM_NO_PROMPT?: string }` のパターンに倣い、`CMUX_CLAUDE_HOOKS_DISABLED?: string` を追加する。

**根拠:**

- テストから `process.env` を直接 mutate する代わりに envOverride でクリーンに注入できる（既存の `CMUX_TEAM_NO_PROMPT` テストと同じ流儀）。
- 直接 mutate も許容するが、envOverride があれば優先される（`??` で解決）。テストは envOverride を使う前提で書くが、念のため beforeEach/afterEach で `process.env.CMUX_CLAUDE_HOOKS_DISABLED` の save/restore も行う。

## 3. 実装手順（envrc-prompt.ts）

### 3.1 EnsureOptions の envOverride 型拡張

ファイル: `skills/cmux-team/manager/envrc-prompt.ts`
対象行: 124 行目

**変更前:**
```ts
envOverride?: { CMUX_TEAM_NO_PROMPT?: string };
```

**変更後:**
```ts
envOverride?: { CMUX_TEAM_NO_PROMPT?: string; CMUX_CLAUDE_HOOKS_DISABLED?: string };
```

### 3.2 env 変数チェック gating の追加

対象行: 140〜144 行目（`CMUX_TEAM_NO_PROMPT` の if ブロック）の **直後** に挿入。

**挿入コード:**
```ts
const hooksDisabledEnv =
  options.envOverride?.CMUX_CLAUDE_HOOKS_DISABLED ?? process.env.CMUX_CLAUDE_HOOKS_DISABLED;
if (hooksDisabledEnv) {
  await log("envrc_check_skipped", "reason=already_in_env");
  return { action: "noop_already_set", warnings };
}
```

### 3.3 既存 file 内容チェックの log reason 変更

対象行: 166 行目

**変更前:**
```ts
await log("envrc_check_skipped", "reason=already_set");
```

**変更後:**
```ts
await log("envrc_check_skipped", "reason=already_in_envrc");
```

返り値 `{ action: "noop_already_set", warnings }` はそのまま維持。`EnvrcAction` 型も変更不要。

## 4. テスト変更手順（envrc-prompt.test.ts）

### 4.1 beforeEach / afterEach に CMUX_CLAUDE_HOOKS_DISABLED の save/restore を追加

対象: 8〜32 行目

**追加箇所:**

- `let savedHooksDisabled: string | undefined;` を上部に宣言
- `beforeEach` 内で `savedHooksDisabled = process.env.CMUX_CLAUDE_HOOKS_DISABLED; delete process.env.CMUX_CLAUDE_HOOKS_DISABLED;`
- `afterEach` 内で save の値に基づき restore（既存の savedNoPrompt と同じパターン）

### 4.2 新規テスト追加（"ensureEnvrcHookPrompt - gating" describe 内）

**テスト名:** `CMUX_CLAUDE_HOOKS_DISABLED=1 (envOverride) なら noop_already_set`

**内容:**
- `.envrc` に CMUX_CLAUDE_HOOKS_DISABLED を含まない内容（例: `"source_up\n"`）を作る
- `envOverride: { CMUX_CLAUDE_HOOKS_DISABLED: "1" }` を渡す
- `r.action === "noop_already_set"` を assert
- `.envrc` の内容が変更されていない（export 行が追記されていない）ことを assert

**任意追加テスト:** `process.env.CMUX_CLAUDE_HOOKS_DISABLED=1 (直接) なら noop_already_set`

- `process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1"` を直接セット
- envOverride を渡さない
- `r.action === "noop_already_set"` を assert
- afterEach で restore される（4.1 で実装済み）
- これが 4.1 の restore 実装を実質的に検証するため入れておく価値あり

### 4.3 既存テスト `.envrc に CMUX_CLAUDE_HOOKS_DISABLED が既存なら noop_already_set` は残す

対象行: 47〜51 行目。両方残す判断のため保持。テストコード自体の変更は不要。

### 4.4 テスト追加・変更まとめ

| 種別 | テスト名 | 変更内容 |
|------|---------|---------|
| 追加 | `CMUX_CLAUDE_HOOKS_DISABLED=1 (envOverride) なら noop_already_set` | envOverride 経由のスキップ確認 |
| 追加 | `process.env.CMUX_CLAUDE_HOOKS_DISABLED=1 (直接) なら noop_already_set` | direct env mutation 経路 + restore 動作検証 |
| 維持 | `.envrc に CMUX_CLAUDE_HOOKS_DISABLED が既存なら noop_already_set` | 両方残す方針のためそのまま |
| 維持 | その他の gating / 対話テスト | 影響なし |
| 変更 | beforeEach / afterEach | `CMUX_CLAUDE_HOOKS_DISABLED` の save/restore を追加 |

削除するテストはなし。

## 5. 検証方法

### 5.1 単体テスト

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-223-1776355123/skills/cmux-team/manager
bun test envrc-prompt.test.ts
```

全テスト green になること。既存 10 件 + 新規 2 件 = 12 件。

### 5.2 型チェック

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-223-1776355123/skills/cmux-team/manager
bun x tsc --noEmit
```

型エラーが無いこと（envOverride 型拡張の整合性確認）。

### 5.3 手動検証観点（実装者の確認用 — 必須ではないが推奨）

- `.envrc.local` のみに `export CMUX_CLAUDE_HOOKS_DISABLED=1` を書き direnv allow した状態で `cmux-team start` → プロンプトが出ないこと（env にセットされている前提）
- `.envrc` には未記載、shell で `export CMUX_CLAUDE_HOOKS_DISABLED=1` してから `cmux-team start` → プロンプトが出ないこと
- `.envrc` にも env にも未設定 → 従来通りプロンプトが出ること
- `.envrc` に export を書いたが direnv allow 未実行 → file チェックで skip され、重複 append が起きないこと（両方残す判断の正当性確認）
