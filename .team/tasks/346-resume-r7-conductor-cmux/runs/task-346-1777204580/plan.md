# Plan: T346 - resume R7 廃止 + Conductor 事後条件保証

## 背景

cmux がクラッシュして全 surface が消滅した状態から `cmux-team resume` を実行すると、Conductor が 0 個のままで `state.conductors.size === 0` のため open task が永続的に throttled となるバグがある。

根本原因は `initializeLayout` に「Conductor を `maxConductors` 個確保する」事後条件が保証されていないこと。具体的には:

1. **fallback 条件の漏れ**: `layout_restore_empty_fallback` の発動条件が `alive=0 && resumeExisting=0 && resumeNewSurface=0` の三条件 AND になっており、D 経路（resumeNewSurface）が存在すると fallback が発動しない。一方で `applyRestorePlan` は D 経路を「ready 戻し」（R7 方針）するだけなので、結果として state.conductors が空のまま処理が終了する。
2. **partial restore 時の補充欠落**: A 経路 / B 経路で 1〜2 件だけ復元できた場合、不足分の slot を新規作成する処理が無く `layout_kept_partial` ログを残して終了するのみ（R7 方針: 「pane 補充は行わない」）。

本タスクは R7（復帰時は pane 新規作成しない方針）を廃止し、`initializeLayout` の return 時点で `state.conductors.size === state.maxConductors` を満たす事後条件を確立する。

## 現状分析

### 対象コード

- **`skills/cmux-team/manager/daemon.ts:1274-1295`**: `layout_restore_empty_fallback` ブロック
  - 条件: `plan.alive.length === 0 && plan.resumeExisting.length === 0 && plan.resumeNewSurface.length === 0`
  - 動作: `applyDiscardOnly` → `initializeConductorSlots(..., resumePlan, ...)`
- **`skills/cmux-team/manager/daemon.ts:1297-1318`**: `applyRestorePlan` 呼び出し + 観測ログ
  - L1310-1316: `layout_kept_partial` ログ（「pane 補充は行わない」と明記、R7 の可観測化）
- **`skills/cmux-team/manager/daemon.ts:1023-1164`**: `applyRestorePlan` の D 経路処理（L1137-1158）
  - `plan.resumeNewSurface` の resume を `unmatchedResumes` と合流し、全件 `REVERT_TO_READY(unmatched)` で ready に戻す（R7 の実装本体）

### 関数シグネチャ

`initializeConductorSlots` (`skills/cmux-team/manager/conductor.ts:204-213`):

```ts
export async function initializeConductorSlots(
  projectRoot: string,
  conductors: Map<string, ConductorState>,
  count: number = 3,
  daemonSurface?: string,
  resumePlan?: ResumePlanItem[],
  layout: LayoutMode = "wide",
  mainBranch: string = "",
  backend?: ClaudeCodeBackend,
): Promise<ResumeAssignment[]>
```

挙動メモ:
- `count` 件の pane を新規分割し、`resumePlan` の先頭から 1:1 で resume 起動。
- resume 対象 surface は state.conductors に pre-populate される（254-276 行）。
- 非 resume 分は self-register 経由で後から登録される。

### 型定義

`ResumePlanItem` (`skills/cmux-team/manager/conductor.ts:55-61`):

```ts
export interface ResumePlanItem {
  taskId: string;
  taskRunId: string;
  worktreePath: string;
  sessionId: string;
  taskTitle?: string;
}
```

### 関連ヘルパ

- `applyRestorePlan` (daemon.ts:1023): A/B/C/D/E 全経路の副作用適用 + 戻り値は A/B の `ResumeAssignment[]`。state.conductors.clear() で全置換するため、呼び出し後の state.conductors.size = alive.length + resumeExisting.length。
- `applyDiscardOnly` (daemon.ts:1188): C/E の副作用のみ流すヘルパ。fallback 経路で利用。

### layout-restore.ts のコメント

- L8 の D 経路定義: `D resume-new-surface  : surface 消失 + running task → 新 pane + session-id resume` — 元々の意図は「新 pane を作って resume する」。**現状の実装（R7）と齟齬していない**ため、本タスクで R7 を廃止する変更後にこのコメントが本来の意図に整合する形になる。
- L18-19, L121-128 の本体ロジックは pure function で副作用を持たないため変更不要。

### 既存テスト

`skills/cmux-team/manager/layout-restore.test.ts`:
- M1〜M5, M7, M12, M6 再現バグ等、`planLayoutRestore` 単体の分類ロジック検証のみ。**副作用は検証しない**ため、本タスクの変更で既存テストは影響を受けない見込み。

`skills/cmux-team/manager/daemon.test.ts`:
- M17a/b/c/d (L3672-3901): fallback 発動 3 バリアント + resumePlan 透過 (M17d)。条件 1 つ削るだけなら既存挙動は維持される。
- `layout_kept_partial` テスト (L3606-3633): kept=1 / max=3 で `layout_kept_partial` が出ることを確認。**本タスクで挙動が変わる箇所** — 事後条件チェックで不足分を補充するため、ログ文言は維持しつつ補充ログを追加で検証する形に変更する。
- `conductor_resume_noop` 廃止確認 (L3635-3665): unmatched で `resume_unmatched_to_ready` が出ることを確認。**partial restore + 補充 + unmatched** の組み合わせを新規 M18 系で検証する必要あり。

## 変更内容

### 変更 1: daemon.ts - fallback 条件拡張（L1274-1278）

D 経路（`resumeNewSurface`）があっても fallback を発動させる。

**Before:**
```typescript
if (
  plan.alive.length === 0 &&
  plan.resumeExisting.length === 0 &&
  plan.resumeNewSurface.length === 0
) {
```

**After:**
```typescript
if (plan.alive.length === 0 && plan.resumeExisting.length === 0) {
```

合わせて L1269-1273 のコメントを修正し、「A=0 + B=0」が fallback 条件であること、D は resume 透過先で取り扱うことを明示する。

### 変更 2: daemon.ts - fallback 内で D 経路 resumePlan 透過（L1284-1294）

D 経路の resume を ready に戻すのではなく、`initializeConductorSlots` に resumePlan として渡す。

**Before:**
```typescript
await applyDiscardOnly(state, plan);
return await initializeConductorSlots(
  state.projectRoot,
  state.conductors,
  state.maxConductors,
  daemonSurface,
  resumePlan,
  state.layout,
  state.mainBranch,
  ccBackend(state.backend),
);
```

**After:**
```typescript
await applyDiscardOnly(state, plan);
const allResumePlan: ResumePlanItem[] = [
  ...(resumePlan ?? []),
  ...plan.resumeNewSurface
    .map(e => e.resume)
    .filter((r): r is ResumePlanItem => !!r),
];
return await initializeConductorSlots(
  state.projectRoot,
  state.conductors,
  state.maxConductors,
  daemonSurface,
  allResumePlan,
  state.layout,
  state.mainBranch,
  ccBackend(state.backend),
);
```

注意:
- 重複（同一 taskId が `resumePlan` と `plan.resumeNewSurface` 両方にあるケース）は理論上あり得るが、`planLayoutRestore` 内で `matchedTaskIds` により D 経路に入った taskId は unmatched から除外されているため、`resumePlan` 引数の方は外部の main.ts が組み立てた集合とは別経路。重複防止のため Map で taskId 一意化するべきか検討要 → **デフォルトでは重複可能性は低い（D 経路の resume は `resumeByTaskId` 経由で resumePlan の同一インスタンスを参照しているため、配列上重複しても launchConductor は冪等）。** 実装は単純結合 + 後段で Map 一意化を入れる。

### 変更 3: daemon.ts - applyRestorePlan 後の事後条件チェック（L1297 直後）

partial restore（A or B あり）後も Conductor 不足分を補充する安全網を追加。R7 を廃止し、`layout_kept_partial` の「pane 補充は行わない」を覆す。

**Before:**
```typescript
const assignments = await applyRestorePlan(state, plan);

const keptSurfaces = [
  ...plan.alive.map(e => e.raw.surface as string),
  ...plan.resumeExisting.map(e => e.raw.surface as string),
];
if (keptSurfaces.length > 0) {
  await log(
    "conductors_restored",
    `count=${keptSurfaces.length} surfaces=${keptSurfaces.map(s => formatSurface(s, "C")).join(",")}`,
  );
}
// partial restore: 復元 pane 数が maxConductors 未満（R7 の可観測化）
if (keptSurfaces.length > 0 && keptSurfaces.length < state.maxConductors) {
  await log(
    "layout_kept_partial",
    `kept=${keptSurfaces.length} max=${state.maxConductors} — pane 補充は行わない（次起動で再構成可能）`,
  );
}

return assignments;
```

**After:**
```typescript
const assignments = await applyRestorePlan(state, plan);

const keptSurfaces = [
  ...plan.alive.map(e => e.raw.surface as string),
  ...plan.resumeExisting.map(e => e.raw.surface as string),
];
if (keptSurfaces.length > 0) {
  await log(
    "conductors_restored",
    `count=${keptSurfaces.length} surfaces=${keptSurfaces.map(s => formatSurface(s, "C")).join(",")}`,
  );
}
// partial restore: 復元 pane 数が maxConductors 未満なら不足分を新規 slot で補充
// （R7 廃止 — initializeLayout の事後条件: state.conductors.size === maxConductors を保証）
if (keptSurfaces.length > 0 && keptSurfaces.length < state.maxConductors) {
  await log(
    "layout_kept_partial",
    `kept=${keptSurfaces.length} max=${state.maxConductors}`,
  );
}
const deficit = state.maxConductors - state.conductors.size;
if (deficit > 0) {
  await log(
    "layout_conductors_topup",
    `have=${state.conductors.size} max=${state.maxConductors} adding=${deficit}`,
  );
  const addl = await initializeConductorSlots(
    state.projectRoot,
    state.conductors,
    deficit,
    daemonSurface,
    undefined,
    state.layout,
    state.mainBranch,
    ccBackend(state.backend),
  );
  assignments.push(...addl);
}

return assignments;
```

ログキー命名規則のメモ:
- タスク本文の例 `layout_conductor_補充` は CLAUDE.md の規約「snake_case、英数字のみ」に反するため、**`layout_conductors_topup`** に修正する。
- 既存ログとの整合: `layout_creating_new_slots` / `layout_restore_empty_fallback` / `layout_kept_partial` / `conductors_restored` の命名と揃える。

`layout_kept_partial` のメッセージ末尾の説明文（「pane 補充は行わない（次起動で再構成可能）」）は削除。事実ベースに留める。

### 変更 4: layout-restore.ts - コメントの整合確認（変更不要見込み）

L8 の D 経路定義 `D resume-new-surface  : surface 消失 + running task → 新 pane + session-id resume` は、**変更後の実装挙動に合致する**ため修正不要。

ただし、本タスク前は `applyRestorePlan` 内で D 経路が ready 戻しされていたため、コメントと実装の齟齬があった。本タスクの変更 1+2 で fallback ルートに統合され、ようやくコメント通りの動作になる。

念のため `daemon.ts:1137-1144` の `applyRestorePlan` 内 D 経路コメント（「R7: 復帰時は pane 新規作成しない方針のため、合流先がないので両方とも ready 戻し」）を更新する:

**Before:**
```typescript
// D: resume-new-surface + 未マッチ resume → task-state を ready に戻す
//    R7: 復帰時は pane 新規作成しない方針のため、合流先がないので両方とも ready 戻し
const allUnmatched: ResumePlanItem[] = [
  ...plan.unmatchedResumes,
  ...plan.resumeNewSurface
    .map(e => e.resume)
    .filter((r): r is ResumePlanItem => !!r),
];
```

**After:**
```typescript
// D: resume-new-surface + 未マッチ resume → task-state を ready に戻す
//    partial restore (A or B あり) 経路では D の resume は ready 戻し。
//    後段の事後条件チェックで補充された新 slot に Manager が次 tick で割り当てる。
//    全 discard fallback 経路では initializeLayout 側で D を resumePlan として透過する（T346）。
const allUnmatched: ResumePlanItem[] = [
  ...plan.unmatchedResumes,
  ...plan.resumeNewSurface
    .map(e => e.resume)
    .filter((r): r is ResumePlanItem => !!r),
];
```

### 変更 5: daemon.test.ts - テスト追加・修正

#### 修正

- **`layout_kept_partial` テスト (L3606-3633)**: 文言短縮（説明文削除）+ 補充ログの確認を追加。
  - `expect(logContent).toContain("layout_kept_partial")` は維持
  - **追加**: `expect(logContent).toContain("layout_conductors_topup")` / `expect(logContent).toMatch(/have=1 max=3 adding=2/)`
  - **追加**: `state.conductors.size === 3` を最終確認（補充後の事後条件）
  - mock: `newSplit` を spyOn してカウント検証（既存 M17 系と同パターン）

#### 新規追加（M18 系: 事後条件保証）

- **M18a**: partial restore (A=1) + maxConductors=3 → `layout_conductors_topup adding=2` + newSplit 2 回 + state.conductors.size === 3
- **M18b**: partial restore (A=1, B=1, resumePlan で taskId match) + maxConductors=3 → `adding=1` + newSplit 1 回 + assignments に B の 1 件を含む + state.conductors.size === 3
- **M18c**: 全 discard + D 経路 1 件（surface 消失 + running task）+ resumePlan に該当 taskId → fallback 発動（変更 1）+ resumePlan 透過（変更 2）+ assignments に D の resume を含む + newSplit が `maxConductors` 回呼ばれる
  - 変更前は fallback が発動せず applyRestorePlan で ready 戻し → state.conductors.size === 0 の再現
  - 変更後は state.conductors.size === maxConductors
- **M18d** (任意): partial restore (A=1) + D 経路 1 件 + maxConductors=3 → A は alive、D は ready 戻し（applyRestorePlan の挙動維持）+ 不足 2 を補充 + state.conductors.size === 3 + 該当 taskId は ready で次 tick 待ち

#### 既存 M17 系の影響確認

- **M17a/b/c**: A=B=D=0 の前提なので「条件削減（D の項を消す）」では挙動は変わらない。assertion は維持。
- **M17d**: A=B=D=0、resumePlan は **unmatched**（taskId が team.json と一致しない）。条件変更でも fallback 発動条件を満たすため挙動維持。
  - ただし、変更 2 により `allResumePlan = resumePlan ∪ plan.resumeNewSurface.map(e => e.resume)` の合成になるので、D 経路が空（M17d は task 紐付け無し）なら結合後も resumePlan のみ → 既存 assertion 維持。

### 変更 6: layout-restore.test.ts - テスト変更不要

`planLayoutRestore` のロジックは変更しないため、本ファイルは編集不要。`describe` ブロックの説明文や M4 (D 経路) のコメントは現状のままで意図と整合する。

## TDD 順序

1. **既存 `layout_kept_partial` テストを修正** (daemon.test.ts L3606-3633) — `layout_conductors_topup` 追加と state.conductors.size assertion を追加して fail させる
2. **新規 M18a/M18b/M18c テストを追加** — fail することを確認
3. **daemon.ts 変更 1+2 を適用** — M18c, M17d が pass することを確認
4. **daemon.ts 変更 3 を適用** — M18a/b, 修正済み `layout_kept_partial` が pass することを確認
5. **daemon.ts 変更 4（コメント更新）+ 変更 5 のリファクタリング** を最後に
6. **既存テスト全件 pass を確認**:
   - `cd skills/cmux-team/manager && bun test --timeout 30000 layout-restore.test.ts`
   - `cd skills/cmux-team/manager && bun test --timeout 30000 daemon.test.ts`
   - 周辺テスト（conductor.test.ts 等）

## 検証手順

### 静的検証

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-346-1777204580
bunx tsc --noEmit
```

### 単体テスト

```bash
cd skills/cmux-team/manager
bun test --timeout 30000 layout-restore.test.ts
bun test --timeout 30000 daemon.test.ts
```

### 関連テスト（CLAUDE.md の禁忌に従い 1 ファイルずつ実行）

```bash
cd skills/cmux-team/manager
for f in layout-restore.test.ts daemon.test.ts conductor.test.ts; do
  bun test --timeout 30000 "$f"
done
```

### 手動検証（任意）

cmux クラッシュ→`cmux-team resume` 再現:
1. `cmux-team start` で初期化
2. `cmux kill-server` 等で全 surface 消滅
3. 別シェルから `cmux-team resume` を実行
4. `.team/logs/manager.log` で `layout_restore_empty_fallback` または `layout_conductors_topup` が出ること
5. `jq '.conductors | length' .team/team.json` が `maxConductors` と一致すること

## リスク・注意点

### コードレベル

- **`initializeConductorSlots` の引数順序**: `count` (3 番目) と `resumePlan` (5 番目) を間違えない。変更 3 では `count=deficit`、`resumePlan=undefined`（補充分は新規 slot）。
- **ログキー名**: `layout_conductor_補充` ではなく **`layout_conductors_topup`**（snake_case + 英数字のみ）。命名規則の根拠は CLAUDE.md および既存ログ規約。
- **無限ループ防止**: `state.conductors.size < state.maxConductors` の判定は `applyRestorePlan` 完了**後**の値で 1 回のみ評価する。`initializeConductorSlots` 内部での failure 時に再帰しない。
- **deficit < 0 の取扱**: `deficit = state.maxConductors - state.conductors.size` が負になるケース（state に過剰登録）は applyRestorePlan が `state.conductors.clear()` 後に再構築するため発生しない見込み。`if (deficit > 0)` で防御する。

### state 整合性

- **重複 resumePlan**: 変更 2 で `resumePlan` 引数と `plan.resumeNewSurface` の両方に同一 taskId が入るケースは `planLayoutRestore` の matchedTaskIds で D 経路に入った taskId は外部の resumePlan (main.ts 経由) からも除外される前提。`planLayoutRestore` の入力 `resumePlan` 自体には重複は無いため、結合後も実質的に重複は発生しない。

### テスト整合性

- **`layout_kept_partial` の文言変更**: タスク本文末尾「— pane 補充は行わない（次起動で再構成可能）」を削除する変更により、もしこの文字列を assertion している外部テストがあれば失敗する。grep で確認済み（該当 1 箇所のみ、`layout_kept_partial` のテスト本体）。
- **M17 系の D 経路扱い**: 変更 1 の条件削減で M17a/b/c は影響なし（D=0 のため）、M17d は D=0 + resumePlan unmatched のため変更 2 の合成後も挙動維持。
- **R7 廃止に伴う既存ドキュメント / spec**: `docs/spec/07-state-machine.md` 等で R7 の前提を記述している箇所があるか別途確認が必要（**本タスク範囲外、後続タスクで docs-sync**）。

### 観測性

- **新ログキー `layout_conductors_topup`**: dashboard / trace DB の集計に新キーを追加する場合は別タスクで対応（`docs/spec/01-skill-cmux-team.md` 等）。本タスクではログ追加までで完結。
