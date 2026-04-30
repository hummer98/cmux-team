# T349 完了サマリー: token add/promote で rateLimitTier 由来 plan 解決失敗時の対話 prompt

## タスク

`cmux-team token add` / `token promote` の登録経路で、`rateLimitTier` から plan が解決できない場合（手動入力経路 / 未知 tier）に登録確定前に plan を対話的に尋ねるプロンプトを追加。`set-plan` での事後訂正の 2 ステップ運用を解消。

## フェーズ実行結果

| フェーズ | 結果 |
|---|---|
| Phase 1: Plan | plan.md (29597 bytes) を planner が作成 |
| Phase 2: Design Review | R1=Changes Requested → R2=Approved |
| Phase 3: Implementation | TDD で実装、`bun test --timeout 30000 token-cli.test.ts` で 37 pass / 0 fail / 4 skip |
| Phase 4: Inspection | GO（Critical/Major 0、Minor 3 件はすべて実害なし） |

## 変更ファイル

- `skills/cmux-team/manager/token-cli.ts` — `PLAN_BY_NAME` / `resolvePlanForRegistration` / `promptManualPlan` helper を追加し、`cmdTokenAdd` / `cmdTokenPromote` の plan 解決を helper 呼び出しに置き換え。`cmdTokenPromote` の Found credential: ブロックも追加（add と UI 統一）。
- `skills/cmux-team/manager/token-cli.test.ts` — T1〜T6 / T5a を新規追加。既存 R-promote-2 / 8 / 9 / 10 / manual 経路成功 / organization_id 重複 / handle 重複の readline 回答列に空 Enter を 1 つ挿入。
- `docs/spec/09-token-pool.md` — token add / token promote セクションに新 prompt の挙動を追記（未知 tier も prompt 対象である旨を含む）。
- `package-lock.json` — v4.12.1 sync の取り残し（impl 中の `bun install` で再生成、本タスクと無関係）。

## 設計判断（plan.md より）

- **後者解釈採用**: `rateLimitTier` ありかつ `PLAN_MAP[rateLimitTier]` が undefined の未知 tier も prompt 対象とする（rateLimitTier 行ログは出さない）。新料金プラン追加への耐性 + escape hatch として空 Enter で unknown 確定可能。
- **不正値再入力**: `pro / max-x5 / max-x20` 以外の入力時は再入力ループ。exit 1 ではない（probe 後 8s タイムアウトのやり直しを避けるため）。
- **rotate scope 外**: `cmdTokenRotate` は plan / plan_ratio を扱わない設計（auth_hash 更新専用、plan 訂正は `set-plan` 経由）。
- **`validPlans` 不変**: `set-plan` 内部の `validPlans` を `PLAN_BY_NAME` に差し替える refactor は scope creep として不採用。
- **空行責務 helper 内包**: `Found credential:` ブロックと plan prompt の間の空行は `resolvePlanForRegistration` 内で出力。

## 検証

- `bun test --timeout 30000 token-cli.test.ts` → 37 pass / 0 fail / 4 skip
- `bunx tsc --noEmit -p tsconfig.json` → エラー 0 件
- 既存 `set-plan` 3 テストも無改造で全 pass

## 納品

- 納品方式: ローカル ff-only マージ（`main` へ）
- マージコミット: `e17e586a0da2d365f5436c3c6340e5b917f80f1a` (`feat(token): plan prompt for unknown rateLimitTier (T349)`)
