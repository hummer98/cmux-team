# T398 実装計画 — run_after_all lock guard 追加

> Planner: surface (this run) / 2026-04-30 / for run `task-398-1777552095`
> 前提: T397 (`filterRunAfterAllTasks` の `normalActive` を executable ベースへ) が main にマージ済み。

## 1. 修正方針サマリー

`scanTasks` の **既存 Exclusive lock guard の直後** に、新しい `run_after_all lock guard` を挿入する。動作は「`runAfterAll && !exclusive` なタスクが assigned の間、normal タスク (`executable`) は dispatch せず、他の run_after_all (`runAfterAllExecutable`) は通す」。`return` ではなく **`dispatchTargets` を `runAfterAllExecutable` に絞り込む**ことで、`for (const task of …)` ループの構造を維持しつつ並走を実現する。log event 名は `run_after_all_lock_active`、command emit 形式は exclusive と揃える。

## 2. コード変更詳細

### 2.1 `skills/cmux-team/manager/daemon.ts`

**現状 (関連部分)**:

```ts
// 2937-2948
const executable             = sortByPriority(filterExecutableTasks(openTasksList, closed, assignedIds));
const runAfterAllExecutable  = sortByPriority(filterRunAfterAllTasks(openTasksList, closed, assignedIds));
const allExecutable          = [...executable, ...runAfterAllExecutable];
state.pendingTasks           = allExecutable.length;

// 2987-3012  throttle guard (allExecutable ベース)  — そのまま
// 3014-3028  Exclusive lock guard (allExecutable ベース)  — そのまま
// 3030-…     for (const task of allExecutable) { dispatch }
```

**変更**:

(a) `for` ループのイテレート対象を `allExecutable` から `dispatchTargets` 変数に置き換える。デフォルトは `allExecutable`、guard が立った場合のみ `runAfterAllExecutable` に縮める。

(b) Exclusive lock guard (3014-3028) 直後に以下を挿入:

```ts
// === run_after_all lock ガード (T398) ===
// runAfterAll: true && !exclusive のタスクが assigned の間、normal タスクの新規 assignment を停止する。
// 他の run_after_all は並走可能（単独実行を保証したい場合は --exclusive を使う）。
// 評価順序: exclusive lock guard が先に return しているため、ここに到達した時点で
//           exclusive な assigned は存在しない。defense-in-depth で `!t.exclusive` を付ける。
const assignedRunAfterAllTaskIds = new Set(
  tasks.filter((t) => t.runAfterAll && !t.exclusive && assignedIds.has(t.id)).map((t) => t.id),
);
let dispatchTargets = allExecutable;
if (assignedRunAfterAllTaskIds.size > 0 && executable.length > 0) {
  await log(
    "run_after_all_lock_active",
    `task_ids=${[...assignedRunAfterAllTaskIds].join(",")} pending_normal=${executable.length}`,
  );
  dispatchTargets = runAfterAllExecutable;
}

for (const task of dispatchTargets) { … }
```

#### 採用判断

| 案 | 採否 | 理由 |
|---|---|---|
| (i) guard ヒット時に `return` | 不採用 | 「他の run_after_all は通す」の semantics を壊す。現状 `filterRunAfterAllTasks` の不変条件（normal active なら空を返す）に依存して結果的に等価になるが、将来この不変条件が変わったときに silent regress する。 |
| (ii) `dispatchTargets` 切替（**採用**） | 採用 | 不変条件に依存せず、コードを読んだだけで意図が伝わる。差分も最小（変数 1 つと if 文のみ）。 |
| (iii) `allExecutable` 自体を再構築 | 不採用 | `state.pendingTasks` への影響を考えると混乱を招く。`pendingTasks` は表示用なので「待機中の総数」を維持するのが自然。 |

#### guard の評価順序

1. throttle (5h utilization)
2. exclusive lock — `assigned exclusive > 0 && allExecutable > 0` で **全停止 return**
3. **run_after_all lock (新設)** — `assigned RAA(non-exclusive) > 0 && executable > 0` で **normal のみ抑止、RAA は通す**
4. dispatch ループ

> exclusive ⇒ runAfterAll=true (`parseTaskMeta` で強制) なので、exclusive な assigned は集合的には RAA でもある。しかし exclusive guard が先に return するため、新設 guard は決して exclusive をキャッチしない。`!t.exclusive` フィルタは「コードを単独で読んだ際の説明性」のための冗長性。

#### 既存挙動との互換性チェック

| シナリオ | 期待 | 説明 |
|---|---|---|
| 通常 ready のみ | normal 全部 dispatch | `assignedRAA = ∅` → guard skip、`dispatchTargets = allExecutable = executable` |
| RAA ready のみ (drain 完了後) | RAA dispatch | `assignedRAA = ∅` (まだ assign されていない) → guard skip、ループで RAA を assign |
| RAA assigned + normal が新規 ready 化 (本タスクの新挙動) | normal は wait、ログ `run_after_all_lock_active` | `assignedRAA > 0 && executable > 0` → `dispatchTargets = runAfterAllExecutable = [] (∵ normalActive>0)` |
| RAA assigned + 別 RAA ready (drain 後 並走) | 別 RAA dispatch | `assignedRAA > 0 && executable = 0` → guard skip、`dispatchTargets = allExecutable = runAfterAllExecutable` |
| Exclusive assigned + 何でも | 全停止 | exclusive guard で先に return |

### 2.2 既存 import / 型変更

不要。`tasks` は既に scope 内、`assignedIds` も既存。`runAfterAll` / `exclusive` プロパティは `TaskMeta` に存在 (`task.ts:17`)。

### 2.3 副次変更

- 既存コメント（`run_after_all タスクの判定` 等）は変更しない。新 guard ブロック内のコメントだけで T398 の意図を完結させる。
- `log` event 名は `run_after_all_lock_active`。formatter は `task_ids=… pending_normal=…` で exclusive 系 (`task_ids=… pending=…`) と揃えつつ、normal 限定であることを明示するため `pending_normal` を採用（exclusive は normal+RAA を等しく止めるが、本 guard は normal のみ止めるため意味が違う）。

## 3. テスト戦略

### 3.1 ファイル配置

| ファイル | 種別 | 追加内容 |
|---|---|---|
| `skills/cmux-team/manager/task.test.ts` | 単体 | 既存 `describe("filterRunAfterAllTasks")` は **触らない**。本タスクの guard は `scanTasks` 側にあり、`filterRunAfterAllTasks` の signature/挙動は不変。 |
| **新規** `skills/cmux-team/manager/daemon-run-after-all-lock.test.ts` | 統合 | `scanTasks` を直接呼ぶ統合テスト。完了条件のコマンド `bun test … task.test.ts daemon-*.test.ts` の `daemon-*.test.ts` glob にマッチさせる。 |

> 既存 `daemon.test.ts` ではなく `daemon-run-after-all-lock.test.ts` を新設する理由:
> (a) 完了条件の glob `daemon-*.test.ts` が空マッチしないようにする
> (b) `daemon.test.ts` は 6000 行超で見通しが悪く、新機能の文脈を独立ファイルに切り出した方が後追いしやすい
> (c) `createTask` ヘルパー相当を新ファイルにコピペすると重複するため、`daemon.test.ts` から `createTask` をエクスポートするか、新ファイルにも独自ヘルパーを置く。**前者を採用** （`daemon.test.ts` 末尾に `export { createTask, closeTask }` を追加）

### 3.2 ヘルパー拡張

`createTask` (現状 `daemon.test.ts:29`) に `runAfterAll` / `exclusive` 対応を追加する:

```ts
async function createTask(
  id: string,
  slug: string,
  opts: {
    status?: string; priority?: string; dependsOn?: string[];
    content?: string; createdAt?: string;
    runAfterAll?: boolean; exclusive?: boolean;  // ← 新規
  } = {}
): Promise<void> {
  // … 既存処理 …
  if (opts.runAfterAll) yaml += `\nrun_after_all: true`;
  if (opts.exclusive)   yaml += `\nexclusive: true`;
  // …
}
```

`exclusive: true` なら `parseTaskMeta` が `runAfterAll=true` を強制するので、frontmatter の冗長記載は不要。

### 3.3 新規テストケース

新ファイル `daemon-run-after-all-lock.test.ts` の `describe("scanTasks: run_after_all lock guard (T398)")` 内:

| # | テスト名 | シナリオ | 期待 |
|---|---|---|---|
| **TC1** | `RAA assigned 中、新規 ready 化された normal は dispatch されない` | RAA タスク `R` を assigned 状態にセット (taskState で assigned + assignedIds に追加)、normal `N` を ready で作成、idle Conductor 1 つ | `scanTasks` 後: `N.status === "ready"` のまま、Conductor は idle、manager.log に `run_after_all_lock_active task_ids=R pending_normal=1` |
| **TC2** | `RAA assigned 中でも、他の ready RAA は dispatch される（並走可）` | RAA `R1` assigned、RAA `R2` ready、idle Conductor 1、normal は無し | `scanTasks` 後: `R2.status === "assigned"`、Conductor が `R2` を取得、log に `run_after_all_lock_active` は出ない（executable=0 で guard skip） |
| **TC3** | `T397 + T398: draft → ready 化後も並走しないこと` | RAA `R` assigned、`N` (normal, dependsOn: ["X"]) が ready、`X` は draft。次に `X` を ready 化（外部から`saveTaskState`で書き換え）、もう一度 `scanTasks`。 | 1 回目: `N` は dep 未解決なので executable=0、guard skip、何も dispatch されない（既存 T397 範囲）。 `X` を ready 化 → 2 回目: `X` は executable、guard が `task_ids=R pending_normal=1` を log、`X.status === "ready"` のまま、`R` は assigned 維持 |
| **TC4** | `--exclusive の単独実行 semantics は変わらない (regression)` | exclusive `E` assigned、normal `N` ready、RAA `R` ready、idle Conductor 1 | exclusive guard が先に return → `E` のみ assigned のまま、`N` も `R` も dispatch されない、log は `exclusive_lock_active` のみ |
| **TC5** | `RAA assigned 中、normal も RAA も無しなら何も起きない (no-op regression)` | RAA `R` assigned のみ、ready タスクなし | `scanTasks` 後: state 不変、`run_after_all_lock_active` ログも出ない (`executable=0` で guard skip) |

> assigned 状態の作り込みは、`createTask(..., { status: "assigned" })` + `state.conductors.set(...)` で `taskId` をセット、を組み合わせる。`fakeConductor.taskId = "R"` で `assignedIds` に拾われる（`scanTasks:2933` 参照）。

### 3.4 既存テスト確認

`task.test.ts` の `describe("filterRunAfterAllTasks")` (391-464) は影響なし。`daemon.test.ts` 内の throttle / exclusive 系テストは挿入位置が後段なので影響なし。`bun test` 緑を確認するファイル:

```bash
cd skills/cmux-team/manager
bun test --timeout 30000 task.test.ts daemon-run-after-all-lock.test.ts daemon.test.ts
```

完了条件のコマンド (`daemon-*.test.ts` glob) は `daemon-run-after-all-lock.test.ts` をマッチさせる。`daemon.test.ts` は **glob にハイフンが必須なのでマッチしない**ため、追加でフルパス指定する。

## 4. ドキュメント更新方針

### 4.1 `docs/spec/07-state-machine.md`

現状 run_after_all / exclusive の専用節は **存在しない** (grep 結果、唯一の references は `2.4 cascade` 等)。新節を追加する:

```markdown
## 6. dispatch ガード (run_after_all / exclusive)

`scanTasks` のタスク dispatch ループに先立ち、3 段階のガードが評価される。

### 6.1 throttle (5h utilization)

… (既存)

### 6.2 Exclusive lock

| 条件 | 効果 |
|---|---|
| `exclusive: true` のタスクが `assigned` | 全 `executable` + `runAfterAllExecutable` の dispatch を停止 |

`exclusive` は `parseTaskMeta` で `runAfterAll=true` を暗黙包含する。
log event: `exclusive_lock_active task_ids=… pending=…`

### 6.3 run_after_all lock (T398)

| 条件 | 効果 |
|---|---|
| `runAfterAll: true && !exclusive` のタスクが `assigned`、かつ `executable.length > 0` | `executable` (normal) のみ dispatch を停止。`runAfterAllExecutable` (他の RAA) は通す。 |

T397 で `filterRunAfterAllTasks` の `normalActive` を executable ベースに変更した結果、
**draft が後で ready 化されたタイミングで新 ready chain と既存 RAA が並走する** 可能性が
残った。本 guard はそれを防ぐ。`runAfterAllExecutable` を通すことで、複数の RAA を
順次 drain する semantics は維持される。

log event: `run_after_all_lock_active task_ids=… pending_normal=…`

### 6.4 各 flag の semantics 比較

| flag | drain 発火条件 | assigned 中の挙動 |
|---|---|---|
| `--run-after-all` (非排他) | `executable + assignedNormal = 0` (executable ベース、T397) | normal の新規 assignment を停止。他の RAA とは並走可 (T398) |
| `--exclusive` | 同上 (runAfterAll を暗黙包含) | normal + RAA の **全 assignment** を停止 |
```

> 挿入位置: `## 5. 段階計画` の手前 (line 272 付近)。既存の `## 関連` を末尾に保つ。

### 4.2 `CLAUDE.md`

タスク属性表 (160-169 行) を以下に更新（**run_after_all 行に「assigned 中の挙動」を追記**、その他は不変）:

```markdown
| 属性 | 意味 | CLI フラグ |
|------|------|-----------|
| `run_after_all: true` | 全 open タスクが closed になってから実行（非排他 drain）。assigned 中は normal の新規 assignment を停止するが、他の `run_after_all` とは並走可 | `--run-after-all` |
| `exclusive: true` | drain 後に単独実行。assigned の間は他の全 assignment を停止 | `--exclusive` |
```

> 本文末尾の bullet list `- --exclusive 同士は共存可能…` 以下は不変。

`assigned 中の挙動` に関する 1 行を `run_after_all` 行に追記するだけ。表形式の語順を保つため改行は入れない。

## 5. ロールアウト順序 (TDD)

| 段 | 操作 | 確認 |
|---|---|---|
| 1 | 新規ファイル `daemon-run-after-all-lock.test.ts` を作成。TC1 のみ書く。 | `bun test --timeout 30000 daemon-run-after-all-lock.test.ts` → **赤** (期待: ガード未実装で normal が dispatch される or guard log が出ない) |
| 2 | `daemon.ts:scanTasks` に T398 guard を実装、`createTask` ヘルパーに `runAfterAll/exclusive` 対応追加 (テストの依存)。 | TC1 → 緑 |
| 3 | TC2〜TC5 を追加 | 全部緑 |
| 4 | `daemon.test.ts` の throttle / exclusive 系を流して regression がないこと確認 | `bun test --timeout 30000 task.test.ts daemon-run-after-all-lock.test.ts daemon.test.ts` 全部緑 |
| 5 | `docs/spec/07-state-machine.md` に `## 6. dispatch ガード` 節追加 + `CLAUDE.md` のタスク属性表更新 | rendering 確認 (mermaid 等は使わない) |
| 6 | release | 別タスク (T398 の本実装には含めない) |

> ステップ 4 で `bun test` 全体走行は CLAUDE.md の禁忌（O(N²) 劣化）に該当するため**実行しない**。`task.test.ts` `daemon*.test.ts` のみ。

## 6. エッジケース・リスク

### 6.1 評価順序: exclusive と run_after_all guard

- exclusive ⇒ runAfterAll=true (parser 強制) なので、`assignedExclusiveTaskIds ⊆ assignedRunAfterAllTaskIds` （`!t.exclusive` フィルタを外した場合）。
- exclusive guard は `allExecutable.length > 0` で全停止 return。RAA guard は `executable.length > 0` でのみ動く。
- → exclusive が assigned のときは **必ず exclusive guard で先に return**。RAA guard はその下流で「exclusive ではない RAA が assigned」のケースのみハンドルする。
- defense-in-depth として `!t.exclusive` を `assignedRunAfterAllTaskIds` の filter に入れる。これにより、もし将来 exclusive guard の return 条件が緩んでも本 guard が exclusive を二重カウントしない。

### 6.2 RAA が両方 ready だが片方だけ assigned のとき

- `R1` ready → assigned、`R2` ready のまま。`executable = []` (normal なし)。`filterRunAfterAllTasks` は `normalActive = []` (normal も RAA も assignedRAA も `!t.runAfterAll` 条件で除外) → `R2` を返す → `runAfterAllExecutable = [R2]`。
- 新 guard: `assignedRAA = {R1}`, `executable.length = 0` → guard skip → `dispatchTargets = [R2]` で dispatch。**並走可**（ID 昇順は `sortByPriority` の二次キーで保証されるが、本 guard とは独立）。

### 6.3 RAA assigned 中の dependsOn cascade (T241)

- RAA assigned 中に親が `assigned → aborted` （resume 不可等）→ cascade で ready 子が draft へ戻る。本 guard は `executable` ベースなので、cascade 後に executable=0 → guard skip となり、整合性に問題なし。
- 逆に cascade で ready が増えるケースはない（cascade は `ready → draft` のみ）。

### 6.4 Conductor が複数 idle のときの behavior

- guard ヒット時 `dispatchTargets = []` (実質)。idle Conductor は idle のまま、log だけ出る。次 tick で同じ guard が再度評価される。**1 tick あたり最大 1 行の log**（exclusive guard と同じ頻度）。
- log spam 懸念: tick 間隔は 5s （実 prod 値、`pollInterval` 未明示変更時）→ 12 行/分。実害なし。必要なら将来 throttle 化を別タスクで（本タスクスコープ外）。

### 6.5 `t.runAfterAll && !t.exclusive` 判定の race

- frontmatter 編集中に `runAfterAll` / `exclusive` が変わるケース。`tasks` は `loadTasks` 結果で snapshot 化されているので 1 tick 内では一貫。tick 間で変わった場合も次 tick で再評価されるだけ。

### 6.6 観測性 — log volume

- 既存 `exclusive_lock_active` も同じ tick 単位で出る。新 `run_after_all_lock_active` も同パターン。trace DB / manager.log の容量増は exclusive 経路と同程度を見込む。CLAUDE.md「DB GC 未実装」の既知問題範囲内。

### 6.7 dashboard / surface 表示への波及

- `state.pendingTasks` は `allExecutable.length` のままなので、dashboard の「pending 数」表示は変わらない。「executable のうち normal は今 lock されている」は表示しない（必要なら別タスクで）。

## 7. 完了条件チェック対応表

| 完了条件 (タスク本文) | 本計画の対応箇所 |
|---|---|
| `scanTasks` に run_after_all lock guard を追加 | §2.1 (b) |
| 新規テスト: RAA assigned 中、新規 ready normal が dispatch されない | §3.3 TC1 |
| 新規テスト: RAA assigned 中、他の ready RAA は dispatch される | §3.3 TC2 |
| 既存テスト: --exclusive の単独実行 regression | §3.3 TC4 (新規だが exclusive 経路の regression を兼ねる) |
| T397 executable ベース判定との組合せ — draft→ready 後も並走しない | §3.3 TC3 |
| `bun test … task.test.ts daemon-*.test.ts` が green | §5 ステップ 4 |
| `docs/spec/07-state-machine.md` 更新 | §4.1 |
| CLAUDE.md タスク属性表更新 | §4.2 |

## 8. やらないこと（再掲）

- `--exclusive` の挙動変更
- 複数 run_after_all 同士の優先度・順序制御の見直し
- run_after_all の名前変更や API 変更
- log throttle 機構の追加
- dashboard への lock 表示
