# T241 Design Review

## Verdict: Approved

## Summary

plan.md は T241 仕様（depends_on 親の aborted/deleted 遷移時に ready 子を draft へ戻す cascade）を正しく理解し、5 経路すべてを網羅している。`cascadeAbortToChildren` を `task.ts` に純粋関数として切り出す配置判断は、task.md 本文の示唆（「daemon.ts に実装」）より優れている（CLI からも呼ぶ必要があるため）。現状コード行番号・関数シグネチャも検証の結果すべて一致。Critical findings は 0 件。Minor findings と推奨事項のみ。

## 参照コード検証結果

plan.md が前提にしている現状コード位置はすべて正しい:

| plan.md 記述 | 現状確認 | 結果 |
|---|---|---|
| `daemon.ts:1728-1732` closed Set 構築 | L1728-L1732 に一致 | ✅ |
| `daemon.ts:1664-1681` user_clear 経路 | L1664-L1681 に一致 | ✅ |
| `daemon.ts:2138-2168` forceCloseDisconnectedConductor | L2131-L2168 に一致 | ✅ |
| `daemon.ts:1815-1829` assign_failed 経路 | L1815-L1829 に一致（task kind 分岐） | ✅ |
| `main.ts:2988-2994` cmdAbortTask (no conductor) | L2988-L2994 に一致 | ✅ |
| `main.ts:3012-3018` cmdAbortTask (with conductor) | L3012-L3018 に一致 | ✅ |
| `main.ts:3257-3262` cmdDeleteTask | L3257-L3262 に一致 | ✅ |
| `task.ts:193` filterExecutableTasks 依存判定 | L193 `task.dependsOn.every(dep => closedIds.has(dep))` に一致 | ✅ |
| `TaskMeta` / `TaskStateMap` 型 | task.ts:9-43 に存在・plan のモックと一致 | ✅ |
| daemon.test.ts `createTask` ヘルパー | L31-72 に存在・`dependsOn` パラメータあり | ✅ |

追加検証: aborted/deleted への書き込みは全リポジトリで 6 箇所（cmdAbortTask 2 + cmdDeleteTask 1 + daemon 3 経路）のみ。daemon.ts:2501 の taskState 更新は status="closed"（update_task supersede）で cascade 対象外。**5 経路カバレッジは完全**。

## Findings

### 1. [Minor] plan.md §3.3 内のログ reason インライン矛盾

- L304 のコード例: `` `parent=${taskId} child=${childId} reason=parent_deleted` ``
- L310 の Decision D2 注記と §8 D7: 「ログキー `reason=` は `parent_aborted` に統一」

コード例と Decision が矛盾している。実装者が L304 のコード例をそのまま貼り付けると `parent_deleted` でコミットし、後で D7 に気づいて修正する二度手間が発生する。

**影響**: 軽微（実装時の確認で検出可能）。ログキー統一の意図（検索性・仕様文一致）は Decision D7 が正解。

### 2. [Minor] 配線 E2E テストの欠如

Decision D5 で「pure function テストで十分」と判断され、scanTasks 経由の E2E テストは意図的にスキップされている。結果として「cascadeAbortToChildren が実際に 5 経路から正しい引数で呼ばれること」はテストで保証されず、grep と `bunx tsc --noEmit` のみで検証する。

- 経路が 5 (実体 6 箇所) あり、コピペミス（引数取り違え、呼び忘れ、saveTaskState 前後の順序逆転）の検出が手動レビューに依存する
- 既存パターン（task.ts 純粋関数 + daemon 側配線）では assign_failed 経路は daemon.test.ts 内で `scanTasks` を直接呼び出すパターンが既存しており、コストは低い

**影響**: 軽微（コピペパターンがシンプルで mismatch リスクは限定的）。ただし実装後の動作確認を手動で丁寧に行う必要がある。

### 3. [Minor] cmdAbortTask の loadTasks 二重呼び出し

plan.md §3.3 では cmdAbortTask の「Conductor 不在」「Conductor 有り」の 2 分岐それぞれで `const { tasks } = await loadTasks(PROJECT_ROOT)` を呼ぶ設計になっている。関数冒頭で 1 回だけ `loadTasks` を呼び、`tasks` を両分岐で共有すれば FS アクセスを 1 回に削減できる。

**影響**: 実害なし（CLI コマンドは 1 回実行のみ、FS アクセス数十 ms 程度の差）。最適化レベル。

### 4. [Minor] 関数契約の実装者ドキュメント

`cascadeAbortToChildren` の JSDoc (plan.md §2.2) は挙動を詳述しているが、関数名だけからは「呼び出し側が『親が aborted/deleted に遷移した直後のみ』呼ぶ責務を持つ」という前提が読み取りづらい。誤って closed 経路から呼ぶと ready 子が draft に落ちる。plan.md §5.2 のケース6 コメント (L636-637) にも同じ注記がある。

**推奨**: JSDoc の冒頭 1 行に「**呼び出し側は親が aborted/deleted に遷移した場合のみ呼ぶこと**」と明記するか、関数名を `revertReadyChildrenForAbortedParent` 等へ変更検討。ただし「cascade」は業界慣例で許容範囲なので必須ではない。

## Recommendations

以下は Approved を維持したまま実装時に適用すべき具体的な修正:

1. **plan.md L304 のコード例を修正**: `reason=parent_deleted` → `reason=parent_aborted` に統一（Decision D7 と整合）。実装者はこれに従うこと。

2. **S5 に配線 E2E を 1 ケース追加（任意）**: assign_failed 経路を `scanTasks` 経由で呼び出し、cascade が発動して子 ready → draft になることを確認する統合テストを 1 件だけ追加する。他経路は cmdAbortTask / cmdDeleteTask など CLI 経由なのでテストコストが高いため、pure function テスト + grep 検証を許容（Decision D5 維持）。

3. **cmdAbortTask の loadTasks を関数冒頭で 1 回のみ実行**: 2 分岐の手前で `const { tasks } = await loadTasks(PROJECT_ROOT)` を呼び、両分岐で共有する。§3.3 に反映すること。

4. **`cascadeAbortToChildren` の JSDoc 補強**: 「呼び出し側は親が aborted/deleted に遷移した直後のみ呼ぶこと（cascade 関数内では遷移状態を検証しない）」を冒頭に 1 行明記。

## Checklist 結果

| CRITICAL チェック項目 | 結果 | 備考 |
|---|---|---|
| サブタスクカバレッジ | ✅ | S1 (関数) / S2 (pure test) / S3 (daemon 配線) / S4 (main 配線) / S5 (統合 test) / S6 (doc) / S7 (全体 test) で網羅 |
| 統合テスト/検証 | △ | pure function テストで十分 (D5)。ただし配線 E2E があるとベター（Finding 2 / Recommendation 2） |
| 削除タスクの完全性 | ✅ | 追加型のため該当なし |
| 既存テストへの影響 | ✅ | 回帰テスト（親 closed → 子 assign）が S5 ケース 6 に含まれる |

| T241 固有検証項目 | 結果 | 備考 |
|---|---|---|
| 5 経路すべての cascade 呼び出し | ✅ | CLI 2 + daemon 3 経路、行番号すべて一致 |
| 孫世代 A→B→C で A abort 時 B=ready→draft, C は変化なし | ✅ | S5 ケース 5、仕様通り |
| 循環 depends_on 無限ループ防止 | ✅ | 1 パス走査で O(N)、§6.2 で明記 |
| journal フォーマット `parent_aborted: <parentTaskId>` | ✅ | §2.2、既存 journal は `; ` で連結 |
| ログフォーマット `child_reverted_to_draft parent=<X> child=<Y> reason=parent_aborted` | ✅ | §2.3、D7 で統一（Finding 1 のインライン矛盾に注意） |

## 設計判断の妥当性

- **D1（配置先 task.ts）**: ✅ task.md は「daemon.ts に実装」と示唆していたが、cmdDeleteTask / cmdAbortTask も呼ぶ必要があり共通レイヤーが適切。plan.md の判断は task.md より洗練されている。
- **D3（closed Set 不変更）**: ✅ cascade で子が draft になれば filterExecutableTasks の `status !== "ready"` で弾かれる二重防御。Set を変えると assigned 子の扱いが曖昧になるリスクを回避。
- **D5（E2E スキップ）**: △ トレードオフ妥当（Finding 2）。
- **D6（子 TASK_UPDATED 非送信）**: ✅ file watcher が task-state.json を監視するので最終的に反映。
- **D7（ログ reason 統一）**: ✅ 仕様文との一致を優先。

## 結論

**Approved**。Recommendations 1〜4 を実装時に適用すれば完全に仕様を満たす。Critical findings なし。プラン全体として T241 仕様を正しく解釈し、5 経路カバレッジ・journal/ログフォーマット・孫世代テスト・循環防止・既存正常系の維持をすべて検討している。
