# T206 Summary

## 概要

`cmdConductor` / `cmdResume` から `CMUX_SURFACE` 必須を撤廃し、`--surface` を受け取る CLI を UUID / `surface:NNN` ref の両形式に対応。`generateConductorSettings` を共通ファイル `.team/prompts/conductor-settings.json` 1 個に集約。

## フェーズ実行ログ

| Phase | Agent | Verdict |
|-------|-------|---------|
| 1. Plan | planner (surface:180) | plan.md 作成完了 |
| 2. Design Review | design-reviewer (surface:183) | Changes Requested（Critical C1 + Major M1-M7） — 再 plan 不要、Implementer に直接指摘事項を引き継ぎ |
| 3. Implementation | impl (surface:184) | bun test 254 pass / tsc pass |
| 4. Inspection | inspector (surface:186) | **GO** |

## Critical / Major 反映状況

| Item | Status |
|------|--------|
| C1 `cmux --id-format both --json tree` 経路 | ✓ |
| C1 UUID 比較 `toLowerCase()` | ✓ |
| M1 `treeImpl` 型拡張 + テスト mock | ✓ |
| M2 `main.test.ts` の `generateConductorSettings` 4 箇所 | ✓ |
| M3 `cmdSpawnConductor` 触らず | ✓（out-of-scope 遵守） |
| M4 UUID 大文字小文字比較 | ✓ |
| M5 CHANGELOG `## [3.48.0] - 2026-04-15` 直追加 | ✓ |
| M6 `cmdSend` 正規化失敗時の例外処理 | ✓ |
| M7 `--from-stdin` 経路は正規化しない + コメント | ✓ |

## 変更ファイル

- `CHANGELOG.md` — v3.48.0 セクション追加（Breaking soft / Changed / Removed）
- `skills/cmux-team/manager/cmux.ts` — `tree()` opts に `{ json?, idFormat? }` 追加
- `skills/cmux-team/manager/i18n.ts` — `help_conductor` の `CMUX_SURFACE` 説明を ja/en で `optional` に
- `skills/cmux-team/manager/main.test.ts` — `normalizeSurfaceArg` テスト 6 ケース追加 + `generateConductorSettings` 呼び出し 4 箇所修正
- `skills/cmux-team/manager/main.ts` — `normalizeSurfaceArg` / `resolveCallerSurfaceOrExit` 追加、`cmdConductor`/`cmdResume`/`cmdSend`/`cmdSpawnAgent`/`cmdKillAgent`/`cmdSendAgent`/`cmdAwaitAgent` で正規化適用、`generateConductorSettings` シグネチャ変更
- `package-lock.json` — version 行追従（3.46.0 → 3.47.1、機械的更新で害なし）

## テスト結果

- `bun test`: 254 pass / 0 fail (14 files, 500 expects)
- `bun x tsc --noEmit`: pass

## 設計判断

- **Design Review の Verdict が Changes Requested でも再 plan は省略**：Reviewer 自身が「骨格・スコープ・out-of-scope は妥当、再 plan 不要、Implementer に指摘事項を直接渡せばよい」と明記していたため、Phase 1 へ巻き戻さず Phase 3 で C1+M1-M7 を反映する方針で進めた。
- **Critical C1 はタスク本文の方が正しかった**：Planner は `cmux --json tree` を使う想定で書いたが、実際は `cmux --id-format both --json tree` でないと UUID が出力されない。これは Reviewer が実機確認で発見し、Implementer に直接修正方針を引き渡した。
- **`cmdSpawnConductor` の env パターンも触らず**（M3）：scope 外の差分肥大を避けるため Reviewer の判断を採用。

## 自己判断箇所

- Implementer が done マーカーを書かずに idle 状態で停止していたため、Conductor が `read-screen` で完了確認 → `kill-agent` で明示的に終了させた（Phase 1, 3, 4 の各 Agent で同じ対応）。これは done マーカー push を待つ通常フローからの逸脱だが、画面で完了済みかつ `❯` プロンプトに戻っていることを確認しているため安全。

## 懸念・残課題

- `package-lock.json` の version 行（3.46.0 → 3.47.1）は T206 の論理 diff 外。コミット時に分離はせず、コミットメッセージで言及。
- 手動 E2E（`cmux-team conductor` を env なしで叩くなど plan §4.3）は Implementer / Inspector のスコープ外。次回起動時に確認する余地あり。

## 成果

- v3.48.0 として出荷可能な状態（CHANGELOG 追加済み）
- 手動デバッグ時に `cmux-team conductor` / `cmux-team resume` を env 注入なしで起動可能に
- `cmux-team send --surface <UUID>` も動作可能に
- conductor-settings ファイルの冗長性解消（surface 数に依存しない 1 個に集約）
