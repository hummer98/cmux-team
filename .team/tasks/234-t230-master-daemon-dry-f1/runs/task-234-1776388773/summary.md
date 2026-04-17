# T234 完了サマリー

T230 Master self-register の follow-up 5 項目（S12-2 / S12-1 / S12-3 / F1-cleanup / DRY）を単一 worktree で処理し、Inspector が **GO** 判定。

## 完了したサブタスク

| 項目 | 内容 | 主変更 |
|------|------|--------|
| S12-2 | `stopDaemon` で pid watcher interval を全解放 | `daemon.ts` に `stopDaemon(state)` 追加、生 `state.running = false` 5 箇所を置換 |
| S12-1 | `normalizeSurfaceForPath` 共通化 | 新規 `paths.ts`、`master.ts` / `daemon.ts` から import |
| S12-3 | `master.test.ts` 新規作成 | `persistMasterFile` / `deleteMasterFile` / `listMasterFiles` の境界ケース 13 テスト |
| F1-cleanup | fallback 仮登録の掃除 | `MasterState.fallback` 追加、`CONDUCTOR_REGISTERED` で削除 / `MASTER_REGISTERED` で flag 落とし |
| DRY | `registerSelf` 共通化 | 旧 2 関数を完全撤廃、`registerSelf(role, surface)` に統合 |

## 変更ファイル

| ファイル | 種別 | 増減 |
|---------|------|------|
| `skills/cmux-team/manager/paths.ts` | 新規 | +24 |
| `skills/cmux-team/manager/master.test.ts` | 新規 | +180 |
| `skills/cmux-team/manager/daemon.ts` | 変更 | +83 / -7 |
| `skills/cmux-team/manager/main.ts` | 変更 | +30 / -59 |
| `skills/cmux-team/manager/master.ts` | 変更 | +8 / -5 |
| `skills/cmux-team/manager/schema.ts` | 変更 | +6 / -0 |

## テスト結果

- `bunx tsc --noEmit`: 0 エラー
- `bun test`: **436 pass / 0 fail / 963 expect()**（元 423 + 新規 13）
- `bun test master.test.ts`: 13 pass / 0 fail

## 設計判断

- **MASTER_REGISTERED の F1 処理**: 「削除・再生成」ではなく「flag のみ落として entry 保持」を選択。既存 T4（SESSION_STARTED 先着 + MASTER_REGISTERED 後着で pid=99999 保持）との整合を最小コストで取る解。
- **`normalizeSurfaceForPath` の実装選択**: master.ts 版（コロン置換のみ）と daemon.ts 版（regex）の差異を防御的な regex 版に寄せた。`surface:NNN` 形式では両者同出力のため既存テストに破壊なし。
- **`registerSelf` の共通化粒度**: 薄いラッパーを残さず完全置換（feedback memory「後方互換コードは不要」に準拠）。

## 残課題（本タスク範囲外）

- `docs/spec/05-install-and-infrastructure.md` に旧関数名 `registerSelfAsMaster` と旧 `normalizeSurfaceForPath` 実装の記述が残る。次回 docs-sync で追従。

## 納品

- ブランチ: `task-234-1776388773/task`
- マージ先: `main`
- 納品方法: ローカルマージ（インフラ整理・テスト整備のため共有レビュー不要）
- マージコミット: 完了処理で記録
