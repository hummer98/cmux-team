---
id: 178
title: logger.ts のログ出力先切替に関するリグレッションテスト追加
priority: medium
created_at: 2026-04-13T16:04:16.131Z
---

## タスク
## 背景

T177 で `skills/cmux-team/manager/logger.ts` の `PROJECT_ROOT` を module-level 定数から `log()` 内の都度評価に修正したが、直接的なリグレッションテストは追加していない（既存 `daemon.test.ts` が green になることで間接確認したのみ）。

module-level 定数に戻す変更が入ってもテストが通ってしまうため、再発防止が弱い。

## やること

`skills/cmux-team/manager/logger.test.ts` を新規作成し以下 3 ケースを追加する。

### 1. PROJECT_ROOT 遅延評価

- `import { log } from "./logger"` 済みの状態で `process.env.PROJECT_ROOT = tmpdir` を設定
- `await log("test_event", "detail=1")` を呼ぶ
- `<tmpdir>/.team/logs/manager.log` に該当行が書かれていることを assert
- 実プロジェクトの `.team/logs/manager.log` には書かれないことを assert（sentinel 文字列で確認）

### 2. 動的切替

- 同一プロセスで `process.env.PROJECT_ROOT = tmpdirA` → `log()` → `process.env.PROJECT_ROOT = tmpdirB` → `log()` を実行
- tmpdirA / tmpdirB 両方に期待される行がそれぞれ書かれていることを assert
- 定数キャッシュが復活していれば tmpdirB への書き込みが tmpdirA に流れる → その regression を検出できること

### 3. プロジェクト未汚染（sentinel ベース）

- テスト前に実プロジェクト `manager.log` 内の sentinel 文字列（ユニークなテスト専用 event 名、例: `regression_sentinel_<nonce>`）の出現数を記録
- テスト実行（上記 1 / 2 含む）後に再度数え、増加していないことを assert
- 並行実行耐性を考え、行数ではなく sentinel 文字列の件数で確認

## 実装上の注意

- `beforeEach` / `afterEach` で `process.env.PROJECT_ROOT` を退避・復元する（他テストへの影響防止）
- tmpdir は `os.tmpdir()` 配下に `mkdtemp` で確保し、`afterEach` で `rm -rf`
- テストは `bun test skills/cmux-team/manager/logger.test.ts` で実行できること
- 既存 142 テストが引き続き green であることを確認

## 完了条件

- `logger.test.ts` が追加され 3 ケース全て pass
- `bun test`（manager 全体）で 145 pass / 0 fail（既存 142 + 追加 3）
- 結果サマリーを `runs/<taskRunId>/summary.md` に記録
