# Plan: T126 — spawn-conductor から --surface 引数を削除

## 概要

`spawn-conductor` サブコマンドは T125 で split を除去し、現在の surface で起動するように変更された。
`--surface` 引数は不要となったため削除する。`--direction` は T125 で既に削除済み。

## 変更対象ファイル

### 1. `skills/cmux-team/manager/main.ts`

#### 1a. ヘッダーコメント（L12）

```
-  *   ./main.ts spawn-conductor [--surface <surface>]
+  *   ./main.ts spawn-conductor
```

#### 1b. `cmdSpawnConductor()` 関数（L883-892）

現在:
```ts
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

変更後:
```ts
async function cmdSpawnConductor(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_spawn_conductor"));
  const surface = process.env.CMUX_SURFACE ?? await cmux.getCallerSurface();

  const result = await spawnSingleConductor(PROJECT_ROOT, surface);
  console.log(`SURFACE=${result.surface}`);
}
```

### 2. `skills/cmux-team/manager/i18n.ts`

#### 2a. 英語ヘルプテキスト（L170-178）

```
-cmux-team spawn-conductor -- launch and register a new Conductor
+cmux-team spawn-conductor -- launch and register a Conductor on the current surface

-Usage:
-  cmux-team spawn-conductor [options]
-
-Options:
-  --surface <surface>       target surface to start Conductor on (default: $CMUX_SURFACE or current surface)
+Usage:
+  cmux-team spawn-conductor

+The Conductor is started on the current surface ($CMUX_SURFACE or caller surface).
```

#### 2b. 日本語ヘルプテキスト（L614-622）

```
-cmux-team spawn-conductor -- 新しい Conductor を起動・登録
+cmux-team spawn-conductor -- 現在の surface で Conductor を起動・登録

-Usage:
-  cmux-team spawn-conductor [options]
-
-Options:
-  --surface <surface>       Conductor を起動する対象 surface（デフォルト: $CMUX_SURFACE または現在の surface）
+Usage:
+  cmux-team spawn-conductor

+現在の surface（$CMUX_SURFACE または呼び出し元 surface）で Conductor を起動します。
```

### 3. `skills/cmux-team/manager/conductor.ts`

変更不要。`spawnSingleConductor(projectRoot, surface)` のシグネチャは既に direction/parentSurface なし。

## 完了条件

- `--surface` 引数なしで `cmux-team spawn-conductor` が動作する
- ヘルプテキストに `--surface` オプションが表示されない
- `CMUX_SURFACE` 環境変数または `cmux identify` で surface を自動取得する
