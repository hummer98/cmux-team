# T175 Inspection Report

## Verdict: GO

## Summary

plan.md のサブタスク 1〜5 は全て実装され、TDD RED→GREEN→VERIFY のサイクルが impl-report.md どおり成立している。実機 E2E (サブタスク 6) は手動検証のため deferred とされており、本検品のスコープ外。型エラー 0、テスト 377 pass / 0 fail、EventBus ポリシー (`bus.emit`/`bus.on` 直接呼び出し禁止) 遵守、command 文字列の Conductor との完全一致も確認した。

## Checks Performed

| 観点 | コマンド | 結果 |
|------|---------|------|
| 変更対象ファイルの存在 | `git diff main --name-only -- '*.ts' '*.tsx'` | `main.ts` / `main.test.ts` / `proxy.ts` / `proxy.test.ts` の 4 ファイル変更あり (plan.md §3.1 と一致) |
| サブタスク 1 完了条件 | `rg -c "notifyStateChanged.*master-state" skills/cmux-team/manager/proxy.ts` | **3** (要件: ≥3 → pass) |
| サブタスク 1 完了条件 | `rg -c 'log\("master_state"' skills/cmux-team/manager/proxy.ts` | **1** (要件: 1 行ヒット → pass) |
| EventBus ポリシー | `rg -n 'bus\.(emit\|on)\b' skills/cmux-team/manager \| rg -v eventBus.ts` | **0 件** (CLAUDE.md 規約遵守) |
| command 文字列の Conductor との一致 | `rg -n 'SESSION_STARTED --from-stdin\|SESSION_ENDED --from-stdin' skills/cmux-team/manager/main.ts` | `generateMasterSettings` (L1378/1410) と `generateConductorSettings` (L1509/1539) の文字列は `CMUX_SURFACE`/`PPID`/`2>/dev/null \|\| true` 含め完全一致 |
| bunx tsc (全体) | `bunx tsc --noEmit --project skills/cmux-team/manager` | **EXIT=0** |
| bunx tsc (touched files 限定) | `bunx tsc ... \| grep -E "^(<touched>)"` | **(no errors)** |
| 未使用 import/ローカル変数 | `bunx tsc --noUnusedLocals --noUnusedParameters` (touched files 限定) | **該当なし** |
| 単体テスト (main + proxy) | `bun test main.test.ts proxy.test.ts` | **125 pass / 0 fail / 316 expect** |
| 回帰テスト (manager 全件) | `bun test` | **377 pass / 0 fail / 815 expect** |
| `resolveCallerSurfaceOrExit` 使用 | `rg 'resolveCallerSurfaceOrExit' skills/cmux-team/manager/main.ts` | Conductor 2 箇所 + Master 1 箇所 (新規) = 3 箇所 (plan.md §4 サブタスク 2 と一致) |

## Findings

1. **[minor] 計画充足**: plan.md サブタスク 2 の完了条件文中に `"cmdLaunchMaster\|spawn-master\|1[67][0-9][0-9]"` の整合確認コマンドが書かれているが、実際の実装位置は L1739 でありこの regex にマッチする。要件は満たされているが、impl-report.md の "main.ts:1736-1748" 表記と plan の行番号ヒント (1710-1745) がわずかに食い違う。コードの正しさには影響しないため minor。

2. **[minor] ドキュメント整合 (impl-report.md)**: impl-report.md 末尾の "補足" で「plan.md §「サブタスク 1」の `eventBus.ts` → `logger.ts` への import が無いことの確認について、実際には `eventBus.ts` は `logger.ts` を import している」と記載されている通り、`eventBus.ts` は `import { log } from "./logger";` を持つ。しかし `logger.ts` 側に `eventBus.ts` への import は無いため循環依存は発生せず、plan の意図 (循環依存なし) は保たれている。ランタイム動作に問題なし。

## Checks by 検品観点

### 1. 計画充足 (Critical)
- サブタスク 1〜5 全て実装済み ✅
- 変更対象 4 ファイル全て変更済み (`git diff main --name-only` で確認) ✅
- `notifyStateChanged()` 使用、`bus.emit` 直接呼び出しゼロ ✅
- command 文字列が Conductor の `generateConductorSettings` と完全一致 ✅

### 2. Dead/Zombie Code (Major)
- 未使用 import / 未使用ローカル変数なし (`tsc --noUnusedLocals --noUnusedParameters` で確認) ✅

### 3. テスト (Critical if 破壊)
- 新規テスト: main.test.ts 4 件 + proxy.test.ts 5 件 = 9 件、全 pass ✅
- 既存テストの回帰なし: 377 pass / 0 fail ✅

### 4. 設計原則 (Major)
- DRY: Master と Conductor の hook 定義で command 文字列が重複しているが、T211 の既存 `generateMasterSettings` / `generateConductorSettings` のパターンを踏襲しており今回のタスクで整理する範囲外 (既存分離方針の尊重)
- EventBus ポリシー遵守 ✅ (`bus.emit`/`bus.on` 直接呼び出しゼロ)
- 不要な複雑さなし ✅

### 5. 統合 (Critical if 未接続)
- `SessionStart` / `SessionEnd` hook は `generateMasterSettings` の返り値に正しく含まれる (test で JSON 構造検証済み) ✅
- `cmdLaunchMaster` での `CMUX_SURFACE` export が Master spawn 前に実行される経路にある (main.ts:1739 で `resolveCallerSurfaceOrExit` → L1747 で env set → L1758 で settings.json 生成 → L1767 で `execFileSync("claude", ...)`) ✅
- `/master-state` ハンドラの `notifyStateChanged` が busy / idle / prompt の 3 branch 全てで呼ばれる (proxy.ts:259-265, テストでも検証済み) ✅

### 6. 型エラーゼロ化 - touched files (Critical)
- touched files (main.ts / main.test.ts / proxy.ts / proxy.test.ts) に tsc エラー 0 件 ✅

## Manual E2E Verification について

plan.md サブタスク 6 は手動 E2E 検証 (`cmux-team stop && cmux-team start` → TUI 目視 → `manager.log` 確認) であり、impl-report.md でも "deferred" と明記されている。これは本 Implementer セッションで実行可能な範囲を超えるため、実機検証はユーザー側で以下のタイミングで実施する想定:

- **リリース前の動作確認** として、本ブランチのマージ後に `npm run release` → `npm install -g @hummer98/cmux-team` → `cmux-team start` で TUI スピナー挙動を目視
- 観察ポイント: Master セクションのスピナー動作、`master_state status=busy`/`idle` ログ、`master_session_started` / `master_session_ended` ログ

このフォローアップは検品対象のコード変更が仕様通りに書かれているかという観点からは **GO 判定を妨げない** (ビルド・単体テスト・構造検証は全て pass)。

## Fix Required

なし (GO 判定のため)。
