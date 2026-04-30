# T314 実装計画書

## 1. 全体方針

### 表示フォーマット: 案A（一行統合型）を採用

```
─ Tasks ───────────────────────────────────────────────────
  open: 0  closed: 298  aborted: 7
```

**根拠:**

1. **セマンティックな並列性**: `open` / `closed` / `aborted` はいずれも「タスクがある状態でのカウント」であり並列関係にある。`aborted` は closed と同じく終端状態（異常終了）なので、同一行で並べるのが自然。
2. **既存セクションとの整合**: 他のセクション（`─ Masters`, `─ Conductors`, `─ Rate Limit`）はいずれも 1〜2 行のコンパクトな表示。案B の括弧付き補足行はこの粒度感から逸脱する。
3. **CLI 出力としての一貫性**: ターミナルの grep / awk でのパース利便性を考えると、`key: value  key: value` 形式の単一行が扱いやすい。
4. **読みやすさ**: 案B の `(aborted: 7 historical)` は「historical」という英文脈が混入して日本語 UI の中で浮く。

### 表示の条件分岐

| aborted 件数 | 表示 |
|--------------|------|
| `0` | `open: N  closed: M`（従来通り、aborted セグメント省略） |
| `≥ 1` | `open: N  closed: M  aborted: K` |

`deleted` は**常に非表示**。deleted は「削除された」状態であり、ユーザーに想起させる必要が無い（受け入れ条件の「冗長にしない」に従う）。

### 実装方針: 純粋関数を抽出

`buildTasksSectionLines(tasks: TaskMeta[]): string[]` を新設し、`cmdStatus()` はそれを `console.log` に流すだけにする。

**理由:**
- 同一ファイル配下に `buildRateLimitStatusLines()`（`rate-limit-status.ts:14`）という先例がある
- `cmdStatus()` 全体を spawn で統合テストするのは遅く、回帰検出の粒度が粗い
- 純粋関数なら `bun test` で低コストに分岐網羅できる（aborted=0 / aborted>0 / deleted 混入 の 3 ケース）

### TaskStatus の扱い

**文字列リテラルの `Set<string>` をインラインで使う**。`events.ts` からの `TaskStatus` import は不要。

**理由:**
- 本件で必要なのは `"draft" | "ready" | "assigned"` の 3 つをまとめた集合判定のみ
- `events.ts` の `TaskStatus` は reducer/FSM 側の抽象で、表示ロジックから import すると責務境界をまたぐ
- `TaskMeta.status` は `string`（`task.ts:33` のコメント通り、union 未定義）なので型的にも Set<string> が自然

## 2. 具体的なコード変更

### 2.1 新ファイル: `skills/cmux-team/manager/tasks-status.ts`

```ts
import type { TaskMeta } from "./task";

/**
 * `cmux-team status` の Tasks セクション行を生成する。
 *
 * - open: draft / ready / assigned（進行中として扱う 3 ステータス）
 * - closed: closed（正常完了）
 * - aborted: aborted（中断済み。件数が 0 のときはセグメント自体を出さない）
 * - deleted: 表示しない（冗長）
 */
export function buildTasksSectionLines(tasks: TaskMeta[]): string[] {
  const OPEN_STATUSES = new Set<string>(["draft", "ready", "assigned"]);
  let openCount = 0;
  let closedCount = 0;
  let abortedCount = 0;
  for (const t of tasks) {
    if (OPEN_STATUSES.has(t.status)) openCount++;
    else if (t.status === "closed") closedCount++;
    else if (t.status === "aborted") abortedCount++;
    // deleted および想定外ステータスは表示対象外
  }
  const segments = [`open: ${openCount}`, `closed: ${closedCount}`];
  if (abortedCount > 0) segments.push(`aborted: ${abortedCount}`);
  return [`  ${segments.join("  ")}`];
}
```

### 2.2 変更: `skills/cmux-team/manager/main.ts` L1359-1364

**Before:**
```ts
// --- Tasks ---
const { tasks } = await loadTasks(PROJECT_ROOT);
const closedCount = tasks.filter(t => t.status === "closed").length;
const openCount = tasks.length - closedCount;
console.log(`─ Tasks ${"─".repeat(51)}`);
console.log(`  open: ${openCount}  closed: ${closedCount}`);
```

**After:**
```ts
// --- Tasks ---
const { tasks } = await loadTasks(PROJECT_ROOT);
console.log(`─ Tasks ${"─".repeat(51)}`);
for (const line of buildTasksSectionLines(tasks)) {
  console.log(line);
}
```

**import 追加** (main.ts 先頭付近、他の manager モジュール import 近く):
```ts
import { buildTasksSectionLines } from "./tasks-status";
```

## 3. テスト方針

### 3.1 新ファイル: `skills/cmux-team/manager/tasks-status.test.ts`

`TaskMeta` の最小インスタンスを作るヘルパーと以下ケースを網羅:

| ケース | タスク構成 | 期待出力 |
|--------|------------|----------|
| 通常（aborted=0） | draft×1, ready×1, assigned×1, closed×5 | `  open: 3  closed: 5` |
| aborted が正の値 | ready×2, closed×10, aborted×7 | `  open: 2  closed: 10  aborted: 7` |
| 全 0 件 | `[]` | `  open: 0  closed: 0` |
| deleted は open/closed/aborted いずれにも加算しない | closed×3, deleted×2 | `  open: 0  closed: 3` |
| aborted のみ存在（エッジ） | aborted×1 | `  open: 0  closed: 0  aborted: 1` |
| 想定外ステータスは静かに無視 | status="unknown"×1, closed×2 | `  open: 0  closed: 2` |

実装は `bun test` で完結する pure function テスト。モック・fs 不要。

### 3.2 既存テストへの影響調査

- `main.test.ts`: `cmdStatus()` 自体を対象にしたテストは存在しない（L1 〜 の `runCli` は CRUD コマンド系のみ）→ **影響なし**
- `daemon.test.ts`: `deriveOpenClosed()` というテストヘルパーで open/closed を別観点で計算しているが、こちらは reducer テスト用。本変更は `cmdStatus()` の表示ロジックのみなので **影響なし**
- `dashboard-*.test.tsx`: dashboard の tasks-tab は本タスクのスコープ外。**触らない**

### 3.3 typecheck

`buildTasksSectionLines` の引数は `TaskMeta[]` で `TaskMeta` の `.status: string` は既存。新しい型依存は無し。`bun tsc --noEmit`（もしくはプロジェクト既存の typecheck スクリプト）でパス想定。

## 4. 動作確認手順

1. **typecheck & unit test**
   ```bash
   cd /Users/yamamoto/git/cmux-team/.worktrees/task-314-1777060954
   bun test skills/cmux-team/manager/tasks-status.test.ts
   bun test skills/cmux-team/manager
   ```

2. **本プロジェクトでの `cmux-team status` 実行確認**
   実装者はローカル `cmux-team` を再ビルド or `bun run skills/cmux-team/manager/main.ts status` 相当で以下を確認:

   - `.team/task-state.json` で実際に draft/ready/assigned が 0 件のとき、`open: 0` と表示されること
   - aborted が 1 件以上存在する状態で、`aborted: N` セグメントが付与されること
   - aborted が 0 件のとき、`  open: N  closed: M` のみで余計な `  aborted: 0` が出ないこと
   - deleted が混入しても表示に一切現れないこと

3. **既存他コマンドの非回帰**
   `cmux-team status` の Masters / Conductors / Rate Limit / Log セクションの見た目が壊れていないこと（目視）。

## 5. リスク・懸念

| リスク | 内容 | 対応 |
|--------|------|------|
| **想定外ステータスの silent drop** | TaskStatus の 6 値以外が入ってきた場合、新実装では aborted/closed/open のいずれにも加算されず、totals に現れない | 将来 TaskStatus が拡張された場合に気付けるよう、コメントに「`OPEN_STATUSES` / `closed` / `aborted` 以外は表示対象外」と明記する。表示フォーマットを壊すリスクより明示的に無視する方が安全 |
| **tasks-tab（dashboard）側の同じバグ** | タスク本文で明示的にスコープ外とされたが、ユーザーが dashboard を見ているときに同じ誤カウントに遭遇する可能性 | スコープ外。別タスク化の判断は Conductor/Master に委ねる（plan.md としては本タスクでは触れない） |
| **`─ Tasks ───…` のダッシュ本数固定値 51** | 新実装でも同じリテラルを維持（行幅 60 文字相当）。aborted セグメントが追加されると表示幅が伸びるが、セクション区切りの `─` は固定 | これは既存挙動。幅整形は別関心事なので本タスクでは触らない |
| **abortedCount が多い現実プロジェクト** | 現場の `cmux-team status` で `aborted: 9` のような 1 桁〜2 桁が恒常表示される可能性 | 正しい挙動なので受け入れる。ゴミ掃除（aborted 自動アーカイブ）は別タスクで対応 |

## 6. 変更ファイル一覧

| ファイル | 変更種別 | 行数目安 |
|---------|---------|---------|
| `skills/cmux-team/manager/tasks-status.ts` | 新規作成 | +25 |
| `skills/cmux-team/manager/tasks-status.test.ts` | 新規作成 | +60 |
| `skills/cmux-team/manager/main.ts` | import 1 行追加 + L1359-1364 の 5 行を 4 行に置換 | ±5 |

合計: 3 ファイル、約 90 行の差分。
