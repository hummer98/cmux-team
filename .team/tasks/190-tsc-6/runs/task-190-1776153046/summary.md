---
task: T190
title: 既知の tsc エラー 6 件を解消
run: task-190-1776153046
result: success
merge_commit: 8f9b956
---

# T190 完了サマリー

## 結果

- `bunx tsc --noEmit` → エラー 0 件（修正前: 6 件）
- `bun test` → 211 pass / 0 fail / 423 expect() calls
- マージコミット: `8f9b956` (main)

## 修正内容

| ファイル | 修正 |
|---------|------|
| `skills/cmux-team/manager/cmux.ts` | `runCmux` で stdout/stderr を destructure し `.toString()` で string に正規化 |
| `skills/cmux-team/manager/daemon.ts` | (変更なし — @types 追加で解決) |
| `skills/cmux-team/manager/dashboard.tsx` | 無効な `dsVariant: "unstyled"` を 2 箇所削除 |
| `skills/cmux-team/manager/main.test.ts` | RegExp match の `m[1]` に non-null 断言 (`m[1]!`) |
| `skills/cmux-team/manager/main.ts` | `state.workspace` を `?? undefined` で null→undefined 変換 |
| `skills/cmux-team/manager/package.json` | devDependencies に `@types/update-notifier: ^6.0.8` 追加 |
| `skills/cmux-team/manager/bun.lock` | `bun install` により自動更新 |

## フェーズ実行

1. **Phase 1 Plan** — Planner が plan.md を作成（181行）
2. **Phase 2 Design Review** — Reviewer が Approved 判定
3. **Phase 3 Impl** — Implementer が plan 通り 6 箇所を修正、tsc/test 一発 pass
4. **Phase 4 Inspection** — Inspector が GO 判定（git diff が plan 範囲内、副作用なし）

## 設計判断

- **大規模フロー適用**: 変更ファイル 5 個（>3）のため CLAUDE.md 判断基準に従い Design Review を挟む大規模フローで実行
- **`dsVariant: "unstyled"` は削除**: `@rezi-ui/core` の `WidgetVariant` union に存在せず、runtime は undefined 扱いのため削除で挙動不変
- **`@types/update-notifier@^6.0.8`**: DefinitelyTyped の最新 major。`update-notifier@7` とメジャーが 1 つずれるが v7 は主に ESM 化が変更点で型 API はほぼ不変、実用上問題なし

## 残件

なし。全て plan 通り、試行錯誤なし。
