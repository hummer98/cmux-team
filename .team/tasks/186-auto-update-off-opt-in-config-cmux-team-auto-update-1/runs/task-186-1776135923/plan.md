# T186 実装計画: auto-update をデフォルト OFF + opt-in 化

## 目的

cmux-team の npm auto-update をデフォルト無効化し、以下いずれかで明示的に opt-in する形に変更する。

- 環境変数 `CMUX_TEAM_AUTO_UPDATE=1`（または `true`）
- `.team/config.json` の `"autoUpdate": true`

優先順位: **env > config > default(OFF)**

恒久対策（複数 Node 環境でのバージョン不整合対応）は別タスク。本タスクはブロッカー解消のためデフォルト OFF の導入のみ。

## 現状調査結果

### ファイル構成

- **TeamConfig は `main.ts` の TS interface（Zod ではない）** — `skills/cmux-team/manager/main.ts:89-99`
  - タスク指示では「schema.ts の Zod スキーマに追加」とあるが、現状 `.team/config.json` は Zod スキーマで validate されておらず、`main.ts` 内の `interface TeamConfig` で型付けしているだけ。既存 `layout?: LayoutMode`, `sleepPrevention?: boolean` と同じ位置に追加するのが一貫性の観点で自然。
  - **提案**: `main.ts` の `interface TeamConfig` に `autoUpdate?: boolean` を追加する（schema.ts には Zod 定義自体がないため変更不要）。このズレは Planner として指摘しておく。
- `loadConfig()` in `main.ts:101-108` — JSON.parse で読み込むだけ、スキーマ検証なし
- `resolveLayout()` in `main.ts:115-124` — CLI > config > default の優先順位解決関数（手本となるパターン）
- `cmdStart()` 内の呼び出し: `main.ts:222` で `startConfig = await loadConfig()` 取得

### npm チェックのループ（変更箇所）

- `main.ts:572` `const NPM_CHECK_INTERVAL = 300_000`
- `main.ts:588-595` 5分間隔 + 全 Conductor idle 時のみ `checkNpmUpdate()` 呼び出し
- `daemon.ts:1304` `export async function checkNpmUpdate(state)` — **本体変更しない**

### ログ

- `daemon_started` ログ: `main.ts:252-255`（`pid`, `poll`, `max_conductors`, `layout`, `sleep_prevention` を含む）
- `auto_update_config` ログを **この直後（line 255 の直後 = line 256 付近）** に追加する

### Grep 結果

- `autoUpdate` 既存コード: なし（新規追加）
- `CMUX_TEAM_AUTO_UPDATE` 既存参照: なし（新規追加）
- README.md / README.ja.md の `## インストール` セクション（`README.ja.md:32`, `README.md:32`）直後が追記先候補

## 変更対象ファイル一覧

| # | ファイル | 行番号付近 | 変更内容 |
|---|---------|----------|---------|
| 1 | `skills/cmux-team/manager/main.ts` | 98 付近 | `interface TeamConfig` に `autoUpdate?: boolean` 追加 |
| 2 | `skills/cmux-team/manager/main.ts` | 124 直後 | `resolveAutoUpdateEnabled()` 関数を追加 |
| 3 | `skills/cmux-team/manager/main.ts` | 230-255 付近 | cmdStart 内で auto-update 有効/無効を解決・ログ出力 |
| 4 | `skills/cmux-team/manager/main.ts` | 588-595 | npm チェック分岐手前で enabled 判定を追加 |
| 5 | `skills/cmux-team/manager/schema.ts` | — | **変更なし**（Zod 定義が存在しないため） |
| 6 | `CLAUDE.md` | 既知の注意点セクション（555 付近） | auto-update の opt-in 方法を追記 |
| 7 | `README.ja.md` | インストールセクション（32-38） | 「auto-update はデフォルト OFF」注記と opt-in 方法を追記 |
| 8 | `README.md` | Installation セクション（32-38） | 同上（英語） |

## 各ファイルの具体変更内容

### 1. `main.ts` — TeamConfig interface 拡張

```ts
interface TeamConfig {
  models?: { master?: string; conductor?: string; agent?: string; };
  envrcHookPromptSkipped?: boolean;
  layout?: LayoutMode;
  sleepPrevention?: boolean;
  /** npm auto-update を有効化する（デフォルト: false）。env CMUX_TEAM_AUTO_UPDATE が優先 */
  autoUpdate?: boolean;
}
```

### 2. `main.ts` — `resolveAutoUpdateEnabled()` 関数追加

配置先: `resolveLayout()` の直後（line 124 直後）。同一パターンに揃える。

```ts
/**
 * npm auto-update の有効/無効を解決する。
 * 優先順位: env CMUX_TEAM_AUTO_UPDATE > config.autoUpdate > false
 * env 値の真偽判定: "1" | "true" のみ ON、それ以外（"0", "", "false", 未定義）は OFF。
 */
export function resolveAutoUpdateEnabled(
  config: Pick<TeamConfig, "autoUpdate">,
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; source: "env" | "config" | "default" } {
  const raw = env.CMUX_TEAM_AUTO_UPDATE;
  if (raw !== undefined && raw !== "") {
    return { enabled: raw === "1" || raw === "true", source: "env" };
  }
  if (config.autoUpdate !== undefined) {
    return { enabled: config.autoUpdate === true, source: "config" };
  }
  return { enabled: false, source: "default" };
}
```

**env 真偽判定の詳細ルール**:
- `"1"` → ON
- `"true"` → ON
- `"0"`, `""`, `"false"`, `"TRUE"`, `"yes"` 等 → OFF
- 未設定（`undefined`） → config にフォールバック
- **空文字 `""` は「未設定」と同義とみなし config にフォールバック**（一般的な unset 慣例に合わせる）

### 3. `main.ts` — cmdStart 内での解決とログ

`startConfig = await loadConfig()`（line 222）の直後、layout 解決ブロックと並列に追加:

```ts
// auto-update 有効/無効（CLI なし: env > config > false）
const autoUpdate = resolveAutoUpdateEnabled(startConfig);
```

ログ出力は `daemon_started`（line 252-255）の**直後**に配置:

```ts
await log(
  "daemon_started",
  `pid=${process.pid} poll=${state.pollInterval}ms max_conductors=${state.maxConductors} layout=${state.layout} sleep_prevention=${sleepPrevention}`
);
await log(
  "auto_update_config",
  `enabled=${autoUpdate.enabled} source=${autoUpdate.source}`
);
```

**理由**: `daemon_started` は現状の「boot 時設定まとめログ」。auto_update も同列の設定情報なので直後が自然。一方で `daemon_started` 行に相乗りさせると行が肥大化しパース性が落ちるため**別行**で出す。

**スコープ注意**: `autoUpdate` は cmdStart ローカルスコープ。メインループ内でも参照するため、クロージャで `while` ループへ引き継がれる。

### 4. `main.ts` — メインループの npm チェック分岐

既存（588-595）:

```ts
if (Date.now() - state.lastNpmCheckAt >= NPM_CHECK_INTERVAL) {
  const allIdle = [...state.conductors.values()].every(c => c.status === "idle");
  if (allIdle) {
    state.lastNpmCheckAt = Date.now();
    await checkNpmUpdate(state);
  }
}
```

変更後:

```ts
// npm auto-update は opt-in（env CMUX_TEAM_AUTO_UPDATE=1 or config.autoUpdate=true）
if (autoUpdate.enabled && Date.now() - state.lastNpmCheckAt >= NPM_CHECK_INTERVAL) {
  const allIdle = [...state.conductors.values()].every(c => c.status === "idle");
  if (allIdle) {
    state.lastNpmCheckAt = Date.now();
    await checkNpmUpdate(state);
  }
}
```

**既存 `checkNpmUpdate()` 関数本体は変更しない**（タスク制約）。呼び出し側ガードのみ。

### 5. `schema.ts` — 変更なし

`.team/config.json` の Zod スキーマは**存在しない**。`main.ts` の TS interface で型定義しているのみ。タスク指示と実装の乖離を Conductor/Implementer に伝達する（plan.md にて明示）。

### 6. `CLAUDE.md` — 追記箇所

`## 既知の注意点` セクション内、`### API レート制限`（line 579 付近）の後に新サブセクションとして追加:

```markdown
### npm auto-update（デフォルト OFF）

v3.x 以降、daemon 稼働中の npm 自動更新はデフォルトで無効。有効化するには以下のいずれか:

- 環境変数 `CMUX_TEAM_AUTO_UPDATE=1` を設定して `cmux-team start`
- `.team/config.json` に `{ "autoUpdate": true }` を追加

優先順位: env > config > default(OFF)。無効時は `checkNpmUpdate()` が呼ばれず、
npm registry への問い合わせ自体が発生しない。起動時に `auto_update_config` ログで
`enabled` / `source` を確認可能。
```

### 7. `README.ja.md` — 追記箇所

`## インストール` セクション（line 32）の直後、`## 使い方` の前に以下を追加:

```markdown
### npm auto-update について

daemon 稼働中の npm 自動更新はデフォルト **OFF** です。有効化したい場合:

- 環境変数: `CMUX_TEAM_AUTO_UPDATE=1 cmux-team start`
- または `.team/config.json` に `{ "autoUpdate": true }` を追加

複数 Node 環境（Volta / nvm / Homebrew など）が混在している場合、
自動更新が意図しないバージョンを上書きする問題が報告されているため、
デフォルトは OFF としています。
```

### 8. `README.md` — 追記箇所（英語版）

`## Installation` 直後に同等内容の英訳を追加。

## `resolveAutoUpdateEnabled()` の配置先決定

**結論: `main.ts` に配置する**。

理由:
- `resolveLayout()` が `main.ts` にあり、同じ「CLI/env/config > default」系の解決関数として隣接させるのが自然
- config（TeamConfig）の型定義自体が `main.ts` にある
- daemon.ts に置くと `TeamConfig` を import する必要があり、依存方向が逆転する
- `autoUpdate` は daemon state ではなく「起動時に解決する設定値」なので main.ts のスコープが適切

## ログ出力タイミング

- **イベント名**: `auto_update_config`
- **フォーマット**: `enabled=<true|false> source=<env|config|default>`
- **タイミング**: `daemon_started` ログの**直後**（line 255 直後）
- **1回のみ出力**（起動時のみ。ループ内で毎回出すのは過剰 → 禁止事項に抵触）

## テスト手順（手動確認）

### 前提

- ビルド不要（Bun 直接実行）
- 既存 `.team/config.json` がある場合はバックアップ

### シナリオ

#### S1. デフォルト OFF

```bash
rm -f .team/config.json
unset CMUX_TEAM_AUTO_UPDATE
cmux-team start
# → ログ: auto_update_config enabled=false source=default
# → 5分以上放置しても checkNpmUpdate が呼ばれないこと
# → manager.log に npm_auto_update / npm_update_check_failed が出ないこと
```

#### S2. env で ON

```bash
CMUX_TEAM_AUTO_UPDATE=1 cmux-team start
# → auto_update_config enabled=true source=env
# → 5分後に checkNpmUpdate が走ること（npm_update_check_failed か npm_auto_update のいずれかが出る）
```

```bash
CMUX_TEAM_AUTO_UPDATE=true cmux-team start
# → enabled=true source=env
```

#### S3. env で OFF（明示）

```bash
CMUX_TEAM_AUTO_UPDATE=0 cmux-team start
# → enabled=false source=env
```

```bash
CMUX_TEAM_AUTO_UPDATE=false cmux-team start
# → enabled=false source=env
```

#### S4. config で ON

```bash
echo '{"autoUpdate": true}' > .team/config.json
unset CMUX_TEAM_AUTO_UPDATE
cmux-team start
# → enabled=true source=config
```

#### S5. env が config を上書き

```bash
echo '{"autoUpdate": true}' > .team/config.json
CMUX_TEAM_AUTO_UPDATE=0 cmux-team start
# → enabled=false source=env （env 優先）
```

#### S6. 空文字の env は無視

```bash
echo '{"autoUpdate": true}' > .team/config.json
CMUX_TEAM_AUTO_UPDATE="" cmux-team start
# → enabled=true source=config （空文字は未設定扱い）
```

### 確認コマンド

```bash
tail -f .team/logs/manager.log | grep -E "auto_update_config|npm_auto_update|npm_update_check"
```

### （推奨）ユニットテスト追加

`main.test.ts` に `resolveAutoUpdateEnabled` のテストを追加する。既存 `resolveLayout` テストと同パターンで作成可能。Implementer に委ねる（本 plan のスコープは設計のみ）。

| ケース | 入力 | 期待 |
|-------|------|-----|
| env=1 | `{autoUpdate:true}`, `{CMUX_TEAM_AUTO_UPDATE:"1"}` | `{enabled:true, source:"env"}` |
| env=true | `{}`, `{CMUX_TEAM_AUTO_UPDATE:"true"}` | `{enabled:true, source:"env"}` |
| env=0 | `{autoUpdate:true}`, `{CMUX_TEAM_AUTO_UPDATE:"0"}` | `{enabled:false, source:"env"}` |
| env=false | `{}`, `{CMUX_TEAM_AUTO_UPDATE:"false"}` | `{enabled:false, source:"env"}` |
| env 未設定 + config=true | `{autoUpdate:true}`, `{}` | `{enabled:true, source:"config"}` |
| env 未設定 + config=false | `{autoUpdate:false}`, `{}` | `{enabled:false, source:"config"}` |
| env 空文字 + config=true | `{autoUpdate:true}`, `{CMUX_TEAM_AUTO_UPDATE:""}` | `{enabled:true, source:"config"}` |
| env 未設定 + config 未設定 | `{}`, `{}` | `{enabled:false, source:"default"}` |

## リスク・懸念事項

### 低リスク

1. **既存ユーザーの挙動変更**: これまで暗黙に auto-update が走っていたユーザーは明示的な opt-in が必要になる。README と CHANGELOG に明記すれば受容可能。
2. **schema.ts 未変更**: タスク指示と実装の乖離。Planner として `main.ts` interface への追加に読み替えた旨を明示済み。Implementer が schema.ts に Zod を新設するのは過剰対応（YAGNI）。

### 中リスク

3. **env 値の真偽判定の歪み**: `"yes"`, `"on"`, `"TRUE"` 等も一般的には truthy とみなされるが、本実装は `"1" | "true"` に限定する（タスク指示通り）。判定が厳しすぎて混乱する可能性。→ ドキュメントに厳密な書式を明記することで緩和。
4. **config 読み込み失敗時のフォールバック**: `loadConfig()` は try/catch で `{}` を返す（現状維持）。破損 JSON でも daemon は起動するが auto-update は OFF になる。意図通り。

### 非リスク（検討の上除外）

5. **ログ肥大化**: `auto_update_config` は起動時 1 回のみ出力。禁止事項「高頻度ループ内の過剰ログ」には抵触しない。
6. **Conductor/Agent への影響**: 本変更は daemon のメインループ内のみで閉じている。Conductor/Agent のライフサイクルには無関係。

## 完了チェックリスト（Implementer 向け）

- [ ] `main.ts` `interface TeamConfig` に `autoUpdate?: boolean` 追加
- [ ] `main.ts` `resolveAutoUpdateEnabled()` 関数を export で追加
- [ ] `main.ts` `cmdStart` 内で解決 + `auto_update_config` ログ出力
- [ ] `main.ts` メインループの npm チェック分岐に `autoUpdate.enabled &&` を追加
- [ ] `main.test.ts` にユニットテスト 8 ケース追加（推奨）
- [ ] `CLAUDE.md` に「npm auto-update（デフォルト OFF）」セクション追記
- [ ] `README.ja.md` に opt-in 手順追記
- [ ] `README.md` に opt-in 手順追記（英語）
- [ ] 手動テスト S1-S6 を実施し manager.log で確認
- [ ] `checkNpmUpdate()` 関数本体は**変更しない**
- [ ] `schema.ts` は**変更しない**
