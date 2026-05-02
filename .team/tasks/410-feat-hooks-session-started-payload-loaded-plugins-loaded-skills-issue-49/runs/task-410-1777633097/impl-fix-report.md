# T410 Inspector Minor Finding Fix Report

## Fix Summary

`cmdSend` の SESSION_STARTED 分岐で `collectSessionEnrichment` 例外時に warn が二重出力される問題を、internal fallback 判定を `try` ブロック内（catch と排他）へ移動して解消した。

## Diff

`skills/cmux-team/manager/main.ts:1227-1245`

### Before

```ts
if (typeArg === "SESSION_STARTED") {
  try {
    const enrichment = await collectSessionEnrichment();
    loadedPlugins = enrichment.loadedPlugins;
    loadedSkills = enrichment.loadedSkills;
  } catch (e: any) {
    loadedPlugins = null;
    loadedSkills = null;
    // F8: null fallback 件数を運用 telemetry として記録する。
    await warn(
      "session_enrichment_null_fallback",
      `reason=${e?.constructor?.name ?? "Error"} message=${e?.message ?? ""}`,
    );
  }
  // 内部 catch で null fallback になったケースも記録する。
  if (loadedPlugins === null && loadedSkills === null) {
    await warn("session_enrichment_null_fallback", "reason=internal_fallback");
  }
}
```

### After

```ts
if (typeArg === "SESSION_STARTED") {
  try {
    const enrichment = await collectSessionEnrichment();
    loadedPlugins = enrichment.loadedPlugins;
    loadedSkills = enrichment.loadedSkills;
    // 内部 catch で null fallback になったケースも記録する（exception path とは排他）。
    if (loadedPlugins === null && loadedSkills === null) {
      await warn("session_enrichment_null_fallback", "reason=internal_fallback");
    }
  } catch (e: any) {
    loadedPlugins = null;
    loadedSkills = null;
    // F8: null fallback 件数を運用 telemetry として記録する。
    await warn(
      "session_enrichment_null_fallback",
      `reason=${e?.constructor?.name ?? "Error"} message=${e?.message ?? ""}`,
    );
  }
}
```

### 修正の意図

- `collectSessionEnrichment()` 自体は内部で catch して `{ null, null }` を返す best-effort 設計のため、通常は throw しない（=catch ブロックには入らない）
- しかし二重防御の `try/catch` で外側で例外を拾った場合、catch ブロックが `loadedPlugins=null, loadedSkills=null` を設定 → その直後の `if (loadedPlugins === null && loadedSkills === null)` も成立し、同一イベントに対して warn が 2 行記録されてしまう
- `internal_fallback` 判定を `try` ブロックの末尾（成功 path 内）へ移動することで、exception path（catch）と internal fallback path（try 末尾）が構造的に排他になる
- `warnedAlready` のような bool フラグは導入せず、制御フローで排他性を表現したほうが読み手に意図が伝わりやすい

## Verification

実行ディレクトリ: `skills/cmux-team/manager`

### tsc

```bash
$ bunx tsc --noEmit
（出力なし = エラー 0 件）
```

### Tests

```bash
$ bun test --timeout 30000 main.test.ts
 235 pass
 0 fail
 638 expect() calls
Ran 235 tests across 1 file. [21.11s]

$ bun test --timeout 30000 schema.test.ts
 70 pass
 0 fail
 104 expect() calls
Ran 70 tests across 1 file. [40.00ms]

$ bun test --timeout 30000 session-enrichment.test.ts
session-enrichment.test.ts:
[T410-e2e] enrichment latency samples: 526, 419, 642ms, p95=642ms
 11 pass
 0 fail
 18 expect() calls
Ran 11 tests across 1 file. [2.02s]
```

すべて green。
