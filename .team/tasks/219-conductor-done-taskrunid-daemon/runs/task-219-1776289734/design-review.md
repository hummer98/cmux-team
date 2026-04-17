## Verdict: Approved

## Summary

T219 の plan.md は、CONDUCTOR_DONE / SESSION_CLEAR / SESSION_STARTED の 3 ハンドラに taskRunId 一致検証を追加する根本対策として妥当である。schema 拡張・送信側添付・受信側検証の 3 段階が過不足なく分割され、互換モード（片方 undefined はスキップ）によって旧クライアント互換も確保されている。Critical findings は 0 件。以下 Recommendations は minor な改善提案。

## Findings

### F1. [minor] SESSION_STARTED 分岐での `cur.status` 比較条件の省略

plan.md §3.3.3 の擬似コードでは、`cur.taskRunId !== conductor.taskRunId` のときに skip した後の else 節で `cur.status === "assigned" && cur.sessionId !== message.sessionId` チェックが残っている（既存挙動維持）。一方、新旧ロジックの切れ目で `cur.taskRunId` が両方 undefined の場合は既存の assigned 判定にフォールスルーする。これ自体は D3 で定義した「互換モード」と整合しており問題ないが、擬似コードの if/else 分岐が読みにくい。実装時に次のように整形することを推奨する:

```ts
// 先頭でガード: stale なら skip
if (cur && conductor.taskRunId && cur.taskRunId && cur.taskRunId !== conductor.taskRunId) {
  await log("task_session_update_skipped", ...);
  break; // try ブロック内なので return/continue 相当
}
// 既存ロジック
if (cur && cur.status === "assigned" && cur.sessionId !== message.sessionId) {
  ts[conductor.taskId] = { ...cur, sessionId: message.sessionId };
  await saveTaskState(...);
  await log("task_session_updated", ...);
}
```

ガードを先頭に置くことで「stale なら何もしない」「一致なら既存挙動」が線形に読める。

### F2. [minor] SESSION_CLEAR の検証位置が仕様書と僅かに異なる

task 仕様書の擬似コード（conductor-prompt.md §3）は `running` 分岐内で検証しているが、plan.md §3.3.2 では `running` 分岐に入る前の if 連鎖で検証して break している。結果は同じ（destructive 処理が走らない）だが、disconnected/starting → idle 復帰分岐の後に置かれるため、ログの出現順が変わる可能性がある。特に問題ではないが、実装時に「running 分岐の先頭」とコメントを付けると読みやすい。

### F3. [minor] 互換性検証に独立サブタスクがない

§4.1〜§4.6 のサブタスクは schema/送信/受信/ログ/tsc に分割されているが、D3 の「片方 undefined を既存挙動維持」を確認するサブタスクが独立して存在しない。動作確認は §8 の手動確認手順に含まれるが、以下のいずれかを追加することを推奨:

- §4.7 として「互換性テスト: taskRunId 未添付の CONDUCTOR_DONE / SESSION_CLEAR が正常に処理されること（stale 扱いされないこと）を `cmux-team send` で確認」
- または §9 の完了条件チェックリストに「taskRunId 未添付メッセージでも従来通り動作する」を明示項目として追加

### F4. [minor] ログフォーマットがタスク仕様書と微妙に異なる

task 仕様書の例: `expected=${conductor.taskRunId} got=${message.taskRunId}`
plan.md §3.3.1 の例: `message_task_run_id=${message.taskRunId} current_task_run_id=${conductor.taskRunId} reason=stale_task_run_id`

plan.md の形式は既存の `*_ignored reason=<理由>` 統一パターン（daemon.ts:725, 734）により近く、D4 で明示的に判断記録されている。採用自体は妥当。ただしタスク仕様書記載との差分を summary.md でも明記すると後続のトレーサビリティが上がる。

### F5. [minor] §3.3.1 擬似コードの `reason=no_task` ガードと新規検証の相互作用

既存ガード:
```ts
if (conductor.status !== "running" && !conductor.taskRunId) {
  // no_task で break
}
```
この直後に配置される新規検証は、`conductor.taskRunId` が truthy であることが既に保証されたタイミングで走る（running or late_cleanup パス）。Decision Log D5 にこの配置理由が明記されており、ロジック的には正しい。

ただし、late_cleanup パスで `conductor.status !== "running"` のときに stale チェックをする意味は次のとおり:
- disconnected → 新タスク assign 前のメッセージ残滓は message.taskRunId が空（旧クライアント）or 同じ taskRunId（crash 復帰）
- message.taskRunId が違う値を持つケースは「別タスクに再 assign 後の late 残滓」→ 正しく stale として弾ける

この意味はコメントで注記しておくと後続保守者が理解しやすい。

### F6. [minor] `conductor.taskRunId` が `ConductorState` の zod schema に定義済みである点への言及

plan.md §2.3 で `schema.ts:147` を参照して既存の `ConductorState.taskRunId` の存在に触れているが、実際に schema.ts:146-159 を確認した通り `ConductorState` は zod schema として定義されている。ただし daemon.ts 内で使われている `ConductorState` はコメント上の型であり、inferType から `taskRunId` を取得している。plan.md がこれを前提としている点は正しいが、schema.ts 側の `ConductorState` を直接 infer すると `agents` フィールドが不足する可能性がある — これは本タスクスコープ外の既存課題であり、本 plan に影響しない。参考情報として記録する。

## CRITICAL チェック項目の評価

| 項目 | 結果 | 根拠 |
|------|------|------|
| サブタスクカバレッジ（schema/main/daemon） | ✅ PASS | §4.1〜§4.6 で全変更対象を分割、送信 4 箇所 (close/abort/restart/send) + 受信 3 箇所すべて列挙 |
| 送受両側の漏れ無し | ✅ PASS | §3.2.1〜§3.2.4 と §3.3.1〜§3.3.3 で対称にカバー |
| 互換性サブタスク | ⚠️ 動作確認 §8 と §5.1 のリスク対策でカバーしているが、専用サブタスクはない（F3 参照） |
| 削除タスクの並行維持 | ✅ N/A | 追加のみで既存ガードは保持、旧ロジックと新検証が補完関係 |
| 型エラー先読み | ✅ PASS | §6 で `bunx tsc --noEmit` を実行し `clean` と記録 |
| Decision Log (optional 理由 + SESSION_STARTED 突合キー) | ✅ PASS | D1〜D7 で 7 件記録、特に D1 (optional)・D2 (SESSION_STARTED の突合キー選択)・D3 (検証条件) が明示 |

## T219 固有の検証観点

| 観点 | 結果 | 根拠 |
|------|------|------|
| `current.status === "assigned"` への限定理由 | ✅ 妥当 | §5.3 で「task-state.json の status 定義 (assigned = 実行中)」と「running は ConductorState.status 側の概念」を正しく分離 |
| 条件順 `message.taskRunId && conductor.taskRunId && ...` と片方欠損時の扱い | ✅ 明記 | §2.1, §5.1, D3 で一貫して定義 |
| close/abort/restart の taskRunId 取得経路 | ✅ 明記 | §3.2.1-3 で teamJson.conductors から引くこと、D6 でその選択理由を記録。既存の close-task trace DB 挿入パターンと整合 |

## Recommendations

Approved のため強制事項なし。以下は実装品質を高める任意の改善提案:

1. **F1**: SESSION_STARTED 分岐の擬似コードを「先頭 guard + else 既存ロジック」の線形構造に整形する。
2. **F3**: §9 の完了条件チェックリストに「taskRunId 未添付メッセージが従来通り動作する」を明示項目として追加するか、§4 に互換性確認サブタスクを追加する。
3. **F4**: summary.md 作成時、タスク仕様書の `expected=/got=` 例示と plan.md の `message_task_run_id=/current_task_run_id=` 採用の差分を一行コメントで残す。
4. **F5**: daemon.ts の CONDUCTOR_DONE ハンドラに追加する stale 検証ブロックの直前に、`// late_cleanup パスでも走る: disconnected 時の新タスク再 assign 後に残った stale シグナルを弾く` 程度の注記を追加。
5. **実装時追記**: §8 の手動動作確認にあたって、`cmux-team send CONDUCTOR_DONE --surface <C> --task-run-id task-XXX-YYYY` での擬似 stale 再現を必須ではなく「推奨」として実行し、ログ検証結果を summary.md に貼付する。

以上。plan.md は根本対策として十分練られており、Approved と判定する。
