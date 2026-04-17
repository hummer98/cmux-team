# Inspection Report: T213 config mainBranch

## Verdict
GO

## Summary
plan.md v2（Approved）の全 8 Step が `.worktrees/task-213-1776272738` 上に正しく実装されており、design-review round 2 の指摘 1〜10 はいずれも該当ファイル・行レベルで解消されている。`bun test` は worktree ルートで 15 ファイル 293 pass / 0 fail（新規 `main-branch.test.ts` の 10 ケースを含む）、`bunx tsc --noEmit` も exit 0。template 残骸（ハードコード `main`）の grep は ja/en × conductor-role/task の 4 ファイルで全て 0 件、`{{MAIN_BRANCH}}` 置換と `template.ts` の generator 注入経路も一致している。race 対策は「初期化順序固定（resolveMainBranch → persistMainBranch → log → createDaemon → `state.mainBranch = ...` → initializeConductorSlots）」と「`launchConductor` の `CMUX_TEAM_MAIN_BRANCH` env 注入」の二重防御が実装済みで、`cmdConductor` の env → config → `"main"` 三段フォールバックも `main.ts:1383-1392` で確認できた。commit・merge・worktree 削除は未実施で Conductor 責務の境界も守られている。実装品質は Inspection をパスできるレベル。

## Checklist
| # | 検品観点 | 結果 | 備考 |
|---|---------|------|------|
| 1 | plan.md との整合 | ✓ | Step 1〜8 全て該当ファイルに反映。`Step 6` で示された呼び出し側更新（`conductor.ts`, `daemon.ts`, `main.ts`）は diff で全て確認 |
| 2 | design-review 指摘 1〜10 解消 | ✓ | (1) ja/en L11/L15 の curly brace 注記更新済 / (2) 初期化順序 + env 注入の二重防御 / (3) 04-templates.md L71/L88/L108/L414 個別更新 / (4) conductor.md deprecated 注記 / (5) inspector.md は runtime bash 検出 / (6) cmdResume 非影響 / (7) mainBranch は末尾 optional / (8) `configMainBranch?.trim()` で空文字 fallthrough / (9) `*_failed` 命名 / (10) conductor.test.ts 互換維持（デフォルト引数採用で未変更でも OK） |
| 3 | 確認ポイント 4 つの充足 | ✓ | main 自動検出 (`main-branch.test.ts` origin/HEAD ケース) / develop 手動設定 (`configMainBranch: "develop"` ケース) / origin/HEAD 未設定フォールバック (両方失敗ケース) / 後方互換 (`TeamConfig.mainBranch?: string` + 既存 config 保持テスト) |
| 4 | テンプレート置換網羅 | ✓ | ja/conductor-role.md, en/conductor-role.md, ja/conductor-task.md, en/conductor-task.md の 4 ファイル × 該当箇所を diff で確認。`grep main` の残骸は 0（en/conductor-role.md L15 の `{{MAIN_BRANCH}}` 参照と無関係の `Remaining Issues` のみヒット） |
| 5 | `{{MAIN_BRANCH}}` 置換ロジック | ✓ | `template.ts:73-74`（role）/ `template.ts:113-124`（task）で `.replace(/\{\{MAIN_BRANCH\}\}/g, ...)` が置換チェーンに組み込まれている。`generateConductorTaskPrompt` は `mainBranch ?? "main"` の resolve を置換前に実行 |
| 6 | daemon → Conductor race 対策 | ✓ | `main.ts:360-374` で `resolveMainBranch → persistMainBranch → log("main_branch_resolved") → createDaemon → state.mainBranch = ...` が直列に並んでおり、`conductor.ts:104-113` で `CMUX_TEAM_MAIN_BRANCH` env が `export CMUX_SURFACE=... CMUX_CLAUDE_HOOKS_DISABLED=1 ...` と同じ行で送信される。`cmdConductor` は `main.ts:1383-1392` で env→config→"main" の三段フォールバック |
| 7 | テストカバレッジ | ✓ | `main-branch.test.ts` 10 ケース（config 採用 / 空文字 fallthrough / 空白のみ fallthrough / origin/HEAD 抽出 / 想定外フォーマット / HEAD フォールバック / 両方失敗 / persist 新規作成 / 既存保持 / 壊れた JSON 空書き直し）。既存 `conductor.test.ts` `daemon.test.ts` `template.test.ts` は default 引数 `"main"` により無改変で pass |
| 8 | schema.ts の型安全性 | ✓ | `schema.ts:210-217` に `MainBranchSource` zod enum と `MainBranchResolution` interface を追加。`main.ts:111-115` の `TeamConfig.mainBranch?: string` も optional として追加済 |
| 9 | ロギングの妥当性 | ✓ | `main_branch_resolved branch=<name> source=<config\|detected\|fallback>` (`main.ts:369-371`) / `main_branch_detect_failed step=origin_head\|head stderr=...` (`main-branch.ts:53-66`) / `main_branch_fallback reason=git_detect_failed` (`main-branch.ts:69`) / `main_branch_conductor_fallback reason=env_and_config_missing` (`main.ts:1386-1389`) 全て `*_failed` / 状態変化の命名規則に準拠 |
| 10 | ドキュメント更新 | ✓ | `CLAUDE.md` に Conductor 変数テーブル行追加 + 「プロジェクト設定（.team/config.json）」新セクション（mainBranch 優先順位 env > config > detected > fallback と 3 段解決ロジック）／`docs/spec/04-templates.md` は L70-72（deprecated 注記）/ L90（`{{BASE_BRANCH}}, {{MAIN_BRANCH}}` 追加）/ L110（`{{MAIN_BRANCH}}` 追加）/ L416-417（`{{BASE_BRANCH}}` 説明書き換え + `{{MAIN_BRANCH}}` 行追加）が全て diff で確認 |
| 11 | 後方互換性 | ✓ | `TeamConfig.mainBranch?: string`、`initializeConductorSlots` / `assignTask` / `generateConductorTaskPrompt` はデフォルト `"main"` で既存テスト・未更新呼び出し側に破壊的影響なし。`persistMainBranch` が既存フィールドをマージするので `.team/config.json` の他キーが消えない（テストで保証） |
| 12 | worktree 汚染チェック | ✓ | `git status` は M 13 ファイル + 2 未追跡（`main-branch.ts` / `main-branch.test.ts`）のみ。`git log --oneline -5` で追加コミットなし、merge commit なし、worktree 削除の痕跡なし。Conductor の責務境界を守っている |
| 13 | ビルド・型チェック | ✓ | `bun test` (`skills/cmux-team/manager`): 293 pass / 0 fail / 608 expect / 9.73s / `bunx tsc --noEmit` exit 0 |

## Test Results
- `bun test` (skills/cmux-team/manager, 15 ファイル): **293 pass / 0 fail**（608 expect() / 9.73s）
- `bunx tsc --noEmit` (skills/cmux-team/manager): **exit 0**
- grep 残骸チェック (ja/en × conductor-role/task で `main` 検索):
  - ja/conductor-role.md: 0 hit
  - en/conductor-role.md: 2 hit（L15 の `{{MAIN_BRANCH}}` 参照 / L423 の `Remaining Issues` — いずれも無関係）
  - ja/conductor-task.md: 0 hit
  - en/conductor-task.md: 0 hit
- ログ grep (`main_branch_resolved|main_branch_fallback|main_branch_detect_failed|main_branch_conductor_fallback`):
  - `main.ts:370` (resolved) / `main.ts:1387` (conductor_fallback) / `main-branch.ts:54, 64` (detect_failed) / `main-branch.ts:69` (fallback) 全経路確認
- env 注入 grep (`CMUX_TEAM_MAIN_BRANCH`):
  - `conductor.ts:107, 112` (export 行) / `main.ts:1379, 1383` (env 読み取り) 両方向確認

## Fix Required（NOGO の場合のみ）
該当なし。

## Notes
- **ベルト&サスペンダーの堅牢性**: `launchConductor` で `const mainBranchEnv = (opts?.mainBranch ?? "main").trim() || "main";` と念のための trim + empty fallback が入っており、design-review New Findings N3（シェルエスケープ未考慮）の部分的緩和にもなっている。完全な branch 名 validation（`/^[A-Za-z0-9_\-./]+$/`）は未実装だが、git の branch 名仕様上、空白・メタ文字を含む値が `resolveMainBranch` から返ることは想定しにくいため blocking ではない。将来の強化候補として別タスク化可能。
- **`persistMainBranch` の壊れた JSON ハンドリング**: `catch {}` が一見ロギングポリシー違反に見えるが、「壊れた JSON → 空オブジェクトで上書き」は存在チェック的な idempotent 後処理に相当し CLAUDE.md の許容例外（存在チェック的操作）に合致。テスト `persistMainBranch: 壊れた JSON なら空オブジェクトから書き直す` で挙動が担保されているので問題なし。
- **`conductor.md`（旧版）の扱い**: `docs/spec/04-templates.md` L70-72 で "deprecated" 明記のみ。ファイル本体の `main` 文字列は残っているが、plan §2.3 の判断（template.ts 非参照・実害ゼロ・将来完全削除候補）と一致しており design-review でも Approved 判断なのでスコープ外で正しい。
- **手動 E2E 未実施の申し送り**: plan §7 に列挙された E2E テスト（clean start で mainBranch=main 書き込み / develop 手動設定 / git remote remove origin の fallback）と、design-review New Findings N5 の `"mainBranch": ""` 空文字ケースは Inspector の責務範囲外（コード変更禁止）なので未実施。ユニットテスト `main-branch.test.ts` が相当するケースを DI でカバーしているため integration 層での抜けは限定的だが、Conductor がマージ先として `develop` を実際に使う end-to-end の検証は上位層（Master / ユーザー）で実施することを推奨する。
