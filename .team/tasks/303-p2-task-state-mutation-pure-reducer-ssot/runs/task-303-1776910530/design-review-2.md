---
role: design-reviewer
task_id: T303
plan_path: .team/tasks/303-p2-task-state-mutation-pure-reducer-ssot/runs/task-303-1776910530/plan.md
reviewed_at: 2026-04-23
reviewer: task-303-1776910530/reviewer-2
previous_review: design-review.md
---

# T303 Design Review (rev2): task-state mutation を pure reducer 経由に置換し SSOT を確立する

## 1. 総合判定

**Approved**

理由: 前回 Changes Requested で挙げた P0 (R1/R2/R3) および P1 (R4〜R9) がすべて plan に反映されており、P2 (R10〜R19) も漏れなく取り込まれている。各指摘に対して「反映方法」だけでなく「選択理由」まで記述されているため、実装フェーズで設計の揺り戻しが起きにくい。rev1 で懸念された「局所的な if/else の継ぎ足しでモグラ叩き」の構造は解消され、CLAUDE.md「構造的正しさを優先」原則と整合する設計になっている。

実装に進んで良い。以下 §5 に軽微な「実装時の注意点」を記載するが、これらは plan の修正を要求するものではない。

---

## 2. P0 反映状況

### R1. SSOT 射程の明示化（§1.1 / §3.4）

**反映済み** — §1.1 の blockquote「SSOT の射程について (R1 反映)」で「daemon プロセス内の SSOT」であることを明言し、(B) 案（reducer noop による観測的吸収）を選択。選択理由として「T220 / T302 で既に観測された race は `ASSIGN_OK` noop で吸収できる」「file lock は 24h 観測後に判断」を具体化している。§3.4 では「なぜ (A) file lock を本タスクに含めないか」の 4 項目（T302 実績 / 変更範囲 / 24h 観測充足性 / 優先度判断根拠）を追記。§1.3 でも別タスク化を明記。

再レビュー時に「A vs B」の議論を蒸し返す余地はなくなった。

### R2. `REVERT_TO_READY` reducer guard 是正（§3.2）

**反映済み** — reducer case は `state === "assigned"` のみに絞られ、draft / ready / terminal は全て noop。event 名が `RESUME_REVERT_TO_READY` → `REVERT_TO_READY` に改名（R10 採用）され、遷移表も `draft=— / ready=— / assigned=ready / 3 terminal=—` で一致。コードと表が完全整合。§2.2 / §2.3 の確認表で「D1〜D4 / M1 / M3 の実 prev status は全て assigned」を再確認済み。

### R3. D5 専用ヘルパ `updateTaskSessionId` の分離（§3.1）

**反映済み** — `updateTaskSessionId(projectRoot, taskId, sessionId, taskRunId)` として独立 API 化。内部に 3 段 guard（taskRunId mismatch / status=assigned + sessionId 差分 / silent skip）を hard-code する設計。戻り値型 `{ written: boolean; reason?: "taskrun_mismatch" | "not_assigned" | "unchanged" }` で各分岐を観測可能にしている。`updateTaskMetadata` の汎用 signature は YAGNI 判断で後回し。§1.3 / §2.2 補足 / §3.1 / §4 Step 4-4 / §7 受け入れ条件と一貫している。

---

## 3. P1 反映状況

### R4. `patch` signature の拡張（§3.1 / §4 Step 5-3）

**反映済み** — `TaskStatePatch = { merge?: Partial<TaskState>; remove?: (keyof TaskState)[] }` に変更。restart 経路（M6〜M8）の 6 フィールド削除 + 2 フィールド書き込みを `{ merge: { status, journal }, remove: [...6 fields] }` で明示表現する例が §4 Step 5-3 にある。§6.3 E2E-6 で on-disk から対象 key が削除されることを手動検証する項目も追加済み。

### R5. cascade 子の shadow observer 呼出（§3.3 / §3.5）

**反映済み** — `apply-task-actions.ts` の `cascade_children` handler 内で `for (const childId of revertedChildIds) await shadowObserveTask(childId, "ready", PARENT_ABORTED, childCtx, "draft")` の loop を明示。§3.5 で「cascade 子の shadow も apply-task-actions.ts 側で一元化」と宣言。§6.1 apply-task-actions.test.ts の「cascade 対象の各 childId に対して shadowObserveTask が呼ばれる」assert で構造的検証を担保。

### R6. bulk refresh 主張の撤回（§3.8 / §5 R6）

**反映済み** — §3.8 で「applyTaskEvent は独立トランザクションなので main.ts:809 の taskState 変数とは別 reference」と技術的根拠を明記し、bulk refresh (M2) は当面残す方針に転換。Step 5-6 は削除。§5 R6 のリスク欄も同内容に書き換え済み。

### R7. `resetConductor` 条件分岐の分割（§3.6）

**反映済み** — After 例が `result.prev in {closed, aborted, deleted}` → `assign_skipped` + resetConductor、それ以外 (`assigned` / `draft`) → `assign_skipped_unexpected` + reset なし、の 2 系統に分離。`|` 縦棒表で妥当性根拠（他 Conductor 巻き込み防止 / 過剰 reset 回避）を示している。

### R8. trace DB 責務の明示（§3.1）

**反映済み** — `applyTaskEvent` docstring の「責務境界（呼び出し側に残す副作用 — R8 反映）」で trace DB insert / cmux send / postMessage / resetConductor を列挙。store が task-state のみ担当し、副作用は呼び出し側に残すという境界が明文化された。

### R9. `notifyStateChanged` 明示 + 循環依存の確認（§3.1）

**反映済み** — 依存方向を `task-state-store → { logger, task, state-machine, eventBus }` の一方向で明示。`logger.ts` が `eventBus.ts` を import しない既存ポリシー（CLAUDE.md）と矛盾しないことを確認済み。`applyTaskEvent` / `updateTaskSessionId` / CREATE 内部で `notifyStateChanged("task-state-store:applyTaskEvent:<event.type>:<taskId>")` を呼ぶ旨が docstring と §6.1 テストの両方で固定化されている。

---

## 4. 新たな指摘事項

以下はいずれも **plan の修正を要求するものではない**（承認判定に影響しない）。実装時の参考として記録する。

### P2-A. §3.1 docstring と §3.3 の cascade タイミング記述の整合性（軽微）

**該当: §3.1 docstring / §3.3**

§3.1 docstring step 1 に「load → reduce → (patch merge/remove) → save → shadow → notifyStateChanged」とあり、その下 step 3 で「action の cascade_children を apply-task-actions 経由で実行」と書かれているが、§3.3 末尾は「`applyTaskEvent` 内で mutex を取ったまま cascade を実行し、**最後に saveTaskState で一括書き込みする（二重書き込みしない）**」となっている。

実際の正しい順序（cascade in-place mutation が save 前に完了する必要がある）を §3.1 docstring も反映すべき:

```
mutex 内: load → reduce → patch merge/remove → cascade_children (in-place) → save
       → shadow (親) → cascade 子 shadow → notifyStateChanged
```

実装時に気づけば直せるレベル（docstring の文言調整のみ）なので plan 修正は不要。ただし Step 3 の task-state-store.test.ts で「cascade_children action は state に子の draft 書き込みが入り、saveTaskState 後の on-disk に反映」を assert する際に順序が重要になるので、実装者は注意すること。

### P2-B. `taskReduceForCreate` ヘルパ名の使用不整合（軽微）

**該当: §3.1 CREATE 統合の選択理由 (c)**

選択理由 (c) で「store 側で仮の `"draft"` を渡すヘルパ（`taskReduceForCreate(initialStatus)`）で吸収可能」とヘルパ名が登場するが、直後の store 側実装コード例では `taskReduce("draft", input.event, { ...ctx, initialStatus })` を直接呼んでいてヘルパを使っていない。

実装時はどちらか一方に揃える（ヘルパ化するか、直接呼び出しなら文言から `taskReduceForCreate` を落とす）。plan 修正は不要。

### P2-C. CREATE reducer log と CLI 側 log の重複可能性（軽微）

**該当: §3.2 / §3.7 の R17 パターン延長**

R17 で ABORT は reducer log (`task_aborted_core`) と wrapper log (`task_aborted`) に分離する設計を採った。CREATE も reducer 側で `{ type: "log", event: "task_created" }` を返す方針だが、既存 `cmdCreateTask` / `createTaskProgrammatic` が task_created 相当のログを別途出していた場合、**二重 emit の懸念が ABORT と同じ構造で存在する**。

実装時に grep:

```bash
grep -nE 'log\([^)]*"task_created"' skills/cmux-team/manager/{main,task,daemon}.ts
```

重複があれば:
- CLI 側 log を残して reducer 側を `task_created_core` にリネーム、または
- reducer 側 log のみに統一して CLI 側から削除

plan §3.2 / §3.7 で ABORT についてのみ言及しているので、実装時に CREATE も同じ判断基準で扱うこと。現状の plan で明示的な宣言は不要。

### P2-D. Step 4.1 (D6 書き換え) と Step 7 (__testApplyAssignCommit export 削除) の間の test 一時的失敗（情報）

**該当: §4 Step 4 / §4 Step 7**

Step 4.1 で D6 を `applyTaskEvent` 経由に書き換えた時点で、旧 `__testApplyAssignCommit` の内部実装は applyTaskEvent のラッパに退化する。現 `daemon.test.ts:5062-5140` は `__testApplyAssignCommit` を直接呼んで terminal race を検証しているため、Step 4.1 直後は:

- (A) 既存テストの assert（`assign_skipped_terminal` 文字列 / 直接 mutation 検証）が通らなくなる
- (B) Step 7 で task-state-store.test.ts に移設されるまで test failure が継続

plan §4 は「各 step で `bun test` pass を確認してから次へ」としているので、**Step 4.1 と同時に daemon.test.ts の該当ケースを task-state-store.test.ts 側に移設する**か、または **Step 4.1 → Step 7 の間で該当テストを一時 skip する運用**のどちらかが必要。

実装上どちらでも問題ないが、plan の文言は「Step 7 で移設」となっているため、Step 4 内で一時 skip → Step 7 で移設完了、が自然。plan §4 Step 7 の記述で十分カバーされているので plan 修正は不要。

### P2-E. `applyTaskEvent` 内で `loadTasks` を追加で呼ぶコストの確認（情報）

**該当: §3.3 cascade_children 処理**

`apply-task-actions.ts:cascade_children` handler は `const tasks = await loadTasks(context.projectRoot)` を毎回呼ぶ。cascade が発生するのは `ABORT` / `DELETE` の一部（依存タスクあり時）のみで頻度は低いが、mutex を保持したまま `loadTasks`（全タスク .md ファイル read）を実行するため、タスク数が多い環境では mutex 滞留時間が伸びる。

現状の cascade 実装（task.ts:cascadeAbortToChildren）は既に loadTasks を呼んでいるので **新規コスト増ではない**。ただし mutex 内で長時間 I/O が発生することは §5 R1 のデッドロック緩和方針（「mutex 内では重い処理をしない」）と若干矛盾する。

緩和策として: `applyTaskEvent` の呼び出し側（daemon.ts / main.ts）で先に `loadTasks` を済ませて `context` に渡せば mutex 内の I/O を減らせるが、構造が複雑化する。**実稼働で mutex 待ち時間が問題にならないことを §6.3 E2E で確認**する運用で十分。plan §6.3 に項目追加を検討する価値はあるが、必須ではない。

### P2-F. `state` 参照と `cascadeAbortToChildrenInPlace` の mutation 責務（情報）

**該当: §3.3 ApplyTaskActionsContext**

`ApplyTaskActionsContext.state: TaskStateMap` のコメント「saveTaskState 後の最新 in-memory state」は、P2-A で指摘した通り実際には **save 前の in-memory state**（cascade の in-place 書き込みがここに入り、後続の saveTaskState で一括 flush される）。コメント文言を「save 前の mutation buffer」に直すと混乱が減る。実装時の polish 対象。

---

## 5. Recommendations（実装時の注意点）

判定は Approved なので、以下は plan 修正要求ではなく実装中の留意事項。

### 最優先

1. **§3.1 docstring の順序記述を実装時に修正**（P2-A）
   実装者が task-state-store.ts の JSDoc を書くとき、cascade → save の順序を正確に反映する。テストで順序を固定するとなお良い。

2. **CREATE log の重複チェック**（P2-C）
   実装前に `grep -nE 'log\([^)]*"task_created"' skills/cmux-team/manager/{main,task,daemon}.ts` で既存の `task_created` emit を確認し、重複すれば R17 と同じ方針で分離する。

### Step-by-step 実装時

3. **Step 4.1 の D6 書き換えで daemon.test.ts が壊れる**（P2-D）
   Step 4.1 と同じコミットで旧 `__testApplyAssignCommit` 系テストを task-state-store.test.ts に移設するか、`test.skip` で一時 skip して Step 7 でまとめて移設。どちらにしても「Step 4.1 終了時点で `bun test` pass」を維持すること。

4. **mutex 滞留時間の計測**（P2-E）
   §6.3 E2E で cascade 発生ケース（親 abort で子 3 件 revert 等）を実行する際に、mutex 保持時間が数百 ms を超えないことを軽く確認する。問題が出たら別タスクで loadTasks キャッシュを検討。

### Polish

5. **`taskReduceForCreate` の扱い統一**（P2-B）
   実装時に `taskReduce("draft", ...)` 直接呼び出しで済ますなら、§3.1 選択理由 (c) の `taskReduceForCreate(initialStatus)` という名前は実装コメントに残さない。

6. **`ApplyTaskActionsContext.state` コメント修正**（P2-F）
   「saveTaskState 後の最新」→「save 前の mutation buffer」に修正。

### 24h 観測

7. **R11 の厳格化条件を遵守**
   `fsm_shadow_diff` / `fsm_invariant_violation` / `fsm_shadow_error` のいずれか 1 件でも出たら PR を止めて調査。plan §7 で「修正後 24h で 0 件」に書き換える運用が明記されているので、その通り運用する。

---

## 付録: rev2 全体評価

- P0 (3 件): 全反映 ✓
- P1 (6 件: R4〜R9): 全反映 ✓
- P2 (10 件: R10〜R19): 全反映 ✓
- 新規指摘: 6 件（P2-A〜P2-F）全て軽微、plan 修正不要

rev1 → rev2 で plan の「選択理由」密度が大幅に増し、後続レビュー・実装時の判断材料が揃った。「SSOT 射程」「D5 専用ヘルパ」「patch signature」「log emit 責務」「cascade 子 shadow」「bulk refresh 撤回」など、設計の輪郭がシャープになっている。実装フェーズに進んで問題ない。
