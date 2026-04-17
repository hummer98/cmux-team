# Inspection: task-174

## Verdict

**GO**

## サマリ

plan.md の案A と design-review.md の Rec 1/3/4 がコードに忠実に反映されている。`launchConductor` に `opts.resumeTaskId` を追加し、resume コマンドを Claude 起動コマンドとして直接シェルに投入する設計は正しく機能する実装になっている。新規型エラーなし、既存呼び出し（`cmdSpawnConductor`）にも影響なし。

## 要件充足確認

### plan.md 要件

| 項目 | 判定 | 該当箇所 |
|------|------|---------|
| `launchConductor` に `opts?: { resumeTaskId?: string }` 追加 | OK | conductor.ts:97-101 |
| resume 時に `cmux-team resume <id>\n` を送信 | OK | conductor.ts:135 |
| resume 時は `[N] ♦ idle` rename をスキップ | OK | conductor.ts:142-147 |
| `initializeConductorSlots` に `resumePlan` 引数 + 戻り値 `ResumeAssignment[]` | OK | conductor.ts:181-190, 200-215 |
| CONDUCTOR_REGISTERED フォールバック時に resume 割当分は `status: "running"` + taskId/taskRunId/worktreePath を登録 | OK | conductor.ts:225-237 |
| `initializeLayout` に `resumePlan` 追加・`ResumeAssignment[]` 返却 | OK | daemon.ts:375-379, 441-447 |
| team.json 復元成功時は `[]` を返却（resume 送信しない） | OK | daemon.ts:431 |
| main.ts の旧 post-launch resume ブロック（旧 L414-473）削除 | OK | 削除済み、boot 前段に移動 |
| assigned タスクの事前スキャン → resumePlan 構築 | OK | main.ts:407-431 |
| sessionId / worktreePath / taskRunId 欠損時は `resume_fallback_to_ready` | OK | main.ts:417-424 |
| `maxConductors` 超過時は `resume_overflow_to_ready` | OK | main.ts:450-455 |
| ConductorState 反映 + タブ名 `[N] ♦ T<id> <title>` | OK | main.ts:482-500 |

### design-review.md Recommendations

| Rec | 内容 | 判定 | 該当箇所 |
|-----|------|------|---------|
| 1 | team.json 復元パスで `conductor_resume_noop` ログ | OK | daemon.ts:420-430 |
| 3 | resumePlan の sort 順序明示 + `resume_plan_built` ログ | OK | main.ts:441-447（taskId 数値昇順 sort）、main.ts:468-472（`taskIds=[...]` 形式） |
| 4 | タブ名スキップ条件にコメント | OK | conductor.ts:142-147（「呼び出し元が rename するため」と明記） |
| 2 | `initializeConductorSlots` を触らずに分離 | 未対応（plan.md の方針通りで design-review でも任意扱い。致命的ではない） |
| 5 | resume 後の Claude 起動完了待ちの信頼性明記 | impl.md では明示言及なし。ただし送信手順は従来と等価で挙動同一のためスコープ外として許容 |

## Fix Required

なし。

## 改善提案（任意）

1. **`findTaskFile` / `loadTaskState` の並列化**
   resumePlan のタイトル取得ループ（main.ts:458-466）は逐次実行。assigned が 3 件の現実では実害ないが、`Promise.all` 化で僅かに boot が短縮できる。

2. **assigned 件数 = maxConductors の境界値 E2E**
   design-review.md リスク 5 で指摘された等価ケース（3件ジャスト）が E2E に追加されていない。`resume_overflow_to_ready` が誤発火しないことを一度は確認しておきたい。

3. **`resume_assignment_missing_conductor` 発生時のフォールバック**
   main.ts:487 で `state.conductors.get(r.surface)` が無い場合ログだけ出して進む。通常は発生しないが、`CONDUCTOR_REGISTERED` が来ず、フォールバック登録も失敗した場合は孤立した assignments が残る。現状で致命的ではないが、将来的には該当 surface を `disconnected` として明示する分岐があると良い。

4. **taskId 数値パース失敗時の挙動**
   `parseInt` で `NaN` の場合 `localeCompare` にフォールバックする実装（main.ts:443-446）は堅牢。コメント一行でその意図を残すとより親切。

## 型チェック結果

```
cmux.ts(22,5): error TS2322           (pre-existing)
dashboard.tsx(372,5): error TS2322    (pre-existing)
dashboard.tsx(952,11): error TS2322   (pre-existing)
main.ts(394,42): error TS2345         (pre-existing)
```

impl.md が記載している pre-existing エラーと完全一致。**本修正で導入した新規型エラーなし**。

## 手動 E2E 検証の必要性

自動テストがないため Conductor が以下 5+1 ケースを手動で検証する必要あり：

1. **ケース1（主目的）**: fresh start で assigned 1 件 → `task_resumed ... (via boot)` ログ、シェルに `$` が一瞬見え、`cmux-team resume <id>` が実行され Claude が `--resume <sessionId>` で会話復元。以前の「プロンプト欄に `cmux-team resume 174` が入力された状態で止まる」症状が出ないこと。
2. **ケース2**: fresh start で assigned なし → 従来どおり `[N] ♦ idle` で 3 ペイン。
3. **ケース3**: daemon reload（team.json 復元）で assigned あり → `conductor_resume_noop reason=team_json_restored` のみ、resume 命令は送信されない。Claude セッションが維持される。
4. **ケース4**: `sessionId` 欠損 → `resume_fallback_to_ready`、status=ready に戻り通常 `cmux-team conductor` として起動。
5. **ケース5**: assigned 4 件（`maxConductors=3`）→ 先頭 3 件 resume、末尾 1 件は `resume_overflow_to_ready` で ready 戻し。
6. **（追加推奨）ケース5境界**: assigned ちょうど 3 件 → overflow ログが出ないこと、3 つとも resume されること（off-by-one 検出）。

加えて確認ポイント：

- `resume_plan_built taskIds=[...]` が sort 後の順で出力されていること（task-state.json を意図的にランダム順で編集して確認）。
- `cmdSpawnConductor`（CLI 手動 Conductor 追加）で従来どおり `[N] ♦ idle` がタブ名になり `cmux-team conductor` が起動すること（opts 省略パス）。
