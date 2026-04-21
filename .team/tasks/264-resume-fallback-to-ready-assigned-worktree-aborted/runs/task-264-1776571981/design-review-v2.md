# Design Review — T264 plan v2

## Verdict: Approved

## R1-R5 取り込み確認

| ID | Recommendation | 判定 | 根拠 |
|----|---------------|------|------|
| **R1 (task_aborted 両方 emit)** | `resume_marked_aborted` と `task_aborted reason=resume_*` の両方 emit | **Accepted** | S3 (main.ts:329-351 の新規実装コード) に `resume_marked_aborted` → `task_aborted` → `child_reverted_to_draft` の 3 段 emit が明示。D11 / D12 に理由と順序の根拠を追加。§2 比較表で 5 経路目として追記済み |
| **R1 (cascade 呼び出し)** | `cascadeAbortToChildren` 呼び出し + `allTasks` 事前ロード | **Accepted** | S2 wrapper の `for` ループ内で `cascadeAbortToChildren(taskState, allTasks, taskId)` を同期呼出、S3 で `const { tasks: allTasksForResume } = await loadTasks(PROJECT_ROOT)` を resume ループ直前に配置。D2 を「呼ぶ」に改訂し不変条件（cascade の 5 経路 → 6 経路化）の論理も明記 |
| **R2 (wrapper 副作用検証)** | logger モック or 戻り値で emit / cascade 副作用検証 | **Accepted (戻り値経路)** | R2 の 2 案のうち **戻り値経路を選択**。wrapper 自体は emit せず `abortedTaskIds` / `abortReasons` / `journals` / `revertedChildrenByParent` を返す設計（S2）。S5 テスト (c) で `revertedChildrenByParent["1"]=["2"]` + `taskState["2"].status==="draft"` + journal の `parent_aborted: 1` 追記を検証する計画。logger モック不要で副作用検証が成立する妥当な割り切り |
| **R3 (grep 手順明文化)** | S6 に grep 手順を追加 | **Accepted** | S6 に実装前後で実行する 5 種の `rg` コマンド（旧キー 0 件維持、新キー増加、reason=resume_* 衝突チェック、bun test 全体 green）と期待値が列挙済み |
| **R4 (新 reason 波及)** | ドキュメント同期タスクに新 reason を反映 | **Accepted** | S7 に (a) `task.ts:94` コメント更新、(b) CLAUDE.md §依存タスクの cascade を「5 → 6 経路」更新、(c) エラーリカバリ節に 3 reason (`resume_no_worktree` / `resume_no_session_id` / `resume_no_task_run_id`) 追記、(d) A015 artifact は歴史的記録として保持、が具体的に記載 |
| **R5 (helper 配置先)** | `task.ts` に `detectStartupUniqueViolations` と同居させる案 | **Accepted** | D7 を `resume-classify.ts` 新規作成 → `task.ts` への追記に改訂。「新規作成するファイル: なし」と§3 に明記。配置先は `detectStartupUniqueViolations` の直後・`cascadeAbortToChildren` より前 |

全 R1-R5 取り込み済み。R2 は「logger モック」ではなく「戻り値検証」に寄せたが、Finding 3 の意図（組み立てミス検知）は戻り値 4 項目で十分カバーされる。

## Summary

v2 は Round 1 の 5 つの critical/major/minor 指摘を全て反映している。特に critical 2 件（`task_aborted` emit 欠落・cascade 省略）は S2 wrapper + S3 呼び出し側への責務分離で解消され、D2 と D11/D12 に設計根拠が残された。新たな critical / major 問題は検出されず、残る懸念は minor 3 件（テスト型キャスト・wrapper の `modified` セマンティクス・E2E emit 順序検証の手動化）のみで、いずれも実装時に容易に対処できる範囲。

## Findings

### 1. S5 テストデータ (c) の TaskMeta 型充足 — **minor**

S5 ケース (c) は `allTasks = [{ id: "1", dependsOn: [] }, { id: "2", dependsOn: ["1"] }]` としているが、`TaskMeta` は `title` / `status` / `priority` / `runAfterAll` / `exclusive` / `filePath` / `fileName` / `createdAt` を必須としている（`task.ts:9-30`）。テストを書く際は minimal factory（例: `makeTaskMeta({ id, dependsOn })`）を用意するか `as TaskMeta[]` キャストが必要。`bun test` 実行時に型エラーとなる可能性あり。plan に「テストヘルパで最小 TaskMeta を生成すること」を明記するとなお安全だが、実装段階で気づけるため plan 本文の修正は必須ではない。

### 2. wrapper 戻り値 `modified` が cascade 副作用を反映しない — **minor**

S2 の `applyResumeTransitions` は、abort 経路に入った時点で `modified = true` をセットする。親が abort されると cascade で子 state も変更されるが、wrapper の `modified` は既に `true` なので `taskStateModified = true` 伝播に支障はない。ただし「親が abort に遷移しなかったが子だけ cascade で変わる」ケースは構造上発生しないので、実害は無い。将来 wrapper を単独で呼ぶ場面が来たとき混乱の種にならないよう、`modified` コメントに「cascade 副作用も含む」と 1 行補足するだけで可読性が上がる（任意）。

### 3. cmdStart の emit 順序 E2E 検証が手動 — **minor**

S5 は wrapper の戻り値を検証するが、呼び出し側（cmdStart）の `resume_marked_aborted` → `task_aborted` → `child_reverted_to_draft` という emit 順序が本当に維持されているかは plan §5 の「手動検証」項に委ねられている。cmdStart 本体のテストは他にも無いため本 PR で増やすのは overkill、現状の割り切りは妥当。ただし plan §5 の手動検証手順に「ログの行順序を `grep -E '(resume_marked_aborted|task_aborted|child_reverted_to_draft)' manager.log` で 1 タスクあたり正しい並びになっているか確認する」と 1 文追加しておくと運用で効く（任意）。

### 4. journal 文字列の injection / path traversal リスクなし — **minor (確認のみ)**

`buildResumeAbortJournal` で組み立てる文字列には以下が入る:
- `ts.taskRunId`: daemon が `task-NNN-TIMESTAMP` 形式で生成する内部値（外部入力なし）
- slug: `basename(dirname(taskFile))`（basename が path separator を除去）
- summary: 固定文字列 3 種

いずれも信頼できる内部値であり、journal は **ログ表示用の文字列**でファイル操作には使われない。injection / path traversal のリスクなし。セキュリティ観点で問題なし。

### 5. slot 超過との相互作用 — **minor (確認のみ)**

resume ループ (702-726) → slot 超過ループ (738-743) の順序は不変。wrapper で aborted 化されたタスクは `rawResumePlan` に push されないため、slot 超過ループは `taskState[overflow.taskId]` を触っても既に `status=aborted` なので問題にならない…のだが、**`taskState[overflow.taskId] = { ...taskState[overflow.taskId], status: "ready" }`（main.ts:740）が実行されると aborted を ready に戻してしまう可能性**がある。

実際には `rawResumePlan` は resume 成功タスクのみ push されるので、aborted 化されたタスクは `rawResumePlan.pop()!` で取れない。したがってこの経路には入らない。§5 リスク表「slot 超過 (`resume_overflow_to_ready`) 経路: 本 PR では触らない。D1 参照」と整合し、問題なし。S3 注意3 にも明示されている。

### 6. 既存 aborted 化経路との比較表の完全性 — **minor**

§2「既存 aborted 化パスとの整合性」の表は 5 経路を並べており、`daemon.ts:2136 (user_clear)` / `:2314-2317 (assign_failed)` / `:2685-2688 (disconnect_timeout)` / `main.ts:3225 (cmdAbortTask)` / `main.ts:3266 (cmdAbortTask 別ブランチ)` に加え T264 新規行を追記している。design-review R1 で挙げた 4 経路（user_clear / disconnect_timeout / assign_failed / cmdAbortTask）を網羅しており、比較観測性の不変条件維持に必要な情報は揃っている。問題なし。

## CRITICAL チェック項目

| チェック項目 | 判定 | 根拠 |
|-------------|------|------|
| サブタスクカバレッジ | **Pass** | S1-S7 で helper 追加・wrapper 切り出し・呼び出し側書き換え・pure helper テスト・wrapper 統合テスト・grep 検証・ドキュメント同期を網羅 |
| 既存テスト影響（grep 手順） | **Pass** | S6 に 5 種 rg コマンド + bun test 全体 green を明示 |
| 削除タスク（旧キー完全撤去） | **Pass** | S3 注意1・S7 明示・D10 でドキュメント系のみ残存を許容 |
| `sessionId` 欠損ケース | **Pass** | D3 で両方 aborted 化の単一ポリシー、S4 ケース 1 で検証 |
| `resume_overflow_to_ready` の扱い | **Pass** | D1 明示・S3 注意3 で不触を確認 |
| 観測性（`task_aborted` 網羅性） | **Pass** | D11 で両方 emit、D12 で順序、§2 比較表で 5 経路整合 |
| cascade 不変条件（T241 の 5 経路）| **Pass** | D2 改訂で 6 経路目に足す、S2 wrapper 内で `cascadeAbortToChildren` 同期呼出、S3 で `allTasks` 事前ロード |

CRITICAL 全 Pass + Finding に critical 0 / major 0 / minor 6（うち 3 件は確認のみ）。

---

Approved 判定。Implementer 進行可。軽微な改善余地（Finding 1-3）は実装時に吸収可能なレベル。
