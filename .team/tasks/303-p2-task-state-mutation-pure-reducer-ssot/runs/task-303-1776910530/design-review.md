---
role: design-reviewer
task_id: T303
plan_path: .team/tasks/303-p2-task-state-mutation-pure-reducer-ssot/runs/task-303-1776910530/plan.md
reviewed_at: 2026-04-23
reviewer: task-303-1776910530/reviewer
---

# T303 Design Review: task-state mutation を pure reducer 経由に置換し SSOT を確立する

## 1. 総合判定

**Changes Requested**

理由: 全体構成（書き込み API 一本化 + reducer SSOT + 24h shadow 観測 + Step 8 grep invariant）は妥当だが、SSOT 射程の境界、新規 reducer case の遷移整合性、metadata-only パスの API 設計の 3 点で実装着手前に解決すべき設計上の穴がある。これらは P0 として明示し plan を更新したのち再レビュー希望。残りは P1/P2 の改善提案。

---

## 2. 強み

1. **根本原因の的確な切り分け**
   pure reducer は P1 で導入済みだがあらゆる mutation サイトでバイパスされている、という構造的問題を正確に同定し、「単一の書き込み API に集約」という方向に収束させている。T220 / T302 が「if/else の継ぎ足しでモグラ叩き」になっていた状況からの脱却として筋が良い（CLAUDE.md「構造的正しさを優先」原則と整合）。

2. **mutation サイトの網羅的インベントリ**
   §2.2 / §2.3 / §2.4 で D1〜D7 / M1〜M9 / TS1〜TS3 を行番号付きで列挙。grep の元コマンドも記載しているため再現性がある。レビュー側で `grep -nE 'taskState\[|ts\[[^\]]+\]\s*='` を実走してインベントリと一致することを確認した（差分なし）。

3. **Step 8 の grep invariant**
   実装完了の構造的判定として `grep -n 'taskState\[.*\] =' …` が 0 件、`grep -n 'saveTaskState(' …` が `task.ts` 以外 0 件、という機械的検査を入れているのは強い。レビュー再開・将来のリグレッション検出にも使える。

4. **shadow observer の構造的配線**
   §3.5 で shadow を `applyTaskEvent` の内部に閉じ込めるため「呼び出し側が shadow を意識しなくてよい（配線漏れが構造的に起きない）」を実現できる。P1 で配線漏れ（shadowObserveTask が 0 箇所呼ばれていない）が起きた根本（呼び出し側の責務が分散）を修正する正しい方向。

5. **T302 暫定ガード撤去の合理化**
   `__testApplyAssignCommit` の `assign_skipped_terminal` 分岐を reducer の `ASSIGN_OK` noop に一元化する設計は、コードパス二重化を構造で絶つ良い適用例。`task-fsm.ts:60-66` で `state === "ready"` 以外は noop となる挙動は、T302 ガードと振る舞い等価（terminal 範囲は §4 P1-3 参照）。

6. **TDD 順序とロールバック分離**
   §4 で reducer → action handler → store API → daemon → main → task → T302 ガード撤去 の順を取り、T302 撤去を最終コミットに分離してリスク隔離（§5）。マージ単位として安全。

7. **ドキュメント更新計画**
   §4 Step 9 で 07-state-machine.md §2.2 表 / §2.3 Mermaid / §4 配線表 / §5 段階計画を網羅。CLAUDE.md への不変条件追記（§7）まで含めている。

---

## 3. 指摘事項

### P0-1. 「SSOT 確立」の射程が cross-process race と矛盾している

**該当: §1.1 / §2.3 / §3.4**

§1.1 は「全 task-state mutation を単一の書き込み API に集約」「SSOT を確立」を達成目標としているが、§2.3 で「M4〜M9 は `cmux-team xxx` を起動した時点で新 Node プロセス。daemon 内 mutex では保護できない」と明言し、§3.4 では「daemon 内に閉じた race（例: D3 rollback と D6 assign）は依然脆い」とある。**T220 / T302 が解決対象とした最も重い race（CLI 側の `abort-task` と daemon 側の `assignTask` worktree 作成中の race）は in-process mutex では防げない**。

つまり本タスクの「SSOT」は「daemon プロセス内の SSOT」であり、CLI ↔ daemon 間は依然として「reducer noop（ASSIGN_OK）に頼った観測ベースの吸収」で動いている。これは T302 ガードと意味的に同じであり、構造的解決とは言えない。

**修正方針（どちらかを選んで明示する）:**

- (A) **scope-in 案**: file lock（`proper-lockfile` 等）を本タスクに含める。`task-state.json` への書き込み全経路（CLI / daemon の両方）を file lock で排他化する。これにより本当の SSOT を構築できる。設計ステップ・テスト・リスク欄を追加。
- (B) **scope-out 明示案**: §1.1 のゴール記述を「daemon 内 mutation の SSOT 確立 + reducer noop による cross-process race の構造的吸収」に書き換える。§3.4 末尾に「CLI 経路は新 Node プロセスのため file lock が無いと完全な SSOT は不可能。本タスクは reducer noop で吸収可能なケースに限定し、file lock は別タスク（番号未定）に切り出す。受け入れ条件は『24h 観測で `fsm_shadow_diff` が 0』を以って『reducer noop で吸収できている』証拠とする」を追加する。

現 plan は (B) の意図に近いが、(A) との比較・選択理由が書かれていないため再レビュー時に同じ議論が再発する。**Plan 上で明示的に B を選択した理由（リスク R2 の「観測のみ」と整合）を §1.1 と §3.4 に追記する**ことを必須とする。

### P0-2. `RESUME_REVERT_TO_READY` reducer case と遷移表が不整合

**該当: §3.2**

§3.2 の reducer コード:
```ts
case "RESUME_REVERT_TO_READY": {
  if (state === "assigned" || state === "draft") {
    return withActions("ready", [...]);
  }
  return noop(state);
}
```

一方、同 §3.2 の「07-state-machine.md §2.2 遷移表への追記」:
| event \\ state | `draft` | `ready` | `assigned` | … |
|---|---|---|---|---|
| `RESUME_REVERT_TO_READY` | — | — | `ready` | … |

→ 表は `draft` を `—` (no-op) としているが、コードは `draft → ready` で遷移する。**仕様と実装が同じ §3.2 内で食い違っている**。

実 mutation サイト側を再点検:

| # | サイト | 実 prev status | 期待遷移 |
|---|--------|--------------|---------|
| D1 (revertTaskToReady) | 任意 | 文脈次第（汎用ヘルパ） | 呼び出し側次第 |
| D2 (worktree late check) | `assigned` | assigned → ready |
| D3 (launchConductor failure rollback) | `assigned` | assigned → ready |
| D4 (unmatched / resumeNewSurface) | `assigned` | assigned → ready |
| M1 (unique violation) | `assigned`（resume 候補） | assigned → ready |
| M3 (overflow) | `assigned`（resume plan 末尾） | assigned → ready |

**全サイトで `assigned → ready` のみ**で、`draft → ready` の経路は無い。reducer の guard は `state === "assigned"` だけにすべき。`draft` を含めると本来 `UPDATE_STATUS(to=ready)` で表現されるべき遷移を別 event でも許容してしまい、責務が混ざる。

**修正方針:**

- §3.2 reducer コードから `state === "draft"` を削除し `state === "assigned"` のみにする
- §3.2 末尾の表は現状（draft 列 `—`）のまま
- §3.2 のコメント「draft は noop (overflow 経路でも draft は assign 対象外)」を「assigned のみ受け付け、それ以外は noop」に書き換える

### P0-3. `updateTaskMetadata` API が D5 の race ガードを表現できない

**該当: §3.1（updateTaskMetadata の signature）**

§3.1 で D5 / M2 を metadata-only path として `updateTaskMetadata(projectRoot, taskId, patch)` に流すとあるが、現 D5 (daemon.ts:1498-1535) は以下 3 段の guard を持つ:

1. `cur && conductor.taskRunId && cur.taskRunId && cur.taskRunId !== conductor.taskRunId` → skip + `task_session_update_skipped` ログ（T219 stale guard）
2. `cur && cur.status === "assigned" && cur.sessionId !== message.sessionId` → write
3. それ以外 → silently skip

`updateTaskMetadata(projectRoot, taskId, patch)` という signature では、**この 3 分岐（特に "assigned かつ taskRunId 一致" のみ書き込む）の表現手段が無い**。単純に patch を merge すると、terminal な entry に sessionId が書き戻される / stale taskRunId のまま session_id が上書きされる、といった race セーフティが失われる。

**修正方針（いずれか or 組合せ）:**

- (a) `updateTaskMetadata(projectRoot, taskId, opts: { predicate: (cur) => boolean | "skip-with-log"; patch: (cur) => Partial<TaskState>; logOnSkip?: { event: string; detail: string } })` に拡張する
- (b) D5 専用ヘルパ `updateTaskSessionId(projectRoot, taskId, sessionId, taskRunId)` を作り、内部で predicate + patch を hard-coded する
- (c) `applyTaskEvent` に `SESSION_ID_UPDATE` のような微小 event を新設し reducer 経由で扱う（ただし status 遷移しない event は reducer の責務外で違和感あり）

(b) が最も簡潔で、D5 が単一サイトであることから推奨。Plan §3.1 末尾に D5 を「専用ヘルパで隔離する」旨を明記し、updateTaskMetadata の汎用 API は M2（bulk refresh 削除可否は P1-3 参照）か他用途のためにのみ用意する。

---

### P1-1. `patch` 関数のセマンティクスが曖昧（field 削除をどう表現するか）

**該当: §3.1 / §4 Step 5-3**

§3.1 で `patch?: (prev, next) => Partial<TaskState>` と定義しているが、§4 Step 5-3 で「`patch` 関数で `delete` 相当を返すため、store 側で明示的に `undefined` セット対応を入れる」とある。`Partial<TaskState>` は **「キーを省略する」と「キーを `undefined` にセットする」を区別しない** ため、restart 経路（main.ts:3829-3833 の `delete ts[taskId].assignedAt` 等）の意図を表現できない。

restart 時に削除すべきフィールド: `assignedAt` / `abortedAt` / `worktreePath` / `taskRunId` / `conductorSlot` / `sessionId`。これらが新 entry にゴミとして残ると、後続の resume 判定や dashboard 表示で誤動作する。

**修正方針:**

API 戻り値型を以下のいずれかに変更し §3.1 で明示:
```ts
// 案 A: 全 replace
patch?: (prev, next) => TaskState;

// 案 B: merge / remove を明示
patch?: (prev, next) => { merge?: Partial<TaskState>; remove?: (keyof TaskState)[] };

// 案 C: mutator 関数（in-place 削除を許容）
patch?: (draft: TaskState, next: TaskStatus) => void;
```

restart は 6 フィールド削除と 2 フィールド書き込みの大規模変更なので、案 B か案 C が記述量・安全性の両面で優れる。Plan §3.1 + §4 Step 5-3 にどちらを採るか追記する。

### P1-2. cascade 経由で reverted children の shadow observer が呼ばれない

**該当: §3.3 / §3.5**

`applyTaskEvent` が cascade を実行する場合、cascadeAbortToChildren は子 entry の status を `ready → draft` に直接書き換える（task.ts:708）。**reducer を通らないため、children 側の shadow observer (`PARENT_ABORTED` event) が呼ばれない**。これでは「shadow 配線漏れが構造的に起きない」という §3.5 の主張が崩れる（親遷移の shadow は通るが、cascade で道連れになる子の shadow は欠落）。

**修正方針:**

`applyTaskActions` 側の `cascade_children` action 処理で、対象になった各子 task に対して `taskReduce(child_prev, { type: "PARENT_ABORTED" }, ctx)` を呼んで shadow observer に通すループを追加する。実装としては:

```ts
// apply-task-actions.ts: cascade_children 処理
const { revertedChildren } = cascadeAbortToChildren(state, tasks, taskId);
for (const childId of revertedChildren) {
  await shadowObserveTask(childId, "ready", { type: "PARENT_ABORTED" }, { hasConductor: false, parentAborted: true }, "draft");
}
```

reducer 結果と実 state が一致する設計なので diff は出ない予定だが、不一致が起きれば即検知できる。

### P1-3. M2 bulk refresh 削除の根拠が成立しない

**該当: §5 R6 / §4 Step 5-6**

§5 R6 で「markTaskAborted が applyTaskEvent 経由になれば in-memory state は共有できる（同一 store 内で完結）」とあるが、`applyTaskEvent` は内部で `loadTaskState` を呼ぶ独立トランザクションなので、**main.ts:809 の `taskState` 変数とは別 reference**。markTaskAborted 後に main.ts 側 `taskState` を refresh しないと依然 stale。

主張の根拠を再検討した上で、いずれかに倒す:

- (i) Step 5-6 を削除し、bulk refresh はそのまま残す（最小破壊で実装可能）
- (ii) `applyTaskEvent` の戻り値に「呼び出し直後の最新 state map」を含めるよう拡張し、呼び出し側で in-memory に反映できるようにする
- (iii) main.ts 側の resume ループ全体を `applyTaskEvent` のループに置き換え、呼び出し側 in-memory を持たない構造にする（規模大）

(i) が最小、(iii) が理想。本タスクの粒度では (i) を推奨し、(iii) は別タスク化を提案。§5 R6 を「bulk refresh は当面残す（applyTaskEvent と独立 load のため）」に書き換える。

### P1-4. T302 ガード削除後の `resetConductor` 呼び出し条件が拡大解釈される

**該当: §3.6 After 例**

現 T302 ガード（daemon.ts:2680-2686）は **`isTerminalStatus(currentStatus) === true` の場合のみ** `resetConductor` を呼ぶ。terminal = `closed` / `aborted` / `deleted`。

§3.6 After 例では `if (!result.committed)` で無条件に `resetConductor` を呼んでいる。reducer の `ASSIGN_OK` noop は `state !== "ready"` で発火するため、**`assigned` / `draft` のときも reset が走る**ことになる。

具体ケース:

| prev_status | T302 旧挙動 | After 例の新挙動 | 妥当性 |
|---|---|---|---|
| `closed` / `aborted` / `deleted` | reset | reset | ✓ T302 と等価 |
| `assigned` | – (T302 ではこのケースが起きない前提) | reset | ✗ 他 Conductor の作業を巻き込む可能性 |
| `draft` | – | reset | ✗ そもそも assign 対象外なのに reset するのは過剰 |

scanTasks の logic 上 `prev=assigned` / `prev=draft` で `__testApplyAssignCommit` に到達するケースが本当に無いことを保証する責任が、Plan には書かれていない。仮に scanTasks 側のバグや race で到達した場合、現挙動より悪化する。

**修正方針:**

§3.6 After 例の分岐を以下のように分割:

```ts
if (!result.committed) {
  if (result.prev === "closed" || result.prev === "aborted" || result.prev === "deleted") {
    // T302 旧 terminal race: resetConductor で worktree 巻き戻し
    await log("assign_skipped", `... reason=terminal prev=${result.prev}`);
    await resetConductor(updated, state.projectRoot, state.workspace);
  } else {
    // assigned / draft からの noop（scanTasks のバグ or race）— reset せず警告
    await log("assign_skipped_unexpected", `... prev=${result.prev} (scanTasks selected non-ready)`);
  }
  return { committed: false, reason: "non_ready", currentStatus: result.prev };
}
```

ログイベント名を 2 系統（`assign_skipped` = 旧 terminal, `assign_skipped_unexpected` = 想定外 noop）にすることで、観測性も維持できる。

### P1-5. trace DB insert と task-state mutation の atomicity

**該当: §3.1 / §4 Step 4-2（D7 auto-close）**

D7 (daemon.ts:3152-3180) は `saveTaskState(closed)` 直後に `insertTaskSession(... event:"closed" )` を呼んでいる。M5 (cmdCloseTask, main.ts:3145-3194) も同様。**`applyTaskEvent` 経由になった後、trace DB insert は誰の責務か** が plan で言及されていない。

選択肢:
- (a) trace DB insert は呼び出し側に残す（store の責務外）
- (b) `applyTaskEvent` の opts に `traceDb?: Database` と `traceEvent?: TaskSessionRow` を渡し、store 内で書き込む

(a) を採るなら問題ないが、Plan §3.1 のコメントに「trace DB / 通知系の副作用は呼び出し側に残す」を明記しておく必要がある。さもなくば「全 mutation を store 経由に集約」の文脈で trace 書き込みも store 内に引き込むべきと誤解される。

### P1-6. notifyStateChanged の責務分担と循環依存ポリシー

**該当: §3.1 / §3.4**

`saveTaskState` は task.ts:384-389 で純粋な I/O のみ実行し `notifyStateChanged` を呼んでいない（呼び出し側 daemon.ts:1050 等が `taskStateModified` flag 経由で reduce してから notify するのが現実装）。`applyTaskEvent` 経由になった場合、**1 mutation = 1 notifyStateChanged** が自然だが、Plan §3.1 / §3.4 で notifyStateChanged の呼出責任が言及されていない。

また CLAUDE.md「EventBus ポリシー」で「`logger.ts` は `eventBus.ts` を import してはならない（循環依存禁止）」とあり、`task-state-store.ts` が logger.ts と eventBus.ts の両方を使う場合、循環依存の伝播経路を確認する必要がある（store → logger → eventBus は OK だが、store → eventBus → logger になると詰む）。

**修正方針:**

§3.1 末尾に「`applyTaskEvent` は **mutex 内 save 完了直後に** `notifyStateChanged("task-state-store:applyTaskEvent:...")` を呼ぶ。source 引数で event type と taskId を含める」を明記。`updateTaskMetadata` も同じく内部で notify する。`createTaskEntry` も同じ。

依存方向は `task-state-store → logger / task / state-machine/{shadow,events} / eventBus` の 4 系統で、循環なし。これを §3.1 のファイル冒頭ドキュメントに明示する。

---

### P2-1. event 名 `RESUME_REVERT_TO_READY` の汎用化検討

**該当: §3.2**

reason variant に `unique_violation` / `overflow` を含めているが、event 名の prefix `RESUME_` は resume 経路を連想させる。`overflow` は resume plan 由来とはいえ、`unique_violation` は startup 整合性チェック由来で resume と直交する。`REVERT_TO_READY`（reason variant に `resume_*` / `unique_violation` / `overflow`）の方が semantics が広がっても誤読が少ない。

別 event に分割する案 (`OVERFLOW_REVERT_TO_READY`) と汎用化案 (`REVERT_TO_READY`) のどちらを採るかを §3.2 で比較し、選択理由を記録する。Plan は「reason バリアントに寄せる」を明示しているが、Reviewer としては event 名を `REVERT_TO_READY` に変更することを推奨（`assigned → ready` のみ受け付け、reason で文脈を伝える設計と整合）。

### P2-2. 24h 観測の合格基準を明確化

**該当: §1.1 (4) / §4 Step 10 / §7**

§4 Step 10 で「`grep -c fsm_shadow_diff manager.log` が 0 であることを確認」とあるが、07-state-machine.md §5 では「0 件 (or 設計上の既知差分のみ)」と幅を持たせている。**P1 (T279) の合格基準より P2 (T303) の方が厳しくなる**ことを明示しないと、shadow が出ても「既知差分」で押し切られる懸念。

**修正方針:**

§1.1 (4) もしくは §7「リリース後観測」に以下を追記:

> P2 完了条件は「24h 実稼働で `fsm_shadow_diff` 0 件、`fsm_invariant_violation` 0 件、`fsm_shadow_error` 0 件」。1 件でも diff が出た場合は配線側のバグとして即修正タスクを起票し、本 PR の P2 完了条件は「修正後 24h で 0 件」に書き換えて再観測する。

### P2-3. `assign_skipped_terminal` ログ rename の影響調査

**該当: §4 Step 7**

`grep -rn "assign_skipped_terminal"` で、現状の参照箇所は:

- `skills/cmux-team/manager/daemon.ts:2682` (出力元)
- `skills/cmux-team/manager/daemon.test.ts:5062 / 5068 / 5136 / 5140` (テストと assert)

ダッシュボード / TUI / trace DB / アラートパイプライン側に grep を含めても 0 件で、外部依存はない。Plan §4 Step 7 の「`assign_skipped_terminal` を `assign_skipped` に統一」は **テストの assert 文字列差し替えのみで完結**。Plan §4 Step 7 の影響範囲記述に「外部依存無し（ダッシュボード / 監視・通知系で参照していない）」を追記して安心材料にする。

ただし P1-4 の指摘を採れば `assign_skipped` と `assign_skipped_unexpected` の 2 系統になるので、Step 7 の記述も「`assign_skipped_terminal` → `assign_skipped` に rename + 想定外 noop は `assign_skipped_unexpected` に分離」に書き換える。

### P2-4. mutex 直列化テストの assert を具体化

**該当: §6.1**

「mutex 直列化: 2 並行呼出で順序保証（Promise.all で発行し各結果の `prev`/`next` を見る）」だけでは何を assert するか曖昧。Promise FIFO 連鎖と await semantics の組合せでも、並列発火されたタスクの「どちらが先に走るか」は実装によって変わり得る。

**修正方針（具体例）:**

- 同 task に対する 2 つの `applyTaskEvent({ type: "ASSIGN_OK" })` を Promise.all で同時発火 → 片方は `committed=true, prev="ready", next="assigned"`、もう片方は `committed=false, prev="assigned", next="assigned"` (noop) になることを assert
- 同 task に対する `applyTaskEvent(ABORT)` と `applyTaskEvent(ASSIGN_OK)` を同時発火 → ABORT が先に走った場合は ASSIGN が noop、ASSIGN が先なら ABORT が `assigned → aborted`
- `loadTaskState` を spy して呼出回数 = 2 (各トランザクションで 1 回ずつ独立 load) を assert
- `saveTaskState` を spy して呼出回数 = 1 (noop は save しない) を assert

### P2-5. `createTaskEntry` を `applyTaskEvent` に統合する案を比較

**該当: §3.1 末尾**

「reducer の CREATE event は state 遷移を起こさない log action のみ」を理由に、`createTaskEntry` を別 API として用意する方針だが、**「全 mutation は store 経由」の SSOT 原則からすると、新規 entry 作成も `applyTaskEvent({ type: "CREATE" })` に通すのが一貫する**。reducer 側を以下のように拡張すれば、新規作成でも reducer 経由にできる:

```ts
case "CREATE": {
  // initialStatus を ctx 経由で受け取る
  const initial = (ctx as TaskCtx & { initialStatus?: TaskStatus }).initialStatus ?? "draft";
  return withActions(initial, [{ type: "log", event: "task_created" }]);
}
```

`prev` が `undefined` の場合は store 側で「未存在 → reducer に "draft"（仮の起点）を渡す」ように扱えば、reducer の純粋性は保たれる。

別 API のままでもよいが、§3.1 で「なぜ別 API にしたか」の理由を明記すべき。Reviewer としては統合案を推奨（SSOT 一貫性 + shadow 配線の一元化）。

### P2-6. Step 8 grep invariant に field 個別代入も含める

**該当: §4 Step 8**

`grep -n 'taskState\[.*\] =' …` だけでは、main.ts:3829 の `delete ts[taskId].assignedAt` や `ts[taskId].xxx = yyy` のような **field 個別代入** を検出できない。restart 経路で残る場合がある。

**修正方針:**

Step 8 に以下を追加:

```bash
# 個別 field 代入 / delete も 0 件を確認
grep -nE '(taskState|ts)\[[^\]]+\]\.[a-zA-Z_]+\s*=' skills/cmux-team/manager/{daemon,main}.ts
grep -nE 'delete\s+(taskState|ts)\[[^\]]+\]\.[a-zA-Z_]+' skills/cmux-team/manager/{daemon,main}.ts
```

両方 0 件であることを invariant に含める。

---

## 4. 潜在的リスク（plan で触れられていない）

### LR-1. resume 起動時の I/O コスト増加

現実装の applyRestorePlan は `taskStateModified` flag を立てて末尾で 1 回 saveTaskState を呼ぶ pattern（daemon.ts:1050）。`applyTaskEvent` 経由になると 1 mutation = 1 saveTaskState = 1 tmp + rename になる。resume 候補が多い場合（10 件など）、起動時の disk I/O が 10 倍に。fsync 戦略次第では計測すべきレベル。

**緩和策:**
- 受け入れ条件に「resume 候補 N 件で起動時間が現状比 +X% 以下」を追加
- 必要なら `applyTaskEvent` に「batch モード」（1 トランザクションで複数 event 適用）を追加。ただし complexity が上がるので 24h 観測で問題が出てから導入する別タスク化が無難

### LR-2. `markTaskAborted` の log emit 重複

既存の `markTaskAborted` (task.ts:618) は `task_aborted` ログを emit する。reducer の `ABORT` action も `{ type: "log", event: "task_aborted" }` を返す。両方が `applyTaskActions` 経由で動くと **`task_aborted` が 2 回出る**。Plan §3.7 で「extraLogFields を載せるための wrapper log だけに縮小」とあるが、`task_aborted` 本体ログを「reducer 由来 (cascade なし) と markTaskAborted 由来 (extra fields 付き)」のどちらが残すか曖昧。

**修正方針:**
- reducer の `ABORT` action を `task_aborted_core` ぐらいにリネーム（または log action を返さず、呼び出し側で必ず log を emit する責任にする）
- markTaskAborted は wrapper として `task_aborted` (extraLogFields 含む) を出す
- これを §3.7 末尾に明記

### LR-3. `taskStateModified` flag を残すと grep invariant に引っかかる

Step 8 で `taskState[…] = …` が 0 件になることを保証するなら、`taskStateModified = true` を立てている箇所（daemon.ts:986, 1021, 1041 / main.ts:849, 906）も削除する必要がある。Plan §4 Step 4 / Step 5 で個別 mutation の置換を述べているが、**flag 自体の削除と末尾 `if (taskStateModified) saveTaskState(...)` の削除**が抜けている。

**修正方針:**
- §4 Step 4-3 末尾に「`taskStateModified` flag 一式と `if (taskStateModified) saveTaskState` を削除」を追記
- §4 Step 5-5 末尾にも同様の追記（main.ts:973-975）

### LR-4. T279 で Conductor 側 P2 へ進む際の干渉

§1.3 で Conductor 側 reducer の P2 置換は scope 外としているが、本タスクで `apply-task-actions.ts` を新設する際、**Conductor 側 action handler の足場と整合する設計**にしておかないと、後続タスクで二重実装になる。

**修正方針:**
- §3.3 で `applyTaskActions` のディレクトリ配置とインターフェースが、将来 Conductor 側 `applyConductorActions` を追加するときに対称性を持つことを明記する
- 具体的には: `state-machine/apply-task-actions.ts` ↔ `state-machine/apply-conductor-actions.ts`、両者を同じ `state-machine/apply-actions.ts` index から re-export する設計

### LR-5. `__testApplyAssignCommit` export の処遇

T302 ガード削除後、`__testApplyAssignCommit` は applyTaskEvent への薄いラッパに退化する。export を残す価値（worktree 作成抜きで race 分岐だけテストする目的）はなくなる。Plan §4 Step 7 で言及がない。

**修正方針:**
- §4 Step 7 に「`__testApplyAssignCommit` の export を削除し、関連テストを `task-state-store.test.ts` に移動」を追記
- 旧 daemon.test.ts:5062-5140 のテストケースは store 側のテストとして書き直す（既に Step 7 で示唆されているが export 削除の明示が抜けている）

---

## 5. Recommendations（Planner 再編集用）

優先度順。各項目は plan のセクション参照込みで具体化済み。

### 必須修正 (P0)

- **R1.** §1.1 と §3.4 で「SSOT」の射程が daemon プロセス内に閉じることを明示し、CLI ↔ daemon の cross-process race は (B) reducer noop 吸収案で対処することと、その選択理由を追記する。file lock を別タスクに切り出す前提も明記。
- **R2.** §3.2 reducer `RESUME_REVERT_TO_READY` case の guard を `state === "assigned"` のみに修正し、コードと表の整合を取る（draft / ready / terminal はすべて noop）。
- **R3.** §3.1 で D5 専用ヘルパ `updateTaskSessionId(projectRoot, taskId, sessionId, taskRunId)` を分離し、内部に `assigned` ガードと `taskRunId` mismatch ガードを hard-code する。`updateTaskMetadata` は M2 等の汎用 path に限定する。

### 重要修正 (P1)

- **R4.** §3.1 `patch` の signature を `(prev, next) => { merge?: Partial<TaskState>; remove?: (keyof TaskState)[] }` または mutator 関数 `(draft, next) => void` に変更し、restart の field 削除を表現可能にする。
- **R5.** §3.5 / §3.3 cascade 経由で reverted children に対しても `shadowObserveTask(childId, "ready", PARENT_ABORTED, …, "draft")` を呼ぶ実装を `apply-task-actions.ts` 側に明記する。
- **R6.** §5 R6 の「bulk refresh 削除可能」主張を撤回し、「bulk refresh は当面残す（applyTaskEvent と独立 load のため stale 解消が必要）」に書き換える。Step 5-6 を削除。
- **R7.** §3.6 After 例の `if (!result.committed)` 分岐を terminal vs unexpected non_ready で 2 系統に分割し、ログイベントを `assign_skipped` / `assign_skipped_unexpected` に分ける。
- **R8.** §3.1 末尾に「trace DB insert / postMessage 等の副作用は呼び出し側に残す」を明記し、責務境界を明確化する。
- **R9.** §3.1 末尾に「`applyTaskEvent` / `updateTaskMetadata` / `createTaskEntry` は内部で `notifyStateChanged(source)` を呼ぶ」と「依存方向は `task-state-store → {logger, task, state-machine, eventBus}` で循環なし」を明記する。

### 改善 (P2)

- **R10.** §3.2 で event 名 `RESUME_REVERT_TO_READY` と `REVERT_TO_READY` の比較を行い、後者を選択（reason variant で文脈を伝える設計と整合）。
- **R11.** §1.1 (4) または §7 に「P2 完了条件 = 24h 実稼働で `fsm_shadow_diff` / `fsm_invariant_violation` / `fsm_shadow_error` がいずれも 0 件」を追記。
- **R12.** §4 Step 7 を「`assign_skipped_terminal` → `assign_skipped`（terminal）と `assign_skipped_unexpected`（想定外 noop）に分離。外部依存無し（事前 grep 済）」に書き換える。
- **R13.** §6.1 mutex 直列化テストの具体的 assert 内容（committed の片方 true / 片方 false、loadTaskState 呼出回数、saveTaskState 呼出回数）を追記する。
- **R14.** §3.1 末尾で `createTaskEntry` を `applyTaskEvent({ type: "CREATE", initialStatus })` に統合する案と現案（別 API）を比較し、選択理由を記録する。Reviewer としては統合案を推奨。
- **R15.** §4 Step 8 の grep invariant に「field 個別代入 / 個別 delete」も追加する（具体的 grep コマンドを記述）。
- **R16.** §4 Step 4-3 / Step 5-5 末尾に「`taskStateModified` flag 一式と末尾 `if (taskStateModified) saveTaskState` の削除」を追記する。
- **R17.** §3.7 / §3.3 で reducer `ABORT` の log action と markTaskAborted の log emit が重複しないよう、どちらが `task_aborted` を出すか責務を明示する。
- **R18.** §4 Step 7 に「`__testApplyAssignCommit` の export 削除と daemon.test.ts:5062-5140 のテストを `task-state-store.test.ts` に移動」を追記する。
- **R19.** §3.3 で `apply-task-actions.ts` の配置・命名を、将来 Conductor 側 `apply-conductor-actions.ts` と対称になるように設計する旨を明記する。

---

## 付録: レビュー時の裏取りメモ

- `grep -nE 'taskState\[|ts\[[^\]]+\]\s*=' skills/cmux-team/manager/{daemon,main,task}.ts` を実走、Plan §2.2 / §2.3 / §2.4 のインベントリと一致を確認（差分なし）。
- `grep -n shadowObserveTask skills/cmux-team/manager/{daemon,main,task}.ts` → 0 件（Plan §2.1 の主張通り、Task 側 shadow 配線は実質未完了）。
- `grep -rn "assign_skipped_terminal" .` → daemon.ts:2682 (出力元) + daemon.test.ts 4 箇所のみ。外部依存なし（Plan §4 Step 7 の rename は安全）。
- `task-fsm.ts:60-66` の `ASSIGN_OK` case を確認、`state === "ready"` のみ assigned に遷移、それ以外は noop（Plan §2.5 の主張通り）。
- D5 (daemon.ts:1498-1535) を実コードで確認、3 段ガード（taskRunId mismatch skip / assigned + sessionId 差分で write / それ以外 silent skip）を持ち、Plan §3.1 の `updateTaskMetadata(projectRoot, taskId, patch)` 単純 signature では表現不可（P0-3 の根拠）。
