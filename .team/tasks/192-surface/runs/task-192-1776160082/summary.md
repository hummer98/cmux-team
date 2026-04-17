# T192 summary: ロガー改善 — surface 表記簡略化 + バージョン記録

## 成果

- logger.ts にヘルパー追加: `formatSurface`, `formatPair`, `SurfaceRole` 型 (`"C"|"A"|"M"|"U"|"S"`)
- `daemon_started` ログ先頭に package.json から読んだ `vX.Y.Z` を付加
- daemon.ts / conductor.ts / master.ts / main.ts / cmux.ts の surface 系ログ call-site を新表記 `C[665]` / 親子 `C[665]>A[719]` に置換
- dashboard.tsx の `parseJournalEntries` に `extractSurface()` ヘルパーを追加し旧 `surface=surface:NNN` と新 `C[NNN]` 両対応
- CLAUDE.md「ロギングポリシー > ログフォーマット」に `surface 表記（T192）` 節を追加

## 変更ファイル

```
 CLAUDE.md                               |  24 ++++++
 skills/cmux-team/manager/cmux.ts        |   6 +-
 skills/cmux-team/manager/conductor.ts   |  14 ++--
 skills/cmux-team/manager/daemon.test.ts |  14 ++++
 skills/cmux-team/manager/daemon.ts      | 128 ++++++++++++++++++--------------
 skills/cmux-team/manager/dashboard.tsx  |  21 +++++-
 skills/cmux-team/manager/logger.test.ts |  49 +++++++++++-
 skills/cmux-team/manager/logger.ts      |  39 ++++++++++
 skills/cmux-team/manager/main.ts        |  16 ++--
 skills/cmux-team/manager/master.ts      |   6 +-
 10 files changed, 239 insertions(+), 78 deletions(-)
```

## テスト結果

- `bun test`: 246 pass / 0 fail / 472 expect
- `bun run tsc --noEmit`: 0 errors
- 置換完全性 grep: 実装対象 0 件（dashboard.tsx の後方互換パーサー 2 件は plan 4.5 の除外対象）

## フェーズ実行履歴

- Phase 1 (Planner): plan.md 初版
- Phase 2 (Design Review): Changes Requested → Planner が再改訂 → Approved
  - 主な指摘: 剥がしルールを surface 系のみに狭め `task_id=` は key=value 維持（e2e.ts が依存）
- Phase 3 (Implementer): TDD で実装、bun test / tsc 全パス
- Phase 4 (Inspector): GO 判定（Non-blocking あり）

## 残課題（次タスク候補）

- **TUI dashboard の色付け未実装**: plan 5.1-5.2 の `parseLogLine` ロール抽出 + MAGENTA 定数追加 + セグメント着色が未実装。
  `extractSurface` による journal 解析の新旧両対応までは完了しているが、ログタブのロール別着色は次 PR で対応する。
- **CLAUDE.md の色カラム**: 色付け未実装のため、ID プレフィックス表から色カラムを省略。色付け実装時に同時更新予定。

## 納品

ローカルマージ（main ブランチへ）。
