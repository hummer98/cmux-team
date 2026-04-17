# Implementation: task-174

## 変更ファイル一覧

| ファイル | 主要変更箇所 |
|---------|-------------|
| `skills/cmux-team/manager/conductor.ts` | L68-121: `launchConductor` に `opts?: { resumeTaskId?: string }` 追加、`ResumePlanItem` / `ResumeAssignment` 型を新規 export、タブ名 rename を resume 時にスキップ<br>L151-240: `initializeConductorSlots` に `resumePlan` 引数追加、戻り値を `ResumeAssignment[]` に変更、フォールバック登録で resume 割当分は `status: "running"` + taskId で登録 |
| `skills/cmux-team/manager/daemon.ts` | L8-17: `ResumePlanItem` / `ResumeAssignment` を import<br>L373-450: `initializeLayout` の引数に `resumePlan` 追加、戻り値を `ResumeAssignment[]` に変更、team.json 復元パスで `conductor_resume_noop` ログを追加（design-review Recommendation 1） |
| `skills/cmux-team/manager/main.ts` | L396-501 付近: boot シーケンスを再構成<br>・assigned タスクを scan して `resumePlan` を事前構築（旧 L414-473 の post-launch ブロックを削除）<br>・taskId 数値昇順で sort（design-review Recommendation 3）<br>・`resume_plan_built` ログを追加<br>・slot 数超過分を `resume_overflow_to_ready` で差し戻し<br>・`initializeLayout` の戻り値 `resumeAssignments` を元に `ConductorState` + タブ名を反映<br>・`task_resumed ... (via boot)` のログを維持 |

## 主要な変更内容の要約

### 根本原因

旧実装では `launchConductor` が `cmux-team conductor\n` をシェルに送って Claude を起動した後、main.ts で `cmux-team resume <id>\n` を同じ surface に送っていたため、後者が Claude のチャット入力として消費されていた。

### 修正方針（plan.md 案A）

`launchConductor` の起動コマンド自体を分岐する。`opts.resumeTaskId` があれば `cmux-team resume <id>\n` を、なければ従来どおり `cmux-team conductor\n` をシェルに送る。boot 時に assigned タスクを先にロードして `resumePlan` を構築し、`initializeLayout → initializeConductorSlots → launchConductor` に透過させる。

### 設計レビュー指摘への対応

1. **`conductor_resume_noop` ログ追加** — `daemon.ts` の team.json 復元成功パスで `resumePlan` の各タスクに対し `conductor_resume_noop reason=team_json_restored` を記録。
2. **resumePlan sort 順序の明示** — taskId 数値昇順で sort、`resume_plan_built taskIds=[...]` をログ出力。overflow で ready に戻すのは sort 後の末尾。
3. **タブ名スキップのコメント** — `launchConductor` step 4 に「呼び出し元が T<id> に rename するため idle を付けない」旨のコメントを追加。
4. `initializeConductorSlots` の責務は拡張したが（Recommendation 2 は任意扱い）、plan 方針通り戻り値拡張で対応。

## 確認した型チェック結果

`bunx tsc --noEmit` 実行結果:

```
cmux.ts(22,5): error TS2322: ... (pre-existing)
dashboard.tsx(372,5): error TS2322: ... (pre-existing)
dashboard.tsx(952,11): error TS2322: ... (pre-existing)
main.ts(394,42): error TS2345: ... (pre-existing)
```

本修正で導入した新規エラーは無し（変更前 baseline と同じエラー数・同じファイル）。一度 `noUncheckedIndexedAccess` 関連で `pane` possibly undefined の警告が出たが、`panes.entries()` を用いて解消済み。

## 確認できていない事項（手動 E2E が必要）

plan.md のテスト戦略セクションに記載された 5 ケース全てが未検証:

1. **ケース1: fresh start で assigned タスクあり**（本修正の主目的）
   - 期待: `task_resumed ... (via boot)` ログ・シェル経由で `cmux-team resume <id>` 実行・Claude が `--resume <sessionId>` で会話復元
2. **ケース2: fresh start で assigned タスクなし** — 従来どおり `[N] ♦ idle` で 3 ペイン立ち上がり
3. **ケース3: daemon reload（team.json 復元成功）で assigned タスクあり** — `conductor_resume_noop` ログのみ、resume 命令は送信しない
4. **ケース4: resume 不可（`sessionId` 欠損）** — `resume_fallback_to_ready` で ready 差し戻し
5. **ケース5: assigned 数 > slot 数** — 先頭 3 件 resume、4 件目は `resume_overflow_to_ready`

また、`cmdSpawnConductor`（CLI 経由の手動 Conductor 追加）が `opts` 省略で従来どおり動作することは型レベルでは確認したが、実機確認は未実施。

## スコープ外（触っていない）

- `cmdResume`（main.ts:915 以降）本体
- `validateSurface`, `cmux send/send-key`, `rate limiter` 等の既存実装
- 他の Conductor 起動経路（`cmdSpawnConductor` の挙動は不変）
