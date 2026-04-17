# T219 検品レポート

**検品対象**: CONDUCTOR_DONE / SESSION_CLEAR / SESSION_STARTED に taskRunId 一致検証を導入
**worktree**: `/Users/yamamoto/git/cmux-team/.worktrees/task-219-1776289734`
**検品日時**: 2026-04-16
**Inspector**: inspector (独立セッション)

---

## Verdict: GO

## Summary

plan.md §4 の全サブタスク（§4.1〜§4.6）が実装されており、touched files (schema.ts / main.ts / daemon.ts) の `bunx tsc --noEmit` は exit=0。送信側 4 箇所（close-task / abort-task / restart-task / send CLI）と受信側 3 箇所（CONDUCTOR_DONE / SESSION_CLEAR running 分岐 / SESSION_STARTED T203 分岐）すべてで taskRunId の付与・検証が正しく実装されており、互換性条件 `message.taskRunId && conductor.taskRunId && !==` によって旧クライアントの undefined 経路はフォールスルーする。Critical / Major の指摘なし。

---

## Findings

### 1. 計画充足 — 完全（info）

- **変更ファイル**: `git diff main --name-only` で `schema.ts` / `main.ts` / `daemon.ts` の 3 ファイル変更を確認。plan.md §3 の対象と一致。
- **schema.ts** (`line 24`, `line 99`): `ConductorDoneMessage` / `SessionClearMessage` に `taskRunId: z.string().optional()` が追加されている。`SessionStartedMessage` は schema 変更なし（D2 通り）。
- **main.ts 送信側**:
  - `cmdCloseTask` (line 2374-2379): `taskRunId: conductor.taskRunId` 添付 ✓
  - `cmdAbortTask` (line 2827-2834): 同上（reason="aborted"）✓
  - `cmdRestartTask` (line 2991-2998): 同上（reason="restarted"）✓
  - `send CONDUCTOR_DONE` CLI (line 873-885): `taskRunId: getArg("task-run-id")` ✓
  - `send SESSION_CLEAR` CLI (line 954-962): 同上 ✓
  - → plan.md §4.2 / §4.3 の 5 箇所すべて実装。
- **daemon.ts 受信側 3 箇所**: `rg -n "conductor_done_stale|session_clear_stale|task_session_update_skipped"` の結果が `daemon.ts:747`, `daemon.ts:834`, `daemon.ts:1169` の 3 箇所ヒット。各 1 箇所ずつで重複なし。

### 2. Dead / Zombie Code — なし（info）

`git diff` に旧実装の残骸、コメントアウト、TODO マーカーの追加はなく、stale 検証のみが追加されている。旧ガード（`conductor_done_ignored` / `conductor_done_late_cleanup`）は既存機能として維持されており、並行実装ではない（D5 に沿った追加防御）。

### 3. テスト — 静的検証記録あり（info）

- 自動テスト基盤がないため impl-report §"互換性検証 (design-review F3 対応)" に静的レビューが記録されている。
- 3 箇所すべてで `message.taskRunId && conductor.taskRunId && ...` の短絡評価により、片方 undefined 時は検証スキップ → 既存パスに進む互換動作が明記されている。
- 手動 E2E（実 daemon 起動）はスコープ外として明示的に推奨扱い。plan.md §8 と整合。

### 4. 設計原則 (DRY / SSOT) — 許容範囲内（info）

- 3 ハンドラの検証ブロックは構造が類似（～10 行 × 3）しているが、plan.md §2.2 でヘルパー化を明示的に却下しており、タスク定義「やらないこと」に「全メッセージ共通の stale 検証ミドルウェア化リファクタ」が記載されている。
- 3 箇所それぞれの逆引きパスと中間ログが異なるため、コピペではなく各ハンドラ固有の実装として適切。
- SSOT: `conductor.taskRunId` は `state.conductors[surface].taskRunId` が真のソースで、`team.json` / `task-state.json` はその派生。送信側 3 箇所とも `teamJson.conductors.find(...).taskRunId` から取得しており、一貫している (D6)。

### 5. 統合 — 型で一貫（info）

- `ConductorDoneMessage.taskRunId` (schema.ts:24) は optional string、`ConductorState.taskRunId` (schema.ts:149) も同じ optional string。daemon.ts:744 の `message.taskRunId !== conductor.taskRunId` で型不整合なく比較可能。
- `SessionClearMessage.taskRunId` (schema.ts:99) も同様に optional string。daemon.ts:1166 で比較。
- `SESSION_STARTED T203` 分岐は `TaskState.taskRunId` と `ConductorState.taskRunId` の内部突合（daemon.ts:827-831）。hook 配布物を触らない D2 の設計と一致。

### 6. 型エラーゼロ化 (touched files) — 合格（info）

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-219-1776289734/skills/cmux-team/manager
bunx tsc --noEmit
→ exit=0
```

touched files (schema.ts / main.ts / daemon.ts) に関する型エラーは 0 件。

### 7. T219 固有検証 — すべて合格（info）

#### 7.1 ログイベント存在確認

```
daemon.ts:747   "conductor_done_stale"
daemon.ts:834   "task_session_update_skipped"
daemon.ts:1169  "session_clear_stale"
```

3 イベントとも 1 箇所ずつ存在し、いずれも `reason=stale_task_run_id` で終端。既存 stale 系 (`session_ended_ignored` / `conductor_done_ignored` / `conductor_done_late_cleanup`) のフォーマットと揃っている（D4）。

#### 7.2 SESSION_STARTED 線形構造（F1）

daemon.ts:822-855 の `try` ブロック内が

```
if (cur && conductor.taskRunId && cur.taskRunId && cur.taskRunId !== conductor.taskRunId) {
  log("task_session_update_skipped", ...)
} else if (cur && cur.status === "assigned" && cur.sessionId !== message.sessionId) {
  // 既存 sessionId 同期ロジック
}
```

という「先頭 guard + else 既存ロジック」の線形構造で実装されており、design-review F1 推奨事項を満たしている。ネストや深い if 分岐なし。

#### 7.3 互換性条件の順序

3 箇所すべて `message.taskRunId && conductor.taskRunId && message.taskRunId !== conductor.taskRunId` の順序。
- 片方が undefined（旧クライアント / hook 配布物）→ 短絡評価で検証スキップ → 既存フォローパスへフォールスルー。
- 両方 truthy かつ異なる → stale ログ + break。
- 両方 truthy かつ一致 → 既存処理続行。

D3 の互換モード要件を完全に満たしている。

#### 7.4 CONDUCTOR_DONE ガード順序（D5）

daemon.ts:720-764 の順序:

1. `findConductor` 失敗 → `conductor_done_ignored reason=not_found`
2. `conductor.status !== "running" && !conductor.taskRunId` → `conductor_done_ignored reason=no_task`
3. **T219 追加**: `message.taskRunId && conductor.taskRunId && !==` → `conductor_done_stale`
4. `conductor.status !== "running"` → `conductor_done_late_cleanup` ログ
5. `handleConductorDone` 実行

ガード順序は D5 通り、no_task ガードの後ろに stale 検証が配置されている。`late_cleanup` パスでも stale 検証が有効に働く点が impl-report §3.1 のコメントに明記されており、F5 推奨事項も満たしている。

#### 7.5 SESSION_CLEAR running 分岐のガード位置（F2 / D7）

daemon.ts:1148-1199:

1. `disconnected / starting → idle` 遷移分岐（destructive でないためガード不要 — D7）
2. **T219 追加**: running 分岐の直前で stale 検証 → `session_clear_stale` + break
3. `conductor.status === "running"` の destructive 分岐（task-state aborted + resetConductor）

idle 復帰のみの非破壊パスをフォールスルーさせつつ、destructive な running 分岐の直前で stale を弾く配置は D7 と一致する。`disconnected` → `idle` に遷移した後は `conductor.status === "running"` がマッチしないため、T219 検証ブロックは実質的に初期ステータスが running のときだけ走る（logically equivalent to "running 分岐の先頭"）。

---

## 完了条件チェックリスト検証

plan.md §9 および conductor-prompt.md「完了条件」との照合:

- [x] schema.ts に CONDUCTOR_DONE / SESSION_CLEAR の taskRunId フィールド追加 → schema.ts:24, schema.ts:99
- [x] main.ts の close-task / abort-task / restart-task / send CONDUCTOR_DONE で taskRunId 添付 → main.ts:2376, 2830, 2994, 877, 958（5 箇所、要求は 4 だが send SESSION_CLEAR 拡張が追加されている）
- [x] daemon.ts の 3 ハンドラで一致検証ロジック追加 → daemon.ts:741-751 (CONDUCTOR_DONE), 827-836 (SESSION_STARTED T203), 1161-1173 (SESSION_CLEAR)
- [x] 既存の正常系が壊れないこと — 互換性条件 `message.taskRunId && conductor.taskRunId && ...` の短絡評価で担保（impl-report §"互換性検証" に静的記録あり）
- [x] log フォーマット `conductor_done_stale` / `session_clear_stale` / `task_session_update_skipped` が出ること — grep 結果 3 箇所ヒット

---

## 備考（GO/NOGO に影響しない）

- **design-review F4（ログフォーマット差分）**: impl-report §"design-review 軽微所見の扱い" で、plan.md §2.3 の既存パターン (`*_ignored reason=<理由>`) に揃えたため、タスク定義の `expected=/got=` 例示から意図的に逸脱した旨が記録されている。実運用上は `message_task_run_id=X current_task_run_id=Y reason=stale_task_run_id` で必要な情報がすべて取れるため実害なし。
- **impl-report §4.1 の検証値差異**: `rg 'taskRunId: z\.string\(\)\.optional\(\)' schema.ts` の期待値 2 に対し実値 3 だが、1 件は既存の `ConductorState.taskRunId` 定義であり、新規追加 2 件（ConductorDoneMessage / SessionClearMessage）は期待通り。impl-report にその旨が注記されている。

---

## GO 判定根拠

- Critical: **0 件**
- Major: **0 件**
- Minor: **0 件**

plan.md §4 の全サブタスクが実装され、型検査も exit=0。3 ハンドラの検証ロジックは D1〜D7 の Decision Log および design-review F1/F2/F5 の所見に沿って実装されている。互換モード（片方 undefined でフォールスルー）も短絡評価で正しく担保されており、旧クライアントからのメッセージは stale 扱いされない。

**GO** として上位に返却する。
