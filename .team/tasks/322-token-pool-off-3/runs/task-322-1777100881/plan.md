# T322 token pool 機能 OFF 設定の 3 階層実装 — 計画書

worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-322-1777100881`

## 0. 背景と目的

T321 (`cc2d124`) で `cmdSpawnAgent` 冒頭に token pool の selection が無条件で組み込まれた。
複数組織で claude-credentials が登録された環境や CI / 一時無効化を行いたい場面では、
pool 経由のトークン注入を切りたい。本タスクでは **env / project / global** の 3 階層で
有効/無効を制御し、**未指定時は false（opt-in）** を既定とする。

## 1. 影響範囲（変更するファイル一覧）

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/config.ts` | `TeamConfig.tokenPool` フィールド追加、`loadGlobalConfig`、`resolveTokenPoolEnabled`、`isTokenPoolEnabled` 関数を追加 |
| `skills/cmux-team/manager/main.ts` | `cmdSpawnAgent` 冒頭の T321 try/catch ブロックを `isTokenPoolEnabled` でガード、`cmdStart` の起動ログに pool 状態を 1 行出力 |
| `skills/cmux-team/manager/main.test.ts` | `resolveTokenPoolEnabled` のテストを `resolveAutoUpdateMode` 隣に追加（既存パターンと統一） |
| `skills/cmux-team/manager/package.json` | `yaml` ライブラリを dependencies に追加（後述の決定 D1） |
| `skills/cmux-team/manager/bun.lock` | `bun install` で再生成 |

`token-store.ts` / `token-store.test.ts` には触らない（selection 自体はそのまま、呼び出すかどうかだけ切り替える）。

## 2. `isTokenPoolEnabled` の置き場所と signature

### 置き場所
`skills/cmux-team/manager/config.ts`。`loadConfig` / `resolveAutoUpdateMode` / `resolveFetchBeforeWorktree` と同じファイルに、
3 種類の関数として追加する：

```ts
// ── 型 ───────────────────────────────────────────────
export interface TeamConfig {
  // 既存フィールドの末尾に追加
  tokenPool?: { enabled?: boolean };
  // ...
}

export interface GlobalConfig {
  tokenPool?: { enabled?: boolean };
}

// ── 純粋関数（テストしやすい） ──────────────────────
/**
 * env / project / global の 3 階層から token pool 有効/無効を解決する。
 * 優先順位: env > project > global > default(false)
 *
 * env CMUX_TEAM_TOKEN_POOL の解釈:
 *  - "0" / "false" / "off" → false (source=env)
 *  - "1" / "true" / "on"  → true  (source=env)
 *  - 未定義 / 空文字       → 次の層にフォールバック
 *  - それ以外             → throw（cmdStart で exit 1）
 *
 * project / global の解釈:
 *  - フィールド未指定 / undefined / null → 次の層にフォールバック
 *  - boolean → そのまま
 */
export function resolveTokenPoolEnabled(
  projectConfig: Pick<TeamConfig, "tokenPool">,
  globalConfig: Pick<GlobalConfig, "tokenPool"> | null,
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; source: "env" | "project" | "global" | "default" };

// ── async I/O 層 ────────────────────────────────────
/** ~/.cmux-team/config.yaml を読み、無ければ null を返す。yaml が壊れていれば warning ログのみ出して null を返す（best-effort）。 */
export async function loadGlobalConfig(): Promise<GlobalConfig | null>;

/**
 * 3 階層を全て読み出して boolean に解決する高レベル wrapper。
 * cmdSpawnAgent / cmdStart はこれを使うだけでよい。
 * @returns enabled と source（ログ用）
 */
export async function isTokenPoolEnabled(
  projectRoot: string,
): Promise<{ enabled: boolean; source: "env" | "project" | "global" | "default" }>;
```

> **boolean を返すか `{ enabled, source }` を返すか**: 既存の `resolveAutoUpdateMode` / `resolveFetchBeforeWorktree` は
> `{ ..., source }` を返している。ログに source を出したいので合わせる。タスク定義は `: boolean` だが、
> 呼び出し側は `(await isTokenPoolEnabled(root)).enabled` で boolean を取る形でカバーする。

## 3. 設定読み込みの実装方針

### 3.1 env (`CMUX_TEAM_TOKEN_POOL`)

`resolveAutoUpdateMode` / `resolveFetchBeforeWorktree` と同じスタイル：

```ts
const raw = env.CMUX_TEAM_TOKEN_POOL;
if (raw === undefined || raw === "") return null;  // 次の層へ
const v = raw.trim().toLowerCase();
if (v === "0" || v === "false" || v === "off") return false;
if (v === "1" || v === "true" || v === "on")  return true;
throw new Error(`unknown CMUX_TEAM_TOKEN_POOL=${JSON.stringify(raw)} (expected 0|1|true|false|on|off)`);
```

タスク本文の「`""` を false」は `resolveAutoUpdateMode` 等の既存ルール（空文字＝未指定）と一致しないため、
**空文字は未指定扱い** に倒す（決定 D2）。これを CLAUDE.md 「逸脱を防ぐより、構造的に正しい」精神で揃える。

### 3.2 project (`.team/config.json`)

`TeamConfig.tokenPool?: { enabled?: boolean }` を追加し、`loadConfig` の戻り値そのまま使う。
オブジェクト未指定 / `enabled` 未指定 → 次の層。boolean 型でなければ JSON parse 段階でゆるく `Boolean(...)` 変換せず、
**型違反は無視（未指定扱い）** とする。zod を入れるほどではないので runtime check は最小限。

```jsonc
// .team/config.json 例
{
  "tokenPool": { "enabled": false }
}
```

> JSON 上のフィールド名は **camelCase の `tokenPool`** で統一する（既存 `autoUpdate` / `sleepPrevention` / `mainBranch` と整合）。
> タスク本文に `token_pool.enabled` とあるが、これは「設定キーの意味」を表す表記であり、
> 実装上の JSON キーは camelCase を採用する（決定 D3）。global yaml は yaml 慣習で `token_pool` と snake_case で受け入れる（後述）。

### 3.3 global (`~/.cmux-team/config.yaml`)

新規ファイル。`os.homedir() + "/.cmux-team/config.yaml"` を読む。

```yaml
# ~/.cmux-team/config.yaml 例
token_pool:
  enabled: true
```

- yaml 慣習に従い snake_case (`token_pool`) で受ける。読み出し側で `tokenPool` に正規化する。
- ライブラリ: `yaml`（eemeli/yaml）。理由は決定 D1 を参照。
- ファイル不在 → `null`。
- ファイルあるが parse 失敗 → `console.warn` + `log("global_config_parse_failed", ...)` + `null`（best-effort、stop はしない）。
- ディレクトリは tokens.db 用に既に `mkdirSync({ mode: 0o700 })` されている（`token-store.ts:158`）。yaml 読み出し側では mkdir しない。

### 3.4 各層が「未指定」のときの fallback

```
env が解決値を返した        → それを採用 (source=env)
else project.tokenPool.enabled が boolean → それを採用 (source=project)
else global.tokenPool.enabled が boolean → それを採用 (source=global)
else                                       → false (source=default)
```

## 4. `cmdSpawnAgent` 改修

現状 (`main.ts:2521-2534`):

```ts
// T321: token pool からトークンを選択して CLAUDE_CODE_OAUTH_TOKEN を注入
try {
  const tokDb = initTokenDB();
  const selected = selectToken(tokDb, surface);
  if (selected) { ... }
  else { await log("token_pool_fallback", ...); }
} catch (e: any) { await log("token_pool_fallback", ...); }
```

改修後（インデント節約のため早期 return スタイル）:

```ts
// T322: token pool は env/project/global の 3 階層で opt-in 制御する
const poolDecision = await isTokenPoolEnabled(PROJECT_ROOT);
if (!poolDecision.enabled) {
  await log("token_pool_skipped", `${formatSurface(surface, "A")} source=${poolDecision.source}`);
} else {
  // T321: token pool からトークンを選択して CLAUDE_CODE_OAUTH_TOKEN を注入
  try {
    const tokDb = initTokenDB();
    const selected = selectToken(tokDb, surface);
    if (selected) {
      const tokenStr = retrieveTokenFromKeychain(selected.token.handle);
      exportVars.push(`CLAUDE_CODE_OAUTH_TOKEN=${tokenStr}`);
      await log("token_pool_assigned", `${formatSurface(surface, "A")} handle=${selected.token.handle} token_id=${selected.token.id} source=${poolDecision.source}`);
    } else {
      await log("token_pool_fallback", `${formatSurface(surface, "A")} reason=no_candidate`);
    }
  } catch (e: any) {
    await log("token_pool_fallback", `${formatSurface(surface, "A")} reason=error err=${e?.message ?? e}`);
  }
}
```

ポイント:
- T321 の try/catch ブロックは **そのまま温存**（壊さない）。外側に enable ガードを 1 段足すだけ。
- 無効化された場合は `token_pool_skipped` という新しい kind でログを出し、追跡できるようにする（既存 fallback と区別）。
- `isTokenPoolEnabled` の throw（env 不正値）は呼び出し元 `cmdSpawnAgent` の既存 try/catch で拾われない。
  spawn-agent サブコマンド全体は CLI exit する想定なので **throw 時は process.exit(1) させる前にエラー文を console.error**
  する短い try/catch を `cmdSpawnAgent` 冒頭に置く（`cmdStart` の `resolveAutoUpdateMode` と同じパターン）。

## 5. `cmdStart` 初期化ログ

`main.ts:643-654` 付近、`fetch_before_worktree` のログ直後に追加：

```ts
// T322: token pool の有効/無効を 1 行ログに出す（運用者が pool 経路かどうかを直視できるように）
try {
  const poolDecision = await isTokenPoolEnabled(PROJECT_ROOT);
  await log(
    "token_pool_config",
    `enabled=${poolDecision.enabled ? "on" : "off"} source=${poolDecision.source}`,
  );
} catch (e: any) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
```

- ログ kind: `token_pool_config`（既存の `auto_update_config` / `fetch_before_worktree` と統一感ある命名）。
- フォーマット: `enabled=<on|off> source=<env|project|global|default>`。
- 出力タイミング: `daemon_started` の直後で、proxy 起動より前。env 不正値で fail-fast したい。

## 6. TDD のテスト設計

### 配置

`skills/cmux-team/manager/main.test.ts` に `describe("resolveTokenPoolEnabled (T322)", ...)` を追加する。
理由: 既存の `resolveAutoUpdateMode` テストが同ファイルに既にある（main.test.ts:285 周辺）ので、
**新ファイルを増やさない** ほうが pattern が揃う。新規ファイル化はしない（決定 D4）。

`isTokenPoolEnabled`（async wrapper）も同 describe 内で `mkdtempSync` + `HOME` 上書き or `__loadGlobalConfigFromPathForTest` 注入で 1 ケースだけ smoke test する。

### test cases

純粋関数 `resolveTokenPoolEnabled(projectConfig, globalConfig, env)`:

| # | env | project.tokenPool.enabled | global.tokenPool.enabled | 期待 enabled | source |
|---|---|---|---|---|---|
| 1 | `CMUX_TEAM_TOKEN_POOL=0` | true | true | false | env |
| 2 | `CMUX_TEAM_TOKEN_POOL=false` | true | true | false | env |
| 3 | `CMUX_TEAM_TOKEN_POOL=off` | true | true | false | env |
| 4 | `CMUX_TEAM_TOKEN_POOL=1` | false | false | true | env |
| 5 | `CMUX_TEAM_TOKEN_POOL=true` | false | false | true | env |
| 6 | `CMUX_TEAM_TOKEN_POOL=on` | false | false | true | env |
| 7 | undefined | false | true | false | project |
| 8 | undefined | true | false | true | project |
| 9 | `""` (空文字) | false | true | false | project |
| 10 | undefined | undefined | true | true | global |
| 11 | undefined | undefined | false | false | global |
| 12 | undefined | undefined | undefined | false | default |
| 13 | undefined | (project=null) | (global=null) | false | default |
| 14 | `CMUX_TEAM_TOKEN_POOL=yes` | * | * | throw | — |
| 15 | `CMUX_TEAM_TOKEN_POOL=2` | * | * | throw | — |

検証要件 4 ケース（タスク本文 §検証）に対応:
- 「CMUX_TEAM_TOKEN_POOL=0 で無効」 ⇒ #1
- 「project enabled:false で無効」 ⇒ #7
- 「global enabled:true + 他なし で有効」 ⇒ #10
- 「未設定で無効（opt-in）」 ⇒ #12

`isTokenPoolEnabled(projectRoot)` smoke test 1 ケース:

- mkdtempSync で project root を作り、`.team/config.json` に `{"tokenPool":{"enabled":true}}` を書く
- `loadGlobalConfig` を test では in-memory に差し替える（`__setGlobalConfigPathForTest` を用意するか、`process.env.HOME` を tmpdir に上書き）
- `(await isTokenPoolEnabled(root)).enabled === true` を確認

### env 不正値の cmdStart fail-fast 確認

`main.test.ts` に既存の `resolveAutoUpdateMode` throw ケース（main.test.ts:290 等）と同じ形で書ける。

## 7. 設計判断ポイント

### D1. yaml ライブラリの選定

候補:
- (a) `yaml`（eemeli/yaml）— pure JS、type 定義あり、weekly downloads 多数。CommonJS / ESM 両対応。
- (b) `js-yaml`（nodeca）— 古参、安定だが ESM 周りで型がやや古い。
- (c) 自作の極小 parser（`token_pool:\n  enabled: true` のみ受ける）— 依存ゼロだが拡張性なし。

**採用: (a) `yaml`。** 理由:
1. 将来的に global config に他フィールド（plan 設定や notify 設定）を足す可能性が高く、自作パーサで縛ると後で結局置換になる。
2. ESM サポートが綺麗。bun ランタイムでも問題ない。
3. CLAUDE.md「必要な抽象化を積極的に導入」原則に整合。`@opencode-ai/sdk` を既に依存に持つので 1 個増えても問題なし。

`bun add yaml` を skills/cmux-team/manager/ で実行。

### D2. env 空文字の挙動

タスク本文には「`""` を false」とあるが、既存の `resolveAutoUpdateMode` / `resolveFetchBeforeWorktree` は **空文字＝未指定（fallback）**。
ここで「空文字＝false」を採用すると挙動が一貫しなくなる。

**採用: 空文字は未指定（fallback）。** タスク本文の解釈は誤記とみなして既存パターンに合わせる。
これにより `unset CMUX_TEAM_TOKEN_POOL` と `CMUX_TEAM_TOKEN_POOL=` が同じ意味になる。
**実装後に reviewer / planner にこの差を質問する**（決定の確認）。

### D3. JSON / YAML 上のキー名

- `.team/config.json`（既存 camelCase 流儀）→ `tokenPool` で統一。
- `~/.cmux-team/config.yaml`（yaml 慣習）→ `token_pool` で受ける。読み込み時に内部表現は `tokenPool` に正規化。
- 両方 camelCase で揃える案も検討したが、yaml 文化との衝突が大きい。**採用: 上記の言語別慣習。**

### D4. project と global の評価順

優先順位は **project > global**（タスク本文通り）。理由はリポジトリ単位の判断（CI で OFF 強制したい等）が
ユーザー全体設定より優先されるべきだから。

### D5. 既存 config.ts との統合方針

- `TeamConfig` に `tokenPool?` を追加するだけ。後方互換は完全（既存 config.json はそのまま動く）。
- `GlobalConfig` 型は新規。`config.ts` 内に同居させる（共通の I/O 層）。
- `~/.cmux-team/` ディレクトリは tokens.db で既に存在しうる。yaml 側は read のみで mkdir しない。
- ディレクトリパス resolution は `homedir()`（os パッケージ）を使う。token-store と同じ流儀。

### D6. config.test.ts を新規作成しない

既存の `resolveAutoUpdateMode` 等の config 関連テストが `main.test.ts` に集中しており、
`config.test.ts` は存在しない。本タスクで新規作成する積極理由はないので、main.test.ts に追加する。

## 8. 実装ステップ（TDD 順序）

1. **テスト先行**: `main.test.ts` に `resolveTokenPoolEnabled` の table-driven テスト 15 ケースを追加（赤）。
2. **config.ts 実装**: `TeamConfig.tokenPool` / `GlobalConfig` 型追加、`resolveTokenPoolEnabled` の純粋関数を実装（緑）。
3. **yaml 依存追加**: `cd skills/cmux-team/manager && bun add yaml` を実行、bun.lock を commit。
4. **loadGlobalConfig / isTokenPoolEnabled 実装**: yaml read を含む async 層を追加。
5. **smoke test**: `isTokenPoolEnabled(projectRoot)` の 1 ケース統合テストを main.test.ts に追加（mkdtemp + HOME 上書き）。
6. **main.ts 改修**: `cmdSpawnAgent` の T321 ブロックに enable ガード、`cmdStart` に `token_pool_config` ログ出力を追加。
7. **手動検証**: `CMUX_TEAM_TOKEN_POOL=0 cmux-team start`、`.team/config.json` で OFF、`~/.cmux-team/config.yaml` で ON、未設定の 4 パターンを `manager.log` の `token_pool_config` 行で確認。
8. **lint / typecheck / test**: `bun test` を skills/cmux-team/manager で全実行。
9. **commit**: `feat(token-pool): isTokenPoolEnabled 3-tier resolver (T322)`

## 9. 完了条件（タスク本文 §検証 とのマッピング）

| タスク要件 | 確認方法 |
|---|---|
| `CMUX_TEAM_TOKEN_POOL=0` で無効 | test #1 + 手動 step 7 |
| `.team/config.json: { "tokenPool": { "enabled": false } }` で無効 | test #7 + 手動 step 7 |
| `~/.cmux-team/config.yaml: token_pool: { enabled: true }` + 他なし で有効 | test #10 + 手動 step 7 |
| 未設定で無効（opt-in） | test #12 + 手動 step 7 |
| `cmux-team start` の起動ログに pool 状態 | §5 の `token_pool_config` ログ |
| `cmdSpawnAgent` で OFF 時 selection スキップ | §4 改修 + `token_pool_skipped` ログ |

## 10. 非目的（やらない）

- token-store.ts のロジック変更（selection アルゴリズムは T321 のまま）
- TUI への enable 状態表示（dashboard.tsx は触らない、ログのみ）
- `~/.cmux-team/config.yaml` の他フィールド追加（本タスクは `token_pool` のみ）
- env 値の boolean 後方互換削除（既存 patterns に合わせて全パターン許容）
- proxy.ts / token-cli.ts の挙動変更（pool が OFF でも token CLI 自体は機能する）
