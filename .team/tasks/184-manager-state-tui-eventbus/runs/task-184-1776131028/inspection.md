# T184 Inspection Report

## Verdict: GO

## 検品結果サマリ

- ファイル存在: OK
- API 設計: OK
- grep 検証: OK
- plan R1 対応: OK
- 型チェック: OK（ベースライン 5 件のみ、新規エラーなし）
- テスト: OK（179 pass / 0 fail）
- dashboard cleanup: OK
- Event Catalog: OK

## 詳細

### 1. ファイル存在（OK）

- `skills/cmux-team/manager/eventBus.ts` ✅
- `skills/cmux-team/manager/eventBus.test.ts` ✅
- `skills/cmux-team/manager/eventBus.trace.test.ts` ✅
- `docs/spec/05-install-and-infrastructure.md` に `### Event Catalog（eventBus.ts）` ✅
- `CLAUDE.md` に `## EventBus ポリシー` ✅

### 2. API 設計（OK）

`eventBus.ts` を確認:
- `bus` は module-private（export されていない）
- `notifyStateChanged(source: string): void` export ✅
- `onStateChanged(cb): () => void` export（unsubscribe を返却）✅
- `__resetBusForTest` / `__listenerCountForTest` 提供 ✅
- `CMUX_TEAM_TRACE_EVENTS` は module load 時に 1 回評価 ✅
- logger 呼び出しは fire-and-forget（`.catch(() => {})`）✅
- `logger.ts` が `eventBus.ts` を import していないこと確認済み（循環依存なし）

### 3. grep 検証（OK）

- `rg 'notifyStateChanged\(' skills/cmux-team/manager/`: conductor.ts 2 箇所 + daemon.ts 21 箇所 + eventBus.ts（定義）。全て実 state mutation 直後の配置
- `rg "bus\.(emit|on)\b" skills/cmux-team/manager/ | rg -v eventBus.ts`: **0 件**

### 4. plan R1 対応（OK）

conductor.ts の notify 挿入点を確認:
- L484: `assignTask` の `status="running"` 代入直後 ✅
- L575: `resetConductor` の `status="idle"` + フィールドクリア完了直後 ✅
- plan で除外指示された L353/L395/L423/L442/L559 相当箇所に `notifyStateChanged` 呼び出しなし ✅

### 5. 型チェック（OK）

`bun run tsc --noEmit` の結果、既存ベースライン 5 件のみ:
```
cmux.ts(22,5): TS2322 (Bun Node ExecFile types)
dashboard.tsx(373,5): TS2322 WidgetVariant "unstyled"
dashboard.tsx(954,11): TS2322 WidgetVariant "unstyled"
main.test.ts(82,3): TS2322 string | undefined
main.ts(447,42): TS2345 string | null
```
本タスクで追加されたファイル（eventBus.ts, eventBus.test.ts, eventBus.trace.test.ts）および変更箇所由来の新規エラーなし。

### 6. テスト（OK）

```
bun test
 179 pass
 0 fail
 383 expect() calls
Ran 179 tests across 13 files.
```
eventBus.test.ts / eventBus.trace.test.ts を含め全て緑。

### 7. dashboard cleanup（OK）

- L19: `import { onStateChanged } from "./eventBus"` ✅
- L829: module-level `eventBusUnsubscribe` 変数 ✅
- L1319-1324: 再 mount 時は旧 unsubscribe 呼んでから新規登録 ✅
- L1329-1339: `cleanup()` 内で unsubscribe 呼び出し（listener leak 防止）✅

### 8. Event Catalog（OK）

`docs/spec/05-install-and-infrastructure.md` L238-253 に表形式で event / payload / emitter / subscriber 記述済み。追跡性ガイドライン・logger 循環依存禁止も含まれている。

## Minor 改善提案（GO のため必須ではない）

1. Event Catalog の emitter 行番号は行の追加・削除で陳腐化しやすい。将来的には行番号ではなく関数名ベースのリファレンスに置き換える（e.g. `conductor.ts#assignTask, resetConductor`）と保守性が上がる。
2. `eventBus.trace.test.ts` は module load 時評価の TRACE フラグ制約により独立ファイル化されている点は plan §R7 の設計通りだが、テストファイル冒頭にコメントで「本ファイルは他 TRACE 関連テストと混ぜないこと」と注記しておくと新規テスト追加時の事故を防げる。
3. 受け入れ基準の e2e 2 項目（`update-task --status ready` 即時反映 / Conductor `running` 遷移）は実装レポートで「本 worktree では未実施、PR で実施予定」と明記されている。PR 時点では目視確認の完了をコメントで明記することを推奨。

## 結論

plan の受け入れ基準（箇所数 KPI 化しない方針含む）を満たし、Design Review の R1〜R7 全てが実装に反映されている。Blocker・Major 問題なし。**GO**。
