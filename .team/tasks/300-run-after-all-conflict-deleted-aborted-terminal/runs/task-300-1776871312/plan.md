# T300 実装計画: run_after_all conflict チェックが deleted/aborted を terminal として扱っていない

## 1. 現状分析

### 問題のコード: `skills/cmux-team/manager/task.ts:783-798`

```ts
if (runAfterAll) {
  const { tasks } = await loadTasks(projectRoot);
  const conflict = tasks.find(
    (t) =>
      t.runAfterAll &&
      t.status !== "closed" &&
      !(exclusive && t.exclusive),
  );
  if (conflict) {
    const err = new Error(
      `run_after_all task already exists: ${conflict.id} (${conflict.title})`,
    );
    (err as any).code = "RUN_AFTER_ALL_CONFLICT";
    (err as any).existingTaskId = conflict.id;
    throw err;
  }
}
```

`t.status !== "closed"` のみで terminal 判定しているため、`aborted` / `deleted` な run_after_all タスクが「まだ生きている」扱いになり、新規作成を拒否する。

### 一貫した側: `skills/cmux-team/manager/daemon.ts:2505-2511` (`scanTasks`)

```ts
const closed = new Set(
  Object.entries(taskState)
    .filter(([_, s]) => s.status === "closed" || s.status === "aborted" || s.status === "deleted")
    .map(([id]) => id)
);

const openTasksList = tasks.filter(t => t.status !== "closed" && t.status !== "aborted" && t.status !== "deleted");
```

こちらは `closed | aborted | deleted` の 3 つを terminal として扱っている。同じ daemon.ts:2533 `closedMetas` の部分は逆に `closed | aborted` の 2 状態だけで、`deleted` は除外している（これは「closed 表示用」のリストで terminal 判定とは別目的なので扱いを揃える対象外）。

### 他の参照ポイント（変更影響外だが把握しておく箇所）

- `markTaskAborted` の冪等 skip（task.ts:584-600）: `closed | aborted | deleted` を全て skip 対象としている（一貫）
- `abortTask` / `deleteTask` CLI 側の事前判定: 省略（今回対象外）
- `parseAbortJournal` 等: 無関係

### ズレのまとめ

| 箇所 | terminal として扱う値 |
|---|---|
| `scanTasks` closed Set (daemon.ts:2505-2509) | `closed` + `aborted` + `deleted` |
| `scanTasks` openTasksList (daemon.ts:2511) | `closed` + `aborted` + `deleted` を除外 |
| `createTaskProgrammatic` conflict check (task.ts:788) | **`closed` のみ** ← 不整合 |

## 2. 設計判断

### ヘルパ切り出し: 採用

**推奨: `task.ts` に `isTerminalStatus(status: string): boolean` を export する**

根拠:

- `TaskState["status"]` / `TaskMeta["status"]` の概念は `task.ts` で定義されているため、terminal 判定も同じファイルに置くのが自然（ドメイン所属）
- `daemon.ts` は `task.ts` から多数の関数（`loadTasks` / `filterExecutableTasks` など）を既に import しているため、逆方向の循環依存は発生しない
- 新ファイルを切る必要はない — 単一の述語関数だけのために `task-status.ts` 等を作ると過剰分割になる

### ヘルパ仕様

```ts
/**
 * T300: 「terminal（これ以上状態が変化しない）」状態の判定。
 * closed / aborted / deleted を同一視したい 3 箇所（scanTasks の
 * closed Set / openTasksList フィルタ / createTaskProgrammatic の
 * run_after_all 競合チェック）で共有する。
 *
 * 新しい terminal 状態を追加する場合はここに足すだけで 3 箇所が同期する。
 */
export function isTerminalStatus(status: string): boolean {
  return status === "closed" || status === "aborted" || status === "deleted";
}
```

### 代替案と却下理由

| 案 | 却下理由 |
|---|---|
| daemon.ts 内にローカル定義 | task.ts 側が daemon.ts を import できない（循環） |
| 新ファイル `task-status.ts` | 1 関数のために新ファイルは過剰 |
| `task.ts` に定数 `TERMINAL_STATUSES = new Set(...)` のみ | Set メンバシップテストは呼び出し側に負担。関数の方が読みやすく、将来 `aborted` のサブケース等を加える余地もある |
| 何も切り出さず task.ts の条件式を書き換えるだけ | 今回の 2 箇所（task.ts + daemon.ts）で書きぶりが揃わない。規則が再びズレる温床になるため避ける |

## 3. 実装ステップ（TDD）

### Step 1: テスト追加（Red）

`skills/cmux-team/manager/task.test.ts` に `describe("createTaskProgrammatic run_after_all conflict (T300)")` を追加。後述「テスト計画」のケースを実装。この時点で「deleted/aborted な run_after_all があっても新規作成が成功する」テストは fail する。

追加で `describe("isTerminalStatus (T300)")` も追加し、純粋関数のユニットテストを書く（実装前なのでインポートエラーで fail する）。

### Step 2: `isTerminalStatus` を実装（Green 1 段目）

`task.ts` に `isTerminalStatus` を export で追加。これにより `isTerminalStatus` の単体テストが通る。

### Step 3: `createTaskProgrammatic` を書き換え（Green 2 段目）

`task.ts:783-798` の competitor 判定を:

```ts
const conflict = tasks.find(
  (t) =>
    t.runAfterAll &&
    !isTerminalStatus(t.status) &&
    !(exclusive && t.exclusive),
);
```

に変更。これで run_after_all conflict テストが通る。

### Step 4: `scanTasks` を書き換え（Green 3 段目）

`daemon.ts:2505-2511` を:

```ts
const closed = new Set(
  Object.entries(taskState)
    .filter(([_, s]) => isTerminalStatus(s.status))
    .map(([id]) => id)
);

const openTasksList = tasks.filter(t => !isTerminalStatus(t.status));
```

に変更（`task.ts` から `isTerminalStatus` を import する）。既存の daemon.test.ts が引き続き通ることで回帰がないことを確認する。

> 注: `daemon.ts:2533` の `closedMetas` は **「closed/aborted を直近リストとして表示」するための別目的** なので今回は触らない（`deleted` を表示に混ぜる変更は UI 挙動の変更になり、T300 のスコープを超える）。ヘルパを 3 箇所で共有するという原文要件に対しては「概念的にズレている場所なので対象外」と明示し、scanTasks の 2 箇所 + createTaskProgrammatic の 1 箇所の計 **3 箇所** で共有する構成とする。これは原文の『`scanTasks` の closed Set 構築（daemon.ts:2505-2509）と `openTasksList` フィルタ（daemon.ts:2511）と conflict チェック（task.ts:788）で共有し』の字面にも合致する。

### Step 5: 型チェック + 全テスト実行

```
cd skills/cmux-team/manager
bun test
bunx tsc --noEmit
```

### exclusive 条件との組み合わせの振る舞い整理

conflict 判定条件は `runAfterAll && !isTerminalStatus(t.status) && !(exclusive && t.exclusive)` になる。「新規作成しようとしている側 (exclusive)」と「既存タスク t (t.exclusive, t.status)」の全組み合わせを確認する:

| 既存 t の属性 | 新規 exclusive | 変更前 | 変更後 | 備考 |
|---|---|---|---|---|
| `runAfterAll, status=ready/assigned, exclusive=true` | true | 許可（exclusive 同士共存） | **許可** | 変更なし（`!(exclusive && t.exclusive)` で除外） |
| `runAfterAll, status=ready/assigned, exclusive=true` | false | 拒否 | **拒否** | 変更なし（既存仕様通り、非排他と exclusive は共存不可） |
| `runAfterAll, status=ready/assigned, exclusive=false` | true | 拒否 | **拒否** | 変更なし |
| `runAfterAll, status=ready/assigned, exclusive=false` | false | 拒否 | **拒否** | 変更なし（非排他同士は 1 つまで） |
| `runAfterAll, status=closed, *` | * | 許可 | **許可** | 変更なし |
| `runAfterAll, status=aborted, exclusive=true` | true | 許可（exclusive 同士）| **許可** | 条件経由の理由は変わるが結果は同じ |
| `runAfterAll, status=aborted, exclusive=true` | false | **拒否** | **許可** ← 修正 | terminal として扱う |
| `runAfterAll, status=aborted, exclusive=false` | true | **拒否** | **許可** ← 修正 | terminal として扱う |
| `runAfterAll, status=aborted, exclusive=false` | false | **拒否** | **許可** ← 修正 | terminal として扱う |
| `runAfterAll, status=deleted, *` | * | **拒否** | **許可** ← 修正 | terminal として扱う（deleted = 「無かったことにする」意図） |

つまり「既存が terminal (`aborted` / `deleted`)」の行は、`exclusive` 組み合わせによらず一律で許可になる。exclusive vs non-exclusive のセマンティクスは「生きているタスク同士」にだけ適用される、という原則は保たれる。

## 4. テスト計画

### 新規追加テスト (`task.test.ts`)

#### 4.1 `describe("isTerminalStatus (T300)")`

- `closed` → true
- `aborted` → true
- `deleted` → true
- `ready` → false
- `assigned` → false
- `draft` → false
- 未知値 `"foo"` → false（将来の安全側動作を担保）

#### 4.2 `describe("createTaskProgrammatic run_after_all conflict (T300)")`

全ケースで `tmpdir` (Bun `$.mktemp` or `mkdtemp`) に `.team/` を用意して検証する。

| テスト名 | 既存タスクの条件 | 新規作成の条件 | 期待結果 |
|---|---|---|---|
| aborted な run_after_all があっても新規 run_after_all を作成できる | run_after_all=true, status=aborted | runAfterAll=true, exclusive=false | 成功 (id 返却) |
| deleted な run_after_all があっても新規 run_after_all を作成できる | run_after_all=true, status=deleted | runAfterAll=true, exclusive=false | 成功 |
| closed な run_after_all があっても新規 run_after_all を作成できる（回帰確認） | run_after_all=true, status=closed | runAfterAll=true, exclusive=false | 成功 |
| ready な run_after_all があると conflict で拒否される（回帰確認） | run_after_all=true, status=ready | runAfterAll=true, exclusive=false | `RUN_AFTER_ALL_CONFLICT` 例外、`existingTaskId` が既存タスクの ID |
| assigned な run_after_all があると conflict で拒否される（回帰確認） | run_after_all=true, status=assigned | runAfterAll=true, exclusive=false | `RUN_AFTER_ALL_CONFLICT` 例外 |
| exclusive 同士（既存=ready）は共存可能（回帰確認） | run_after_all=true, exclusive=true, status=ready | runAfterAll=true, exclusive=true | 成功 |
| aborted な非排他 run_after_all があっても新規 exclusive を作成できる | run_after_all=true, exclusive=false, status=aborted | exclusive=true | 成功（terminal として除外） |
| deleted な exclusive があっても新規非排他 run_after_all を作成できる | run_after_all=true, exclusive=true, status=deleted | runAfterAll=true, exclusive=false | 成功（terminal として除外） |
| ready な非排他 run_after_all があると新規 exclusive は拒否される（回帰確認） | run_after_all=true, exclusive=false, status=ready | exclusive=true | `RUN_AFTER_ALL_CONFLICT` 例外 |

status を task-state.json に反映するには `saveTaskState` を直接呼ぶか、`createTaskProgrammatic` で作った後に taskState を手動で書き換えて保存する構成にする（`parseTaskMeta` は frontmatter の `status:` ではなく task-state.json 側の status を優先する実装 — task.ts:428）。

### 既存テスト（回帰確認）

- `daemon.test.ts` の `scanTasks` 周り（openTasksList / closed Set の検証があるもの）: `isTerminalStatus` 経由に書き換えても既存期待値は変わらないこと
- `task.test.ts` の `parseTaskMeta — exclusive` / `cascadeAbortToChildren` 等: `isTerminalStatus` 追加と無関係で変化しないこと
- `filterExecutableTasks` 等は `closedIds` Set を引数で受けるため今回のヘルパ導入の影響を受けない

### 手動確認（README の確認手順に対応）

1. `cmux-team create-task --title T-A --run-after-all --status ready` → 作成可
2. `cmux-team delete-task --task-id <A>` で deleted に遷移
3. `cmux-team create-task --title T-B --run-after-all --status ready` → 成功（従来は `RUN_AFTER_ALL_CONFLICT` で失敗していた）
4. もう 1 つ `cmux-team create-task --title T-C --run-after-all` → conflict エラー（T-B は ready なので正しく拒否）
5. `cmux-team abort-task --task-id <B>` で aborted に遷移
6. `cmux-team create-task --title T-D --run-after-all` → 成功

## 5. リスク・回帰防止

### 構造的リスク

- **deleted タスクを terminal 扱いにする副作用**: 今回のヘルパで `deleted` が conflict 除外されるが、`scanTasks` 側では既に `deleted` を terminal として扱っているため、「daemon が既に無視している状態を作成側も無視する」動きに揃うだけ。新たな副作用は生じない
- **closedMetas（daemon.ts:2533）との関係**: ここは「表示用」で今回は触らない。結果として「deleted タスクは TUI 直近履歴に出ない」という既存挙動も維持される。もし将来 deleted も履歴に出したいなら別タスクで対応（T300 のスコープを意図的に絞る）

### exclusive との相互作用（再確認）

- aborted / deleted な exclusive タスクは新規 exclusive の drain 対象にも当然ならない（`filterRunAfterAllTasks` 側は `closedIds` 経由で既に terminal を除外済み — daemon.ts:2523-2525 の呼び出し経路）。今回の変更で作成経路と実行経路の terminal 定義が完全に揃う
- 「deleted タスクが依然として exclusive 競合を起こさないか」: 起こさない。`filterRunAfterAllTasks` の `normalActive` 判定は `status === "ready" || assignedIds.has(t.id)` で、deleted / aborted は最初から対象外

### 既存データ互換性

- task-state.json のスキーマ変更なし
- frontmatter フォーマット変更なし
- CLI 引数変更なし
- ログイベント変更なし

### ビルド / 型への影響

- `isTerminalStatus` は `string` を受ける純粋関数なので、TaskMeta / TaskState どちらの status にも使える
- daemon.ts の import 追加 1 行のみ

### 将来の保守性

- 新たな terminal 状態（例: `cancelled` 等）が将来追加された場合、`isTerminalStatus` の 1 箇所を更新するだけで 3 箇所（scanTasks 2 箇所 + conflict チェック 1 箇所）に同期的に反映される。今回の主目的であるヘルパ共有のメリットがそのまま得られる

### 監査ログ

- 変更はロジック整合性のみで、新規ログイベントの追加は不要
- 既存の `run_after_all_conflict` 的なログは task.ts 側には出していない（create-task 失敗時のエラーメッセージのみ）。main.ts:2900 で CLI が `RUN_AFTER_ALL_CONFLICT` を受けて exit する経路も変更なし

## 完了条件

- `task.ts` / `daemon.ts` / `task.test.ts` を編集
- `bun test` 全件 pass
- `bunx tsc --noEmit` 0 エラー
- 手動確認 1–6 が通る
