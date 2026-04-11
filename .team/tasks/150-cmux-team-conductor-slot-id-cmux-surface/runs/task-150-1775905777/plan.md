# 実装計画書: conductor の slot-id 引数廃止・CMUX_SURFACE 統一

## 概要

`cmux-team conductor <slot-id>` の必須引数 `slot-id` を廃止し、既に `export CMUX_SURFACE=${surface}` でシェルに設定済みの環境変数 `CMUX_SURFACE` に統一する。二重経路を排除し、CMUX_SURFACE 未設定時はフォールバックせずエラー停止させる。

## 変更ファイル一覧

| # | ファイル | 変更概要 |
|---|---------|---------|
| 1 | `manager/main.ts` | cmdConductor: 引数取得→環境変数取得、cmdResume: フォールバック→エラー停止、initializeConductor/restartConductor: 引数削除、generateConductorSettings: フォールバック削除 |
| 2 | `manager/conductor.ts` | 3箇所の `cmux-team conductor ${surface}` → `cmux-team conductor` に（引数削除） |
| 3 | `manager/i18n.ts` | ヘルプテキスト(英語・日本語)から slot-id を削除 |

## 変更の順序

依存関係上、以下の順序で変更する:

1. **main.ts の generateConductorSettings** — フォールバック `{CMUX_SURFACE:-unknown}` → `{CMUX_SURFACE}` に変更
2. **main.ts の cmdConductor** — 引数 `args[1]` → `process.env.CMUX_SURFACE` に切り替え
3. **main.ts の cmdResume** — `?? "unknown"` → エラー停止
4. **main.ts の initializeConductor / restartConductor** — 呼び出しコマンドから引数削除
5. **conductor.ts** — 3箇所のコマンド文字列から引数削除
6. **i18n.ts** — ヘルプテキスト更新

## 各変更の詳細

### 1. main.ts — generateConductorSettings (L763-809)

`${CMUX_SURFACE:-unknown}` のフォールバックを削除。CMUX_SURFACE が未設定なら空文字が入るが、呼び出し元（cmdConductor/cmdResume）で事前にバリデーション済みのため問題ない。

**Before (L772):**
```typescript
command: "bash -c 'cmux-team send SESSION_STARTED --conductor-id \"$CONDUCTOR_ID\" --surface \"${CMUX_SURFACE:-unknown}\" --pid \"$PPID\" 2>/dev/null || true'",
```

**After:**
```typescript
command: "bash -c 'cmux-team send SESSION_STARTED --conductor-id \"$CONDUCTOR_ID\" --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" 2>/dev/null || true'",
```

同様に L782, L792, L800 の `${CMUX_SURFACE:-unknown}` → `${CMUX_SURFACE}` に変更（計4箇所）。

### 2. main.ts — cmdConductor (L816-847)

引数から slot-id を取得する代わりに CMUX_SURFACE 環境変数を使用する。

**Before (L813-822, L830, L847):**
```typescript
/**
 * cmux-team conductor <slot-id>
 * Conductor 用 Claude Code ラッパー。proxy ポートを動的に解決して claude を exec する。
 */
async function cmdConductor(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_conductor", { model: DEFAULT_MODEL }));
  const slotId = args[1];
  if (!slotId) {
    console.error("Usage: cmux-team conductor <slot-id>");
    process.exit(1);
  }

  // ...
  process.env.CONDUCTOR_ID = slotId;
  // ...
  const conductorSettingsPath = generateConductorSettings(PROJECT_ROOT, slotId);
```

**After:**
```typescript
/**
 * cmux-team conductor
 * Conductor 用 Claude Code ラッパー。proxy ポートを動的に解決して claude を exec する。
 * CMUX_SURFACE 環境変数が必須。
 */
async function cmdConductor(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_conductor", { model: DEFAULT_MODEL }));
  const surface = process.env.CMUX_SURFACE;
  if (!surface) {
    console.error("Error: CMUX_SURFACE environment variable is required");
    process.exit(1);
  }

  // ...
  process.env.CONDUCTOR_ID = surface;
  // ...
  const conductorSettingsPath = generateConductorSettings(PROJECT_ROOT, surface);
```

### 3. main.ts — generateConductorSettings 関数シグネチャ (L763)

変数名の意図を明確にする。

**Before:**
```typescript
function generateConductorSettings(projectRoot: string, slotId: string): string {
  const conductorSettingsPath = join(projectRoot, `.team/prompts/${slotId}-settings.json`);
```

**After:**
```typescript
function generateConductorSettings(projectRoot: string, surface: string): string {
  const conductorSettingsPath = join(projectRoot, `.team/prompts/${surface}-settings.json`);
```

### 4. main.ts — cmdResume (L927)

`?? "unknown"` フォールバックをエラー停止に変更する。

**Before (L914, L927-928):**
```typescript
  process.env.CONDUCTOR_ID = process.env.CMUX_SURFACE ?? "";
  // ...
  const slotId = process.env.CMUX_SURFACE ?? "unknown";
  const conductorSettingsPath = generateConductorSettings(PROJECT_ROOT, slotId);
```

**After:**
```typescript
  const surface = process.env.CMUX_SURFACE;
  if (!surface) {
    console.error("Error: CMUX_SURFACE environment variable is required");
    process.exit(1);
  }
  process.env.CONDUCTOR_ID = surface;
  // ...
  const conductorSettingsPath = generateConductorSettings(PROJECT_ROOT, surface);
```

### 5. main.ts — initializeConductor (L1564-1568)

slotId 中間変数を削除し、コマンド引数から slot-id を削除する。

**Before:**
```typescript
  const slotId = conductor.surface.replace("surface:", "");
  const newSessionId = crypto.randomUUID();
  await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface}\n`);
  await sleep(500);
  await cmux.send(conductor.surface, `cmux-team conductor ${slotId} --session-id ${newSessionId}\n`);
```

**After:**
```typescript
  const newSessionId = crypto.randomUUID();
  await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface}\n`);
  await sleep(500);
  await cmux.send(conductor.surface, `cmux-team conductor --session-id ${newSessionId}\n`);
```

### 6. main.ts — restartConductor (L1650-1654)

initializeConductor と同じ変更。

**Before:**
```typescript
  const slotId = conductor.surface.replace("surface:", "");
  const newSessionId = crypto.randomUUID();
  await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface}\n`);
  await sleep(500);
  await cmux.send(conductor.surface, `cmux-team conductor ${slotId} --session-id ${newSessionId}\n`);
```

**After:**
```typescript
  const newSessionId = crypto.randomUUID();
  await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface}\n`);
  await sleep(500);
  await cmux.send(conductor.surface, `cmux-team conductor --session-id ${newSessionId}\n`);
```

### 7. conductor.ts — createConductorPanes 内 (L99)

**Before:**
```typescript
  await cmux.send(surface, `cmux-team conductor ${surface} --session-id ${sessionId}\n`);
```

**After:**
```typescript
  await cmux.send(surface, `cmux-team conductor --session-id ${sessionId}\n`);
```

### 8. conductor.ts — initializeConductorSlot 内 (L175)

**Before:**
```typescript
  await cmux.send(surface, `cmux-team conductor ${surface} --session-id ${sessionId}\n`);
```

**After:**
```typescript
  await cmux.send(surface, `cmux-team conductor --session-id ${sessionId}\n`);
```

### 9. conductor.ts — spawnConductor 内 (L581)

**Before:**
```typescript
    await cmux.send(surface, `cmux-team conductor ${surface}\n`);
```

**After:**
```typescript
    await cmux.send(surface, `cmux-team conductor\n`);
```

### 10. i18n.ts — 英語ヘルプ

**help_conductor (L388-391):**

Before:
```
  cmux-team conductor <slot-id> [--model <model>]

Arguments:
  <slot-id>     Conductor slot ID (required)
```

After:
```
  cmux-team conductor [--model <model>]

Environment:
  CMUX_SURFACE  Conductor surface ID (required, set by daemon)
```

**help_overview 内 (L470):**

Before:
```
  cmux-team conductor <slot-id>                launch Conductor (auto-resolves proxy)
```

After:
```
  cmux-team conductor                          launch Conductor (auto-resolves proxy)
```

### 11. i18n.ts — 日本語ヘルプ

**help_conductor (L842-845):**

Before:
```
  cmux-team conductor <slot-id> [--model <model>]

Arguments:
  <slot-id>     Conductor のスロット ID（必須）
```

After:
```
  cmux-team conductor [--model <model>]

Environment:
  CMUX_SURFACE  Conductor の surface ID（必須、daemon が設定）
```

**help_overview 内 (L924):**

Before:
```
  cmux-team conductor <slot-id>                Conductor 起動（proxy 自動解決）
```

After:
```
  cmux-team conductor                          Conductor 起動（proxy 自動解決）
```

## テスト・検証方法

1. **構文チェック**: `bun build` でコンパイルエラーがないことを確認
2. **E2E テスト**: `cmux-team start` でチーム起動し、以下を確認:
   - Conductor 3台が正常に起動すること（`cmux-team status` で確認）
   - タスク割り当て・実行・完了が正常に動作すること
   - `abort-task` / `restart-task` 後の Conductor 再起動が正常に動作すること
3. **エラーケース確認**: CMUX_SURFACE なしで `cmux-team conductor` を直接実行した場合にエラー終了すること

## リスクと注意点

1. **後方互換性**: `cmux-team conductor <slot-id>` として直接呼び出すスクリプトが外部に存在する場合は壊れる。ただし内部コマンド（`Internal command`）であり、全呼び出し元は本リポジトリ内で完結しているため問題ない。
2. **`args[1]` の扱い**: cmdConductor で `args[1]` を参照しなくなるが、`args` 配列自体は他の引数（`--model`, `--session-id` 等）で引き続き使用される。引数パース (`getArg()`) はフラグベースのため、位置引数が消えても影響なし。
3. **settings ファイル名**: `generateConductorSettings` のファイル名が `${slotId}-settings.json` から `${surface}-settings.json` に変わるが、surface 値は以前の slotId と同じ値（例: `surface:xxx`）なのでファイル名は変わらない。
4. **cmdResume の早期 exit**: CMUX_SURFACE チェックを cmdResume の冒頭（タスク情報取得前）に移動することで、不要な処理を回避できる。
