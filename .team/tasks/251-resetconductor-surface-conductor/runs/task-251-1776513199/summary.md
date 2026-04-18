# T251 完了サマリー

## タスク

resetConductor で surface 実在確認を行い、幽霊 Conductor を防ぐ。

## 完了したサブタスク

1. Phase 1 (Plan): plan.md 作成（D1-D5 の設計判断を明示）
2. Phase 3 (Impl): conductor.ts / conductor.test.ts / daemon.test.ts を TDD で実装
3. Phase 4 (Inspection): GO 判定

## 変更ファイル

- `skills/cmux-team/manager/conductor.ts` — resetConductor 冒頭に `getPaneForSurface` 判定を追加。surface 不在なら targetStatus 指定を無視して broken に倒し、reason を `surface_missing` にする
- `skills/cmux-team/manager/conductor.test.ts` — T250 既存テストの beforeEach に getPaneForSurface モック追加 + T251 専用 describe で 3 テスト追加
- `skills/cmux-team/manager/daemon.test.ts` — resetConductor を経由する 2 既存テストに getPaneForSurface モック追加
- `package-lock.json` — npm install の副産物（3.53.0 → 3.54.1 へ package.json と整合性回復）

## テスト結果

- `bun test conductor.test.ts`: 17 pass / 0 fail
- `bun test` (manager 全体): 525 pass / 0 fail
- `bunx tsc --noEmit`: exit 0

## 設計判断（plan.md D1-D5 準拠）

- D1: `cmux.validateSurface` は未実装のため `getPaneForSurface(surface, workspace) === undefined` で代替
- D2: surface 不在時は targetStatus 指定を無視して broken に倒す（幽霊防止のため）
- D3: 既に broken な Conductor でも cleanup は最後まで実行（冪等）
- D4: `surface_missing` は opts.reason より優先（最も根源的な原因を記録）
- D5: conductor.test.ts に 3 テスト追加、daemon.test.ts の 2 既存テストも対応

## 納品

- マージ方針: ローカルマージ（`main` ブランチへ）
- コミット: 後段で記述
