# T255 Inspection Report

## 判定

**GO**

## サマリー

plan §3.1 マトリクス (A〜E + tree degrade) と §3.2 擬似コードが `layout-restore.ts` (pure) + `daemon.ts:applyRestorePlan` (side effects) にほぼ忠実に実装されており、review 2nd pass で挙げられた 5 件の注意事項 (M12 handoff / fetchLiveSurfaces(undefined)=null / B 経路 sequential / 単一コミット粒度 / conductor_register_skipped 整合) もすべてコード・テストで担保されている。`bun test` 542 pass、`bunx tsc --noEmit` エラー 0、廃止ログ (`conductor_resume_noop` / `conductor_restore_skipped`) も完全削除。M8/M9/M13 のテスト省略は実害なし (cover される代替経路あり)。破壊的変更なし、既存 ST-14 通過。

## 検品マトリクス

| 観点 | 結果 | 備考 |
|------|------|------|
| plan §3.1 マトリクス | ✓ | `layout-restore.ts:82-132` で A/B/C/D/E + tree degrade 5+1 分岐が MECE に実装。pid alive → A 即確定、tree degrade + pid dead → A 相当保守も明示 |
| plan §3.2 擬似コード順序 | ✓ | `applyRestorePlan`: clear → A 反映 → C cleanup → E discarded log → B resume → D/unmatched→ready → saveTaskState。A を B より先に行い、C を B より先に行う順序で layout 衝突リスクなし |
| 型定義の存在 | ✓ | `RestoreDecision` / `RestoreEntry` / `DiscardedEntry` / `LayoutRestorePlan` が `layout-restore.ts:20-53` に定義。plan §4.1 通り |
| 冪等性 (§7 表 5 項目) | ✓ | ①`state.conductors.clear()` は `applyRestorePlan:856` で 1 回のみ ②`CONDUCTOR_REGISTERED` skip は `daemon.ts:1448-1455` で既存維持 ③`closeSurface` は `cmux.ts:99-103` で `.catch(() => {})` 冪等 ④`launchConductor` は B 経路 (`applyRestorePlan:944`) のみから呼ばれ A には送らない ⑤`spawnPidWatcher` の `clearInterval` ガードは既存維持 |
| M1-M16 テスト網羅 | 部分 | pure 単体 10 (M1-M5, M7, M12, M6 core, edge×2) + 統合 10 (M6, M7, M10, M11, M12, M14, M15, M16, layout_kept_partial, 廃止ログ) = 20 ケース。M8/M9/M13 は省略だが、M16 (B rollback) が existsSync→ready 戻しと同型ロジック、M10 が conductor_taskid_reconciled 本経路、M7+M12 の合成で M13 相当をカバー。いずれも追加テスト不在による回帰リスクは低 |
| ロギング規約 | ✓ | 新ログ 7 種 (`conductor_stale_surface_closed` / `resume_worktree_missing_late` / `tree_fetch_failed` / `conductor_taskid_reconciled` / `conductor_resume_launch_failed` / `resume_unmatched_to_ready` / `layout_kept_partial`) はすべて `*_failed` or その他イベント名規約準拠。surface 表記は全て `formatSurface(s, "C")` を経由 (layout-restore.ts は pure のため formatSurface なし。surface 文字列はそのまま保持) |
| EventBus ポリシー | ✓ | `applyRestorePlan:995` で `notifyStateChanged("daemon.ts:applyRestorePlan:restore-applied")` を 1 回。`rg "bus\.(emit\|on)\b" skills/cmux-team/manager \| rg -v eventBus.ts` → 0 件 |
| 廃止ログ削除 | ✓ | `rg -n conductor_resume_noop skills/cmux-team/manager/` → `daemon.test.ts:3433,3452` (廃止検証テストの中でのみ参照)。`rg -n conductor_restore_skipped skills/cmux-team/manager/` → 0 件。本体コードから完全削除 |
| `bun test` | ✓ 542 pass | 0 fail、1281 expect。impl-report と一致 |
| `bunx tsc --noEmit` | ✓ エラー 0 | exit 0 |

## Critical Findings (NOGO 理由)

なし。

## Non-critical Findings (情報共有)

### N1: `resume_unmatched_to_ready` ログの reason フィールドが plan 記述と不一致

- 場所: `daemon.ts:981-984`
- plan §3.2 step 4b は `\`task_id=${tid} reason=not_in_team_json\`` を指示。実装は `\`task_id=${item.taskId} session_id=${item.sessionId}\`` で `reason=` が欠落、代わりに `session_id=` が付加されている。
- 影響: ログ検索で `reason=not_in_team_json` を grep するフィルタがあれば空振りする。現状外部依存は無いため実害なし。追跡には session_id の方が便利なので実装側の方が実用的とも取れる。
- 対応: そのままで OK。将来的にログ規約を整えるときにレビュー対象化すれば十分。

### N2: `conductors_restored` の surfaces リストに rollback 済み B 経路が含まれる

- 場所: `daemon.ts:1056-1064`
- `keptSurfaces` は `plan.alive` + `plan.resumeExisting` で計算されるが、B 経路の `launchConductor` 失敗で rollback された surface も含んでしまう (実際には `state.conductors` から削除済み)。
- 影響: ログ表示上の不整合。`state.conductors.size` と `conductors_restored count=N` が一致しないケースがある (M16 相当)。副作用なし。
- 対応: 情報共有のみ。将来 `keptSurfaces = [...state.conductors.keys()]` に変えれば一致する。

### N3: M8 (resume_worktree_missing_late) の専用テスト不在

- 場所: `daemon.ts:919-927` で `existsSync(item.worktreePath)` false 時に log + ready 戻し
- impl-report は「M11/M16 と同類の経路で代替」と説明するが、実際 M16 は `cmux.send` throw での rollback、M11 は pid_only degrade で B 経路に入らない。`resume_worktree_missing_late` 固有ログの発火検証は行われていない。
- 影響: `existsSync` 分岐自体は単純 (4 行)、回帰リスクは低。
- 対応: GO でよい。将来テスト追加する場合、worktree パスに実在しないディレクトリを仕込む M8 が容易に実装可能。

### N4: `conductor_taskid_reconciled` 時に `taskTitle` もクリア (plan §3.2 step 6 の明示範囲外)

- 場所: `daemon.ts:873-877`
- plan §3.2 step 6 は `taskId` / `taskRunId` / `worktreePath` / `status=idle` のみクリアを指示。実装は `taskTitle` も undefined にする。
- 影響: taskTitle は表示用メタデータのため、taskId クリア時に一緒に消すのは整合性が取れて妥当。plan からの逸脱というより「plan が taskTitle を落とした細部を補完した」形。
- 対応: そのままで OK。

## GO の場合: 実装者注意事項

1. **N1 の log format 揺れ**: 他の復帰系ログは `task_id=... reason=...` 形式を採る箇所が多いので、今後 `resume_unmatched_to_ready` も `reason=` を含める形に揃えるか検討。既存コードに波及しない範囲で、CHANGELOG のログ一覧に現行フォーマットを明記しておくと外部監視側との齟齬を防げる。

2. **N3 に備える**: `resume_worktree_missing_late` 経路はユーザーが手動で worktree を削除した稀なケースでしか発火しないため実機でも観測が難しい。将来バグが入った場合に気付くためには、daemon.test.ts に M8 シナリオを追加しておくのが保険として有効。

3. **コミット粒度 (review Rec #11)**: 差分は `daemon.ts +370 / -104`、`daemon.test.ts +429`、`layout-restore.ts +150`、`layout-restore.test.ts +180` 程度。single commit で収める判断は diff 規模 (合計 700 超) を考えると bisect しづらい可能性あり。PR 作成時に 2a/2b/2c 分割の再検討を。最終判断は Conductor 側の粒度方針次第。

4. **手動動作確認が未実施**: impl-report に明記あり。M6 (pid_dead + alive 混在) の実機シナリオは pure/統合テスト網羅済みだが、layout 崩れ (wide/16x9 両方の restore 経路) は実機確認で最終検証することを推奨。

5. **`conductors_restored` log の精度 (N2)**: 別 PR で余裕があるときに `keptSurfaces = [...state.conductors.keys()]` に変えると `count=N` の意味が「実際に state に残っている Conductor 数」と一致して監視しやすくなる。

## NOGO の場合: Fix Required

なし (GO 判定のため)。
