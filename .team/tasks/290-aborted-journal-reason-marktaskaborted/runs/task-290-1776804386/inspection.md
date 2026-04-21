# T290 Inspection Report

- Inspector: inspector-1 (task-290-1776804386)
- Date: 2026-04-22
- HEAD: `e166817908907d8da281fed3ce1fe0193441f7fc`
- base (main): `c9b8bc163da8e84b7269242c7726e39924351a70`
- 対象コミット: 9 commits（C1〜C8 + e166817 refactor）すべて `(T290)` suffix あり

## Verdict: GO

すべての Step 1〜6 が構造的に pass。Design Reviewer Recommendations（C1 / Option A）も適用済み。
tsc 残 3 件は main と同一の pre-existing エラーで、T290 起因の新規エラーは 0 件。

---

## Step 1: Plan §7 Checklist (A–H)

| 項目 | 期待 | 結果 | 判定 |
|---|---|---|---|
| **A** `status: "aborted"` 直接代入 | 1 箇所（task.ts:markTaskAborted 内） | `task.ts:496` のみ | ✅ |
| **B** `log("task_aborted"` 呼び出し | 1 箇所 | `task.ts:514` のみ | ✅ |
| **C** `cascadeAbortToChildren(` 呼び出し | 2 callers + 1 definition | caller: `task.ts:502`（markTaskAborted 内） + `main.ts:3764`（cmdDeleteTask）／definition: `task.ts:591` | ✅ |
| **D** `rg 'reason=[a-z_]+;' task.ts` | markTaskAborted 内 template literal 1 箇所 | 0 件（template literal は `reason=${reason};` で placeholder のため literal regex とは非マッチ。journal 組み立ては `task.ts:479` に 1 箇所存在） | ⚠️ see note below |
| **E** 旧 format prefix ハードコード（detail 生成側） | 0 件 | 0 件 | ✅ |
| **F** `formatAbortedTaskLine(` 出現 | helper 定義 1 + 呼び出し 3 = 計 4 | `main.ts:287`（定義）+ `3079` + `3113` + `3329`（呼び出し） | ✅ |
| **G** 旧 template `was aborted: ${st.journal` | 0 件 | 0 件 | ✅ |
| **H** journal 文字列側の `reason=judgment_pending` リテラル | 無いこと | コード側ヒットは `daemon.ts:3121` のコメント 1 件のみ（残りは test / parser 側） | ✅ |

### D 項目に関する Inspector の補足

Plan §7.2 D の grep `rg -n 'reason=[a-z_]+;' skills/cmux-team/manager/task.ts` は **テンプレートリテラル `reason=${reason};` を literal として要求している**が、実装上は `${reason}` プレースホルダなので literal `[a-z_]+` regex とはマッチしない（構造上正しい）。実体の journal 組み立てコードは `task.ts:479`:

```ts
const journal = detail ? `reason=${reason}; ${detail}` : `reason=${reason};`;
```

で 1 箇所のみ存在。impl-report.md §2(D) は `rg 'reason=\$\{reason\}'` を使って 1 件ヒットを確認済み。プラン側の grep パターン記述の微細なズレで、**実装の構造的正しさには影響しない**。

---

## Step 2: Tests & tsc

### bun test

```
982 pass
0 fail
2340 expect() calls
Ran 982 tests across 35 files. [44.04s]
```

✅ Implementer の主張（982 pass / 0 fail）を独立再現。

### bunx tsc --noEmit

- **task-290 HEAD (e166817):** 3 件
  - `conductor.ts(201,3) TS1016: A required parameter cannot follow an optional parameter.`
  - `daemon.test.ts(3956,9) TS2322: Type '"new_session"' is not assignable to type ...`
  - `daemon.ts(1597,22) TS2352: Conversion of type 'string | undefined' to type ...`

- **main (c9b8bc1) 独立再現:** 3 件（完全に同一の error id・ファイル・行）

→ **T290 起因の新規エラー 0 件** ✅

補足: impl-report の「main 5 件 → task-290 3 件（2 件削減）」は Inspector の再現では 3 件 → 3 件だった。`daemon.test.ts:4854-4855` の `result.abortedTaskIds` / `result.modified` は main 側の `ApplyResumeTransitionsResult` 旧型定義では合法（プロパティが存在する）ため tsc は無エラー。T290 で型を変更した test も同時に書き換えられたため、新規エラーは発生しない。**差分「2 件削減」は Implementer の intermediate state のスナップショットと思われる。** 最終状態の不変条件（新規エラー 0）は満たしているので GO 判定に影響しない。

---

## Step 3: Recommendations 適用

### C1 修正（detail 空時も末尾 `;` を付与）

`task.ts:479`:
```ts
const journal = detail ? `reason=${reason}; ${detail}` : `reason=${reason};`;
```

✅ 三項演算で空 detail 時も `;` を付与。parseAbortJournal regex `/^reason=([a-z_]+);\s?(.*)$/s` との対称性を確保。

### Option A 採用（idempotent skip 時に markTaskAborted 内で task_aborted log emit しない）

`task.ts:479-494` を読み取り:
```ts
if (current?.status === "closed" || current?.status === "aborted" || current?.status === "deleted") {
  return { revertedChildren: [], journal, idempotentSkip: true, existingStatus: current.status };
}
```

early return で log emit なし。`log("task_aborted", ...)` は `task.ts:514` の active path にのみ存在。✅

呼び出し側（daemon.ts:handleConductorDone）は `conductor_done_unresolved_skip` を従来通り emit する設計で、Option A 提案通り。

---

## Step 4: T269 構造 assert（journal prefix / log reason 乖離永続ガード）

`daemon.test.ts` で以下 2 テストが `toMatch(/^reason=judgment_pending;/)` で journal prefix を構造的に assert:

- `daemon.test.ts:4470` — judgment_pending rebase_conflict case
- `daemon.test.ts:4610` — judgment_pending another scenario

加えて `daemon.test.ts:4472` / `:4611` で `task_aborted task_id=X reason=judgment_pending` を log 側でも assert。**journal prefix と log reason が同一 variable `reason` を共有している**ため、helper 構造として再発不能な形に仕上がっている。

✅ T269 type deviation regression guard 成立。

---

## Step 5: parseAbortJournal 網羅

`task.test.ts` の該当 describe block:

| テスト | カバー |
|---|---|
| **T9** | new format 4 ケース（`reason=user_clear; ...` / `reason=abort_task;` detail 空 / `reason=judgment_pending;  C[5]` 空白 2 個 / `reason=disconnect_timeout; line1\nline2` multiline） |
| **T10** | 旧 format 6 種すべて（`user_clear:` / `assign_failed:` / `disconnect_timeout:` / `conductor_done_unresolved:` → judgment_pending 推定 / `[resume] lost worktree` / `[resume] missing session id` / `[resume] missing task run id`） |
| **T11** | 完全未知（`中断: T290 arbitrary user text`）→ reason=undefined / detail=raw |
| **T12** | undefined / 空 → `{ raw: "" }` |

✅ Plan §7.6 K（最低 8 ケース）を満たす（実際は 4 + 7 + 1 + 2 = 14 assertion）。

---

## Step 6: 既存テスト回帰

`main.test.ts:1434` で detail 内一致保証を確認:

```ts
expect(target.detail).toContain(".team/tasks/1-foo/runs/task-1-123/");
```

✅ applyResumeTransitions シグネチャ変更後も、`buildResumeAbortJournal` が生成した detail 文字列に taskRunId / artifacts path が含まれる不変条件を維持。旧 format task-state.json を読み込んでも parseAbortJournal が best-effort で reason 推定するため crash しない構造。

---

## Minor observations（GO でも可）

1. **await-task / printSummaries 出力フォーマットの plan とのズレ（非 blocker）**

   Plan §4 破壊的変更節には「After: `Task 1 was aborted: [user_clear] C[5] ...`」と記載されていたが、実装は `main.ts:292`:

   ```ts
   return `Task ${id} aborted [${reason}]: ${detail}`;
   ```

   で「`Task N aborted [reason]: detail`」形式（"was" 無し・`:` は bracket の後）になっている。

   - 要件（task.md「reason が先頭に明示」）は達成しているため機能的には合格
   - ただし plan §4.3 との文言ズレは、plan と impl の乖離記録として残る
   - 対応案: (a) plan 側の例示を現状に合わせて更新する or (b) impl 側を plan の文言通り `Task N was aborted: [reason] detail` に戻す。どちらも T290 GO 後の追補で足る

2. **Checklist D grep パターンの semantic ズレ（非 blocker）**

   Plan §7.2 D の `rg 'reason=[a-z_]+;'` は template literal `${reason}` にマッチしないので、0 件 = 合格 or 不合格 かがパターンだけでは判断できない。将来 inspection を再実行する際は `rg 'reason=\$\{reason\}'`（Implementer が採用したパターン）を plan に採録すると機械的検証が確実になる。

3. **impl-report の tsc 件数カウントの軽微な不整合**

   impl-report §2(J) は「main: 5 件 → task-290: 3 件」と記載だが、Inspector の main (c9b8bc1) 再現では **3 件** だった。`daemon.test.ts:4854-4855` は旧型で合法なため tsc エラーになっていなかった模様。不変条件（**T290 起因の新規 tsc エラー 0 件**）は満たすので GO に影響しないが、impl-report の文言を「main 3 件 → task-290 3 件、新規エラー 0」に修正するのが実態に即す。

---

## Critical findings

なし。

---

## Fix Required

なし。Minor observations 1〜3 は GO 後の追補で足る。

---

**Inspection 完了。T290 は GO 判定。**
