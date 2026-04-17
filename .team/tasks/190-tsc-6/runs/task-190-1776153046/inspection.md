# T190 Inspection

## 判定: GO

## 検証結果
- tsc: `bunx tsc --noEmit` → exit=0（エラー 0 件）
- test: `bun test` → 211 pass / 0 fail / 423 expect() calls（14.70s, 13 files）
- git diff 範囲: plan.md 通りの 6 ファイル
  - `skills/cmux-team/manager/cmux.ts`（runCmux の destructure + toString）
  - `skills/cmux-team/manager/dashboard.tsx`（`dsVariant: "unstyled"` 2 箇所削除）
  - `skills/cmux-team/manager/main.test.ts`（`m[1]!` non-null 断言）
  - `skills/cmux-team/manager/main.ts`（`state.workspace ?? undefined`）
  - `skills/cmux-team/manager/package.json`（`@types/update-notifier: ^6.0.8` 追加）
  - `skills/cmux-team/manager/bun.lock`（`@types/update-notifier@6.0.8` が optionalDependencies 配下に解決）

## 所見
- 6 件の修正はすべて plan.md の記述と完全一致。余計なリファクタ・副作用変更なし。
- `cmux.ts` の `.toString()` は runtime では string に対する no-op で挙動不変。例外処理（`catch (e: any)`）パスは未変更。
- `dashboard.tsx` の `dsVariant: "unstyled"` 削除は、`@rezi-ui/core` の `WidgetVariant` union に "unstyled" が存在せず、`readWidgetVariant`/`isButtonVariant` 共に undefined/false を返すため runtime 等価。
- `main.test.ts` の `m[1]!` は直前の `if (!m) throw` ガード後なので安全。
- `main.ts` の `state.workspace ?? undefined` は null→undefined の変換のみで、`renameWorkspace(title, workspace?: string)` の optional 引数セマンティクスと一致。
- `@types/update-notifier@6.0.8` は bun.lock に正しく記録され、`@types/configstore`, `boxen@^7.1.1` の推移依存も解決済み。
- 211 test pass は T181（await-agent 方式）統合後の期待値（planned: 211 以上）を満たす。

## Fix Required
（なし）
