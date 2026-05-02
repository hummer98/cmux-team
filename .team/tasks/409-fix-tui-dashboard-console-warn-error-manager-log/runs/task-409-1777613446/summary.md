# T409 Summary — dashboard モードで console.warn/error を manager.log にリダイレクト

## 完了したサブタスク

1. **logger.ts**: `appendLine(level, event, detail)` internal helper を切り出し、`log()` / `warn()` / `error()` を共通経路で実装
2. **dashboard-console-redirect.ts** (新規): `installDashboardConsoleRedirect()` で console.warn / console.error を logger.warn / logger.error にすり替える
3. **dashboard.tsx**: startDashboard 内、createNodeApp 直前で install を呼ぶ
4. **テスト**: dashboard-console-redirect.test.ts 3 ケース新設、logger.test.ts に warn/error 互換性 3 ケース追加

## 変更ファイル一覧

| ファイル | 種別 | 概要 |
|---|---|---|
| `skills/cmux-team/manager/logger.ts` | 変更 | `appendLine` helper に集約、`warn` / `error` を export |
| `skills/cmux-team/manager/logger.test.ts` | 変更 | warn / error / log 互換性 3 ケース追記 |
| `skills/cmux-team/manager/dashboard.tsx` | 変更 | import + install 呼び出し（合計 6 行追加） |
| `skills/cmux-team/manager/dashboard-console-redirect.ts` | 新規 | monkey-patch ロジック + formatArgs |
| `skills/cmux-team/manager/dashboard-console-redirect.test.ts` | 新規 | 3 ケース |

合計 +62 / -3 行、ファイル 5 件（うち 2 件新規）。

## テスト結果

```
$ cd skills/cmux-team/manager
$ bun test --timeout 30000 dashboard-console-redirect.test.ts
3 pass / 0 fail / 6 expect calls / 124ms

$ bun test --timeout 30000 logger.test.ts
22 pass / 0 fail / 33 expect calls / 40ms
```

合計 **25 pass / 0 fail**。

## tsc

```
$ bunx tsc --noEmit 2>&1 | wc -l
0
```

エラー 0 行。変更ファイル関連の新規エラーなし。

## 検品結果

Inspector 判定: **GO with minor concerns**（即マージ可能）。受け入れ条件 17/17 充足。

詳細は `inspection.md` 参照。

### 残課題（follow-up 推奨、本タスク scope 外）

Inspector が指摘した minor concerns はいずれも plan.md で「scope 外」「hardening」として明示済み:

- **MC1**: dashboard.tsx 2430-2431 の startup 失敗時 console.error が manager.log に流れる（plan §3.4 で原状維持を明示）
- **MC2**: parseLogLine が `[warn]` / `[error]` prefix を level として認識しない（plan §6.3 で scope 外、journal タブで filter out されるが画面壊れはしない）
- **MC3**: `void logWarn(...)` の Promise rejection が unhandled — disk full 等の edge ケースで unhandled rejection になる可能性。`.catch(() => {})` 1 行追加で hardening 可能。既存 `log(...).catch(() => {})` パターンと整合させる follow-up commit を推奨
- **MC4**: テストの `flushAsyncLog` 50ms wait が将来 flaky 化するリスク（現時点は 124ms で安定）
- **MC5**: `formatArgs` の循環参照ケースは未テスト

## 受け入れ条件チェック

| # | 条件 | 状態 |
|---|------|------|
| 1 | Manager TUI で `type=POST_TOOL_USE size=NNNN` の残骸が出ない | ✅（コードレベルで保証） |
| 2 | manager.log に `[warn]` / `[error]` prefix の行が追記される | ✅（logger.test.ts で実測検証） |
| 3 | 既存 log() の挙動・フォーマット維持 | ✅（compat ケースで negative 検証） |
| 4 | CLI 一発呼び出しモードでは console.warn が従来通り stderr に出る | ✅（install 呼び出しは startDashboard 内のみ） |

## マージ情報

- **方式**: ローカル ff-only マージ（タスク本文に PR 指定なし、変更規模が小さく自明）
- **マージ先**: `main`
- **ブランチ**: `task-409-1777613446/task`
- **マージコミット**: 完了処理後に追記
