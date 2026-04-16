# T225 実装計画 — `.envrc` allow 未済の fail-fast チェック

## 1. 概要（3 行）

- `.envrc` が `direnv allow` されていない状態で `cmux-team start` / `cmux-team spawn-agent` が走ると、`CLAUDE_CODE_OAUTH_TOKEN` 等が block されたまま Conductor/Agent が意図しない認証経路で起動する問題を fail-fast で防ぐ。
- 新規ヘルパー `checkDirenvAllowed(projectRoot)` を追加し、`direnv status` の stdout を parse して `"ok" | "not_allowed" | "no_envrc" | "no_direnv"` の 4 値を返す。
- `cmdStart`（daemon 起動前・`ensureEnvrcHookPrompt` より前）と `cmdSpawnAgent`（throttle ガードより前）で実行し、`not_allowed` なら stderr にメッセージを出して `exit 1`。

## 2. ファイル配置

### 推奨: 新規ファイル `skills/cmux-team/manager/direnv-check.ts`

**判断根拠:**

| 観点 | envrc-prompt.ts に追記 | 新規ファイル direnv-check.ts |
|---|---|---|
| 責務の分離 | 対話プロンプト + allow 判定が同居 | 非対話の allow 判定だけに集中 |
| 既存パターン整合 | 1 ファイル 1 責務の慣例から外れる | preflight.ts と同じパターン |
| テスト容易性 | 既存テストに混在 | 独立した test ファイル |
| import 副作用 | envrc-prompt.ts は `readline/promises` を import しており、非対話コンテキスト（spawn-agent）から呼ぶと重い | direnv-check.ts は child_process だけで軽量 |

**結論:** 新規ファイル `skills/cmux-team/manager/direnv-check.ts` を作る。
テストは `skills/cmux-team/manager/direnv-check.test.ts`（新規）。

**エクスポート対象:**
- `export type DirenvAllowStatus = "ok" | "not_allowed" | "no_envrc" | "no_direnv"`
- `export interface CheckDirenvOptions { ... }`（DI 用）
- `export async function checkDirenvAllowed(projectRoot: string, options?: CheckDirenvOptions): Promise<DirenvAllowStatus>`
- `export function formatDirenvNotAllowedMessage(projectRoot: string): string`（stderr 出力文言を再利用するため）

## 3. `checkDirenvAllowed` 関数シグネチャと実装方針

### 3.1 シグネチャ

```ts
export type DirenvAllowStatus = "ok" | "not_allowed" | "no_envrc" | "no_direnv";

export interface CheckDirenvOptions {
  /** テスト用に Bun.which を差し替え */
  which?: (bin: string) => string | null;
  /** テスト用に direnv status の実行を差し替え */
  runDirenvStatus?: (cwd: string) => Promise<{ stdout: string; stderr: string }>;
}

export async function checkDirenvAllowed(
  projectRoot: string,
  options?: CheckDirenvOptions,
): Promise<DirenvAllowStatus>;
```

### 3.2 async/sync

- **async 関数にする**。`direnv status` は外部プロセス呼び出しで、Node の `execFile` は本質的に非同期。
  既存 `ensureEnvrcHookPrompt` も async なので整合する。

### 3.3 `direnv` バイナリ存在確認

- **`Bun.which("direnv")` を使う**。`preflight.ts` の `checkClaude` / `checkJq` と同方式。
  `options.which` を経由し、テスト時は差し替え可能にする（`checkJq` の DI パターン `(b) => Bun.which(b)` を踏襲）。
- 返り値が `null` → `"no_direnv"`。この場合 `direnv status` は呼ばない。

### 3.4 `.envrc` 存在確認

- `join(projectRoot, ".envrc")` を `existsSync` で確認。
  `envrc-prompt.ts:159-163` と同じ。
- 存在しない → `"no_envrc"`（gating すり抜け）。

### 3.5 `direnv status` 呼び出しと parse

- `execFile("direnv", ["status"], { cwd: projectRoot })` を `promisify` して呼ぶ。
  `envrc-prompt.ts:17-22` と同じパターン（`const execFile = promisify(execFileCb);`）。
- `options.runDirenvStatus` があればそれを使う（DI）。
- stdout を行単位で分解し、以下の 2 行を探す:
  ```
  Loaded RC allowed <N>
  Found RC allowed <N>
  ```
- **判定ロジック:**
  - `Loaded RC allowed` 行の `<N>` が `1` なら `"ok"`
  - それ以外（`Loaded RC allowed 0` / `Loaded RC allowed 2` / `Loaded RC allowed` 行が無い）なら `"not_allowed"`
  - `Found RC allowed` は補助情報として使用可（現状の判定には `Loaded` だけで足りる）

### 3.6 `<N>` の値の意味（Implementer が実測で検証）

- **task.md の記述:** `Loaded RC allowed 0` = 未 allow、`Loaded RC allowed 1` = allow 済み
- **実測（direnv allow 未実行）:** `Loaded RC allowed 0` / `Found RC allowed 0` を確認済み
- **未確認:** `2` の意味（恐らく明示的 deny）
- **Implementer の作業:**
  1. `direnv allow` 実行後に `direnv status` を実測 → `1` であることを確認
  2. `direnv deny` 実行後に `direnv status` を実測 → `2` が出るかを確認
  3. `0` / `2` ともに `"not_allowed"` 扱いとする（allow=1 だけを OK とする安全側ロジック）
  4. 該当行が全く出ない場合も `"not_allowed"` にフォールバック（例: `.envrc` が空の場合）

### 3.7 エラーハンドリング

- `execFile("direnv", ["status"], ...)` が失敗した場合（例: stdout 取得不能、異常な exit code）:
  - **fail-closed 方針** — `"not_allowed"` を返す（セキュリティ重視）
  - ログ: `log("direnv_status_failed", formatExecError(e))` を 1 行記録
  - 理由: 「allow 済みであることを確認できない」は未 allow と同等に扱う。誤検知で `cmux-team start` が止まっても実害は小さいが、誤って通すと認証経路が乱れる。
- エラーハンドリングには `exec-error.ts` の `formatExecError` / `sanitizeForLog` を使用。

## 4. `cmdStart` への組み込み

### 4.1 挿入位置

`skills/cmux-team/manager/main.ts` の `cmdStart`（L318 開始）:

| 行 | 既存処理 |
|---|---|
| L321-324 | `CMUX_SOCKET_PATH` 環境変数チェック |
| L330-334 | `runPreflight` + `printPreflightIssues` + `exit 1` |
| L337-344 | `loadConfig` + `resolveLayout` |
| L375 | `createDaemon`（daemon 起動開始） |
| L387 | `initInfra` |
| **L392** | **`ensureEnvrcHookPrompt(PROJECT_ROOT)`** |

**挿入点: L334 直後（preflight の直後、`loadConfig` より前）**

理由:
- 「daemon 起動前」= `createDaemon` (L375) より前
- 「`envrcHookPrompt` より前」= L392 より前
- preflight と同じ「環境前提チェック」の性質なので、preflight の直後が概念的に自然
- `loadConfig` 等は不要なので早期 exit の効率も良い

### 4.2 実装スケッチ

```ts
// L334 の直後に追加
import { checkDirenvAllowed, formatDirenvNotAllowedMessage } from "./direnv-check";

const direnvStatus = await checkDirenvAllowed(PROJECT_ROOT);
if (direnvStatus === "not_allowed") {
  console.error(formatDirenvNotAllowedMessage(PROJECT_ROOT));
  await log("direnv_not_allowed", "command=start");
  process.exit(1);
}
if (direnvStatus === "no_direnv") {
  await log("direnv_not_found", "command=start");
  // warnings には後段の envrcHookPrompt と同じ文言を載せる
  // （cmdStart に warnings 配列は無いため console.warn で即時出力）
  console.warn("[cmux-team] direnv が見つかりません — .envrc の環境変数は反映されません");
}
// "ok" / "no_envrc" は続行（既存挙動を維持）
```

### 4.3 warnings 配列への追加方法

- **現状確認:** `cmdStart` には `ensureEnvrcHookPrompt` が返す `warnings` を収集する仕組みが **無い**（L392 は戻り値を捨てている）。
- **方針:** `no_direnv` の警告は `console.warn` で即時出力する。将来 `cmdStart` で warnings を集約する設計になったときに `ensureEnvrcHookPrompt` と合わせて載せ替える。
- 既存の envrc-prompt.ts は `warnings.push(...)` で配列に蓄積する設計（L231, L235）。Plan段階では「統一的に扱うリファクタは本タスクでは行わない」と明記しておく。

### 4.4 エラーメッセージ文言案（日本語）

`formatDirenvNotAllowedMessage(projectRoot)`:

```
❌ cmux-team start: .envrc が direnv allow されていません

  .envrc: <projectRoot>/.envrc

  .envrc に設定された CLAUDE_CODE_OAUTH_TOKEN / CMUX_CLAUDE_HOOKS_DISABLED
  等の環境変数が現在のセッションにロードされていません。このまま起動すると
  Conductor / Agent が意図しない認証経路で起動する恐れがあります。

  解決方法:
    1. cd <projectRoot>
    2. direnv allow
    3. cmux-team start を再実行
```

- `printPreflightIssues` の整形（`❌` + 空行 + インデント）と揃える。
- `projectRoot` は絶対パスで埋め込む（ユーザーが cd しやすくするため）。

## 5. `cmdSpawnAgent` への組み込み

### 5.1 挿入位置

`skills/cmux-team/manager/main.ts` の `cmdSpawnAgent`（L1799 開始）:

| 行 | 既存処理 |
|---|---|
| L1800 | `showHelp` |
| L1803-1807 | `conductor-surface` 引数正規化 |
| L1808-1815 | `role` / `prompt` / `prompt-file` 引数検証 |
| L1817-1818 | `resolveProxyPort` |
| L1820-1830 | team.json から conductor 情報取得 |
| **L1832-1865** | **throttle ガード（exit 75）** |

**挿入点: L1815 直後（引数検証が全て通った直後、`resolveProxyPort` より前）**

理由:
- 「throttle ガードより前」の要件を満たす
- 引数エラーの方が優先度高（そちらが先に出るべき）
- proxy port 取得より前なので、proxy が死んでいる状況でも正しく fail-fast する

### 5.2 実装スケッチ

```ts
// L1815 の直後に追加
const direnvStatus = await checkDirenvAllowed(PROJECT_ROOT);
if (direnvStatus === "not_allowed") {
  console.error(formatDirenvNotAllowedMessage(PROJECT_ROOT));
  await log("direnv_not_allowed", `command=spawn-agent role=${role}`);
  process.exit(1);
}
// no_direnv / no_envrc / ok は続行（spawn-agent 側では warnings 表示は行わない — Conductor が読めても action にならないため）
```

### 5.3 メッセージ形式を cmdStart と揃える

- `formatDirenvNotAllowedMessage(projectRoot)` を共通関数として使い、`cmux-team start` 文言を `cmux-team spawn-agent` に差し替えたい場合は引数で mode を渡す:
  - 案 A: `formatDirenvNotAllowedMessage(projectRoot, { command: "start" | "spawn-agent" })`
  - 案 B: 共通の冒頭行 `"❌ cmux-team: .envrc が direnv allow されていません"` に統一（コマンド名を入れない）
- **推奨: 案 B**。メッセージ再利用が単純で、スタックの上位からどう呼ばれても正しい。

## 6. テスト設計

### 6.1 テストファイル

**新規: `skills/cmux-team/manager/direnv-check.test.ts`**

理由:
- 既存 `envrc-prompt.test.ts` は対話プロンプトに特化しており、混ぜると見通しが悪い
- `preflight.test.ts` と同じスタイルで書けるため独立ファイルが自然
- テストのセットアップ（`mkdtemp` / gitInit 相当は不要 — `.envrc` を `writeFile` するだけ）が軽量

### 6.2 モック戦略

`envrc-prompt.test.ts` と同じ DI 方式を踏襲:

```ts
const baseOpts = {
  which: (bin: string) => bin === "direnv" ? "/usr/bin/direnv" : null,
  runDirenvStatus: async () => ({ stdout: "Loaded RC allowed 1\n", stderr: "" }),
};
```

- `which` で direnv の存在/非存在を制御
- `runDirenvStatus` で stdout をテストケースごとに差し替え
- `Bun.which` のモンキーパッチは不要（DI で十分）

### 6.3 テストケース（最低 4 つ、task 指示に従う）

| # | 前提 | 期待 |
|---|---|---|
| 1 | `.envrc` 無し | `checkDirenvAllowed(dir) === "no_envrc"` |
| 2 | `.envrc` 有り / `which` が null | `checkDirenvAllowed(dir, {...}) === "no_direnv"` |
| 3 | `.envrc` 有り / `which` OK / stdout に `Loaded RC allowed 1` | `"ok"` |
| 4 | `.envrc` 有り / `which` OK / stdout に `Loaded RC allowed 0` | `"not_allowed"` |

### 6.4 追加で書くべきテスト（推奨）

| # | ケース | 期待 |
|---|---|---|
| 5 | stdout に `Loaded RC` 行が無い（空 `.envrc`） | `"not_allowed"`（fail-closed） |
| 6 | stdout に `Loaded RC allowed 2`（deny 状態） | `"not_allowed"` |
| 7 | `runDirenvStatus` が throw する | `"not_allowed"`（fail-closed） + log 出力 |
| 8 | `formatDirenvNotAllowedMessage(projectRoot)` | 出力に `projectRoot` / `direnv allow` / `cmux-team` が含まれる（snapshot 的検証） |

テスト 5-7 は 3.7（エラーハンドリング）/ 3.6（`<N>` の値）で定めた仕様を保護する。

### 6.5 `main.ts` への組み込みの統合テストは書かない

- 現状 `cmdStart` / `cmdSpawnAgent` の process.exit 呼び出しを直接テストしている既存スイートは無い
- 本タスクでは単体テストに留め、E2E は CLAUDE.md の「機能テスト」手順（手動）で担保する
  → plan の「実装順序」最後で手動検証を行う

## 7. エッジケース

| ケース | 対応 |
|---|---|
| `direnv status` が一時的に失敗（execFile reject） | fail-closed → `"not_allowed"` + `log("direnv_status_failed", ...)` |
| `.envrc` はあるが空 | `direnv status` の stdout に `Loaded RC` 行が出ない可能性 → 行不在時は `"not_allowed"` にフォールバック |
| `.envrc` が読めない（権限エラー） | `existsSync` 自体は成功する可能性がある。`direnv status` 側でエラーになれば fail-closed |
| Linux / macOS の direnv バイナリパス差異 | `Bun.which("direnv")` が解決するため差異なし。Homebrew (`/opt/homebrew/bin/direnv`) / `/usr/local/bin/direnv` / `/usr/bin/direnv` を透過的にサポート |
| 複数の `.envrc`（サブディレクトリ含む） | 本タスクでは projectRoot 直下の `.envrc` のみ対象。`direnv status` の `Loaded RC path` が projectRoot 配下を指すかの検証は **しない**（複雑化するため）。将来必要ならフォローアップ |
| `CMUX_TEAM_NO_PROMPT=1` 等で skip したい需要 | 本タスクでは対応しない（fail-fast の意図に反するため）。`direnv allow` を実行するだけで解決するので bypass を用意しない |

## 8. envrc-prompt.ts との順序関係（task 指示の確認）

現状フロー（`cmdStart`）:
1. `createDaemon` → `initInfra` → `ensureEnvrcHookPrompt` (L392)
2. `ensureEnvrcHookPrompt` 内で Y 応答 → `appendExportLine` + `direnv allow` 実行 (envrc-prompt.ts:210-232)

新フロー:
1. `runPreflight` (L330)
2. **`checkDirenvAllowed` (新規、L335 付近)**
3. `createDaemon` → `initInfra` → `ensureEnvrcHookPrompt` (L392)

**未 allow 状態の挙動:**
- `.envrc` が未 allow なら手順 2 で exit
- ユーザーは `direnv allow` を手動実行 → 再起動
- その後も `ensureEnvrcHookPrompt` が `CMUX_CLAUDE_HOOKS_DISABLED` を `.envrc` に追記する必要があれば追記 + `direnv allow` を自動実行（既存挙動）
- 追記後は 2 回目の `cmux-team start` を実行（envrc-prompt.ts:116 の `POST_ADD_REMINDER` どおり）

**task.md の「allow → append → reload」仕様と整合するか確認:**
- allow: ユーザーが手動 → checkDirenvAllowed 通過
- append: `ensureEnvrcHookPrompt` が `CMUX_CLAUDE_HOOKS_DISABLED` を追記
- reload: `direnv allow` を自動呼び（envrc-prompt.ts:227）→ 次回の `cmux-team start` で反映
- ✓ 整合する。既存のフロー順序を崩さない。

## 9. 実装順序（TDD）

### Step 1: テスト先行

1. `skills/cmux-team/manager/direnv-check.test.ts` を新規作成
2. §6.3 のテスト 1-4 を記述（全て fail する状態にする）
3. §6.4 のテスト 5-8 も同時に記述

### Step 2: ヘルパー実装

4. `skills/cmux-team/manager/direnv-check.ts` を新規作成
   - `DirenvAllowStatus` 型
   - `CheckDirenvOptions` interface
   - `checkDirenvAllowed` 関数
   - `formatDirenvNotAllowedMessage` 関数
5. テスト green を確認（`bun test direnv-check.test.ts`）
6. `<N>` の値の実測確認:
   - `direnv allow` → `direnv status` → `Loaded RC allowed 1` を確認
   - `direnv deny` → `direnv status` → `Loaded RC allowed 2`（期待）を確認
   - 結果を `direnv-check.ts` の実装コメントに記録

### Step 3: 統合

7. `main.ts` に `import { checkDirenvAllowed, formatDirenvNotAllowedMessage } from "./direnv-check"` を追加
8. `cmdStart` の L334 直後に checkDirenvAllowed 呼び出しを挿入（§4.2）
9. `cmdSpawnAgent` の L1815 直後に checkDirenvAllowed 呼び出しを挿入（§5.2）

### Step 4: 手動検証

10. `direnv allow` 前の `.envrc` で `cmux-team start` → exit 1 + エラーメッセージ表示を確認
11. `direnv allow` 実行後 → `cmux-team start` が通常どおり続行することを確認
12. `cmux-team spawn-agent` も同様に検証（`direnv deny` 状態で exit 1）
13. `direnv` 未インストール環境（シミュレート: PATH から一時的に除外）→ 警告のみで続行することを確認

### Step 5: ログ確認

14. `.team/logs/manager.log` に以下が記録されることを確認:
    - `direnv_not_allowed command=start` / `command=spawn-agent role=<role>`
    - `direnv_not_found command=start`
    - `direnv_status_failed <exec-error>`（異常系）

### Step 6: ドキュメント

15. CLAUDE.md の「エラーリカバリ」セクションに direnv allow 関連のエントリ追加を検討（本タスク範囲で追記するかは Implementer 判断）
16. `docs/spec/` 該当ファイル（01-skill-cmux-team.md または 05-install-and-infrastructure.md）に fail-fast チェックの存在を反映（dockeeper 扱い or 本タスクで含める）

## 10. 作業境界の確認（Implementer 向け）

- ✅ 新規ファイル `direnv-check.ts` / `direnv-check.test.ts` 2 つだけ
- ✅ `main.ts` への変更は import 1 行 + 2 箇所（cmdStart / cmdSpawnAgent）の挿入のみ
- ❌ `envrc-prompt.ts` は触らない（既存挙動を崩さない）
- ❌ `preflight.ts` への統合は行わない（preflight は「同期 + 全 issue 積み上げ」の設計で direnv-check は「fail-fast」設計のため方針が異なる）
- ❌ E2E テスト追加は不要（手動検証のみ）
