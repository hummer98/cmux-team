# 実装計画: spawn-conductor から split を除去

## 概要

`cmux-team spawn-conductor` が `cmux.newSplit()` で新ペインを作成してから Conductor を起動する現在の挙動を変更し、引数で渡された surface に直接 Conductor を起動するようにする。split が必要なら呼び出し側の責務とする。

## 変更ファイル一覧

### 1. `skills/cmux-team/manager/conductor.ts` — `spawnSingleConductor()` の変更

**対象**: 68〜110行目

**現在のシグネチャ**:
```typescript
export async function spawnSingleConductor(
  projectRoot: string,
  direction: "right" | "down",
  parentSurface?: string,
): Promise<ConductorState>
```

**変更後のシグネチャ**:
```typescript
export async function spawnSingleConductor(
  projectRoot: string,
  surface: string,
): Promise<ConductorState>
```

**変更内容**:
- 引数 `direction` と `parentSurface` を削除し、`surface` を必須引数として追加
- 73行目の `cmux.newSplit(direction, parentSurface ? { surface: parentSurface } : undefined)` 呼び出しを削除
- 以降のロジック（75行目〜109行目）は引数 `surface` をそのまま使用するため、変更不要
  - `getPaneIdForSurface(surface)` — そのまま
  - `CONDUCTOR_REGISTERED` 送信 — そのまま
  - `cmux.send(surface, ...)` — そのまま
  - `cmux.renameTab(surface, ...)` — そのまま
  - return の `ConductorState` — そのまま

### 2. `skills/cmux-team/manager/main.ts` — `cmdSpawnConductor()` の変更

**対象**: 882〜893行目

**現在の実装**:
```typescript
async function cmdSpawnConductor(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_spawn_conductor"));
  const direction = (getArg("direction") ?? "right") as "right" | "down";
  if (direction !== "right" && direction !== "down") {
    console.error("Error: --direction must be 'right' or 'down'");
    process.exit(1);
  }
  const parentSurface = getArg("surface");

  const result = await spawnSingleConductor(PROJECT_ROOT, direction, parentSurface);
  console.log(`SURFACE=${result.surface}`);
}
```

**変更後の実装**:
```typescript
async function cmdSpawnConductor(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_spawn_conductor"));
  let surface = getArg("surface") ?? process.env.CMUX_SURFACE;
  if (!surface) {
    surface = await cmux.getCallerSurface();
  }

  const result = await spawnSingleConductor(PROJECT_ROOT, surface);
  console.log(`SURFACE=${result.surface}`);
}
```

**変更内容**:
- `--direction` 引数の取得とバリデーションを削除
- `--surface` 引数の解決ロジックを変更:
  1. `getArg("surface")` — 明示的に指定された場合
  2. `process.env.CMUX_SURFACE` — 環境変数から取得
  3. `cmux.getCallerSurface()` — `cmux identify` で現在の surface を取得
- `spawnSingleConductor()` の呼び出しを新シグネチャに合わせる

**注意**: `cmux.getCallerSurface()` は既に `cmux.ts:152` に存在し、`main.ts:32` で `import` 済みの `cmux` モジュールから利用可能。追加の import は不要。

### 3. `skills/cmux-team/manager/i18n.ts` — ヘルプテキストの更新

**対象箇所**: 英語（169〜178行目付近）と日本語（591〜600行目付近）の2箇所、および usage 一覧の2箇所

#### 英語ヘルプ（help_spawn_conductor）

**変更前**:
```
cmux-team spawn-conductor -- launch and register a new Conductor

Usage:
  cmux-team spawn-conductor [options]

Options:
  --direction <right|down>  split direction (default: right)
  --surface <surface>       source surface to split from (optional)
```

**変更後**:
```
cmux-team spawn-conductor -- launch and register a new Conductor

Usage:
  cmux-team spawn-conductor [options]

Options:
  --surface <surface>       target surface to start Conductor on
                            (default: $CMUX_SURFACE or current surface)
```

#### 日本語ヘルプ（help_spawn_conductor）

**変更前**:
```
cmux-team spawn-conductor -- 新しい Conductor を起動・登録

Usage:
  cmux-team spawn-conductor [options]

Options:
  --direction <right|down>  split 方向（デフォルト: right）
  --surface <surface>       split 元の surface（任意）
```

**変更後**:
```
cmux-team spawn-conductor -- 新しい Conductor を起動・登録

Usage:
  cmux-team spawn-conductor [options]

Options:
  --surface <surface>       Conductor を起動する対象 surface
                            （デフォルト: $CMUX_SURFACE または現在の surface）
```

#### usage 一覧（英語・日本語）

**変更前**:
```
cmux-team spawn-conductor [--direction <right|down>] [--surface <s>]
```

**変更後**:
```
cmux-team spawn-conductor [--surface <s>]
```

## 変更順序

3つのファイルの変更は互いに依存関係があるため、以下の順序で行う:

1. **conductor.ts** — `spawnSingleConductor()` のシグネチャと実装を変更
2. **main.ts** — `cmdSpawnConductor()` を新シグネチャに合わせて変更
3. **i18n.ts** — ヘルプテキストを更新

ただし、1 と 2 は同時に変更しないとコンパイルが通らない（シグネチャ不一致）ため、実質的には 1→2 をセットで変更し、その後 3 を変更する。

## 影響範囲の確認

### `spawnSingleConductor` の呼び出し元

- `main.ts:891` の `cmdSpawnConductor()` — **変更対象** ✓
- それ以外の呼び出しなし（grep 確認済み）

### `createConductorPanes()` への影響

- `conductor.ts:117` の `createConductorPanes()` は別関数で、`cmux-team start` 時のレイアウト構築に使用
- `spawnSingleConductor()` を呼び出していない → **影響なし**

### daemon からの呼び出し

- daemon（`daemon.ts`）は `spawnSingleConductor` を直接呼び出していない
- Conductor へのタスク割り当ては別のメカニズム（`assignTask` 等）→ **影響なし**

### `cmux.newSplit` の他の利用箇所

- `spawnSingleConductor` 以外にも `newSplit` を使う箇所がある可能性があるが、それらは本変更の対象外

## テスト観点

### 基本動作

1. `cmux-team spawn-conductor --surface surface:XX` で指定した surface に Conductor が起動すること
2. `--surface` 未指定 + `CMUX_SURFACE` 環境変数がある場合、その surface で起動すること
3. `--surface` 未指定 + `CMUX_SURFACE` なしの場合、`cmux identify` で取得した surface で起動すること

### 起動後の確認

4. Conductor が正常に起動すること（`cmux-team conductor <surface>` が実行される）
5. `CONDUCTOR_REGISTERED` メッセージが正しく送信されること
6. タブ名が `[N] ♦ idle` に変更されること
7. `cmux-team status` で新しい Conductor が表示されること

### 非影響の確認

8. `cmux-team start` の通常フロー（`createConductorPanes` 経由）が影響を受けないこと
9. `--direction` 引数を渡した場合に無視される（エラーにはならない — `getArg` は未知の引数を無視する）

### ヘルプ表示

10. `cmux-team spawn-conductor --help` で更新されたヘルプが表示されること
11. `cmux-team --help` の usage 一覧で `--direction` が表示されないこと
