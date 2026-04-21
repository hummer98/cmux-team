---
role: design-reviewer-254
task_id: 254
plan_reviewed: .team/tasks/254-task-unique/runs/task-254-1776514256/plan.md
date: 2026-04-18
---

## Verdict: Approved

## Summary

plan.md は A015 (a) の 4 シナリオを正しく整理し、runtime 検査（assignTask 先頭）と起動時整合性チェック（cmdStart）の 2 段構えで unique 制約を不変条件として配置する設計になっている。既存の `AssignTaskError("task")` / `resetConductor(targetStatus: "broken")` / `conductor_taskid_reconciled` との統合は正しく、行番号・関数シグネチャ・既存パターンとの整合性も実コードで確認した範囲で一致している。Critical findings は 0 件、CRITICAL チェック項目は全てパス。Minor findings が 4 件あるが実装の妨げにはならない範囲であり Approved とする（Recommendations を後段に記載）。

---

## CRITICAL チェック項目

| 項目 | 判定 | コメント |
|------|------|---------|
| サブタスクカバレッジ | ✅ | 変更対象 3 ファイル（task.ts / conductor.ts / main.ts）が S1〜S5 に分割され、S6 で E2E テストまでカバー |
| 統合テスト/検証 | ✅ | S6 で T1〜T4 の手動 E2E を定義（プロジェクト方針「自動テストなし」に準拠） |
| 削除タスクの完全性 | ✅ | 本タスクは追加のみで旧実装置き換えなし（§3.3 / §4 末尾の「削除タスク必須」節で明示） |
| 既存テストへの影響 | ✅ | 自動テストは存在しない。既存 E2E への回帰リスクは S6 T3/T4 で false positive を確認する構成 |
| コードベースとの照合 | ✅ | `assignTask` (`conductor.ts:258`) / `cmdStart` の resume build (`main.ts:575-613`) / `TaskState.conductorSlot` (`task.ts:44`) / `conductor_taskid_reconciled` (`daemon.ts:864-879`) / `scanTasks` の `e.kind==="task"` 分岐 (`daemon.ts:2104-2143`) / `resetConductor(targetStatus)` (`conductor.ts:502-588`) が全て実在を確認 |

---

## Findings

### F1. [Minor] D6 の因果説明が不正確（実装時の混乱リスク）

plan.md §2.2 / §4 S4 / §7 D6 は以下のように説明している:

> applyRestorePlan の `conductor_taskid_reconciled` は taskState が assigned でない surface を idle に倒すため、この後段で明示的に broken へ上書きする。

しかし実コードは:

1. `cmdStart` は `main.ts:579` で `taskState` をローカル変数にロードする
2. S3 で `taskState[v.taskId].status = "ready"` を**インメモリで**書き換え、`taskStateModified = true` にする
3. `initializeLayout` (`main.ts:653`) → `applyRestorePlan` (`daemon.ts:852-995`) が走る
4. `applyRestorePlan` は `daemon.ts:860` で `loadTaskState` を**再実行**し、disk から読み直す
5. main.ts は `saveTaskState` をまだ呼んでいない（`main.ts:677-679` で initializeLayout の**後**に save）ため、applyRestorePlan が見る taskState は**古い "assigned" のまま**
6. したがって `conductor_taskid_reconciled` の条件 `ts?.status !== "assigned"` は**成立せず taskId はクリアされない**。Conductor は team.json の `running` 状態のまま復元される

**結果的には問題なし** — S4 の `resetConductor(targetStatus: "broken")` は呼び出し前の status を問わず強制的に broken に倒すため、最終状態は plan の期待通りになる。ただし:

- 実装者が D6 を信じて「conductor_taskid_reconciled が idle に倒した後で broken に上書きする」挙動を期待すると、E2E テスト T2 で `conductor_taskid_reconciled` ログが出ないため「実装が壊れた」と誤判断する可能性がある
- ログの順序は `task_unique_violation_startup` → `conductor_broken reason=unique_violation` のみで、`conductor_taskid_reconciled` は出ない

**Severity: Minor** — 最終的な受け入れ基準（§5.3 T2 の期待ログ）は `task_unique_violation_startup` と `conductor_broken` のみで、`conductor_taskid_reconciled` は含まれていない。よって **S6 T2 の判定は問題なく通る**。ただし plan の説明と実挙動が乖離しているため、実装時の混乱を避けるため Recommendations で修正を提案する。

---

### F2. [Minor] task.md 項目 2（`resume_fallback_to_ready` の条件見直し）がスコープから外されているが、D5 の根拠説明が事実と異なる

task.md §やること は 4 項目あり、plan は項目 2「`resume_fallback_to_ready` の条件を見直し」を明示的にスコープ外としている。

D5:

> task.md で明示的にスコープ外と指定されている

しかし task.md §やること 項目 2 を確認すると:

```
2. `resume_fallback_to_ready` の条件を見直し:
   - 元 Conductor surface が team.json に残っていて PID が生きている場合は
     ready 化せず broken 状態で保持
   - worktree が残っていて sessionId も生きているなら resume を試みる
```

これは「やること」として明記されており、「スコープ外」と書かれているわけではない。D5 の根拠は誤っている。

**補償機構としての妥当性**: plan の runtime 検査（S2）は「assignTask 時に unique violation を検出して abort」するため、resume_fallback_to_ready が誤って ready 化しても、次の assign で検出・abort される。つまり資源として「片方が走ったまま他方が走り出す」事態は防げる。したがって資源上は scope reduction しても A015 (a) の目的は達成できる。

**ただし task.md 項目 2 が意図した挙動（team.json に残る Conductor PID が生きている場合に broken 保持）は本 plan では実現されない。** これは「同じ問題を別経路で解決する」のではなく「別の改善点をドロップする」選択。

**Severity: Minor** — task.md が設計判断を委ねている(`## 判断が必要なポイント` 節が存在するため)。ただし D5 の説明は修正が必要。

---

### F3. [Minor] `detectStartupUniqueViolations` のケース 3（cross-check）のロジックが曖昧

plan §4 S1 の変更内容:

> 3. task-state.json の assigned エントリで `conductorSlot` が team.json に存在する Conductor の surface と一致しない場合も violation（cross-check）

この記述は 2 通りに解釈できる:

- **解釈 A**: `taskState[X].conductorSlot = "surface:5"` だが team.json.conductors に `surface:5` が**一切存在しない**（stale slot） → violation
- **解釈 B**: `taskState[X].conductorSlot = "surface:5"` だが team.json に `{surface: "surface:7", taskId: X}` がある（別 surface が同 taskId を主張） → violation

**解釈 A を violation とすると false positive 増加**: Conductor 異常終了後に conductorSlot が残ったまま taskState が "assigned" の場合、何も進行していないのに「violation」として記録される。この場合は既存の `resume_fallback_to_ready` 経路で処理すべきで、broken 化 + ready 化は過剰対応。

**解釈 B が真の duplicate running**: A015 (a) の本質的なターゲット。

plan の記述では A/B どちらを採るか曖昧。実装者が解釈 A を採ると false positive が増え、T3（false positive なし）テストで予想外の違反が出る可能性がある。

**Severity: Minor** — 実装時に明確化すればよい。Recommendations で明示化を提案。

---

### F4. [Minor] main.ts の `taskStateModified` 経路と applyRestorePlan 内部 save の上書きレース（既存リスクの増幅）

plan の S3 で `taskStateModified = true` の発火点が 1 つ増える。既存コードでは以下の流れ:

1. `main.ts:579` で `taskState` を disk から load
2. (S3: violation 検出で taskState 書き換え + taskStateModified=true) ← 本タスクで追加
3. (既存) `main.ts:598-604` resume_fallback_to_ready で taskState 書き換え
4. `initializeLayout` → `applyRestorePlan` が**独立に** taskState を load (`daemon.ts:860`) → 変更（`daemon.ts:924-926`）→ save (`daemon.ts:989-993`)
5. main.ts に戻り、`main.ts:677-679` で `saveTaskState(PROJECT_ROOT, taskState)` を実行 — ここで main.ts ローカルの taskState が applyRestorePlan の save 結果を**上書き**する

既存コードでも rally-missing-late（applyRestorePlan の更新）と resume_fallback_to_ready（main.ts の更新）が**別 taskId に対して**同時に発火するとレースする可能性があるが、現状は偶発的。S3 で発火点が増えることでレース確率が上がる。

**発生シナリオ**: taskId X が unique violation、taskId Y が worktree-missing-late。violation 検出で X を ready に（main.ts 側）、applyRestorePlan が Y を ready に（自身の save）、最後に main.ts が save してapply側の Y の変更を**消してしまう**（main.ts 側は Y の古い assigned を持っているため）。

**影響**: Y は「assigned のままだが worktree なし」で残り、次回 scanTasks で resume_fallback_to_ready が再度発火（ループに陥らない、冪等）。実害は限定的。

**Severity: Minor** — 既存リスクで本タスクの新規問題ではない。しかし plan §5.1 の「既存機能への影響」に一言触れるべき。

---

## Recommendations

以下は Approved 前提の改善提案。**Recommendations に従わなくても判定は Approved**だが、plan の明瞭性向上のため実装者に伝える。

### R1. F1 対応: D6 の説明を実挙動に合わせて修正

現状の D6 を以下のように書き換えることを推奨:

```markdown
| D6 | 起動時違反 Conductor を broken に倒すタイミング | `initializeLayout` 完了後の後追い適用 |
| | | applyRestorePlan 内部で loadTaskState を再実行するため、S3 でインメモリに書いた taskState=ready は applyRestorePlan には伝わらない（main.ts の saveTaskState は initializeLayout の後で走る）。したがって違反 Conductor は team.json の status（通常 running）のまま A 経路で復元される。S4 の resetConductor(targetStatus="broken") はこの running を強制的に上書きして broken にする。planLayoutRestore のマトリクス拡張は変更範囲過大のため採用しない。 |
```

さらに S6 T2 の期待ログから `conductor_taskid_reconciled` が**出ないこと**を明記すると、実装者が E2E 判定で迷わない。

### R2. F2 対応: D5 の根拠を修正し、scope reduction の判断を明示

以下のように書き換えを推奨:

```markdown
| D5 | `resume_fallback_to_ready` (`main.ts:601`) の条件見直し（task.md 項目 2） | 本 plan ではスコープ外 |
| | | 本 plan の runtime unique 検査（S2）により、resume_fallback_to_ready が誤って ready 化しても次の assignTask で unique violation が検出され task abort される。A015 (a) の目的（資源の二重占有を防ぐ）は達成できる。ただし task.md 項目 2 が意図する「Conductor PID 生存時は broken 保持」は本 plan では実現しない。必要なら別タスクとして起票する。 |
```

### R3. F3 対応: cross-check ケースの定義を明確化

plan §4 S1 の検査ロジック 3 を以下のように書き換える:

```markdown
3. task-state.json の assigned エントリで `conductorSlot=S_A` が設定されており、かつ team.json.conductors に `{surface: S_B, taskId: X}` が存在し S_A !== S_B の場合（同一 taskId に対して異なる surface を主張する cross-source の不一致）を violation として記録する。

（※ conductorSlot が team.json に一切見つからない「stale slot」は violation としない — 既存の resume_fallback_to_ready / conductor_taskid_reconciled 経路で処理されるべきで、本検査で扱うと false positive が増える）
```

### R4. F4 対応: §5.1 に save レース可能性を追記

plan §5.1 のリスク表に 1 行追加を推奨:

```markdown
| main.ts `saveTaskState` (`main.ts:677-679`) が applyRestorePlan 内部の save を上書きする | 同 tick で taskStateModified=true + applyRestorePlan が worktree-missing-late を save するケース | 既存リスク。S3 で発火点が増えるが発生確率は低い。Minor。plan の変更範囲を抑えるため本タスクでは対処しない。 |
```

### R5. 実装ヒント（コード規約上の細かい点）

- `detectStartupUniqueViolations` の第 2 引数で `teamJson.conductors` を受け取る際、plan のコードスニペット `as any` 使用は既存コードと整合するが、`schema.ts` の `ConductorState` の subset 型として `Array<Pick<ConductorState, "surface" | "taskId">>` を使う方が望ましい（F3 を実装する際に ts-ok を保証しやすい）。
- ログで `surface` を出す箇所は `formatSurface(surface, "C")` を使うこと（CLAUDE.md「ロギングポリシー §surface 表記」）。plan のサンプルに `surface:S1` とベタ書きされているが、実装時には `formatSurface` で `C[S1]` に変換する。
- S3 の catch 節の error log は `e.message` のみ記録しているが、CLAUDE.md「ロギングポリシー §外部コマンド失敗時」の方針に従い `e.stack` や `e.stderr` があれば含めること（ここは外部コマンドではないので `e.message` のみで許容範囲だが、念のため）。

---

## 設計原則との整合

| 観点 | 判定 | コメント |
|------|------|---------|
| 根本対策か | ✅ | 対症療法ではなく不変条件（invariant）として検査を配置。runtime + 起動時の 2 段構えで race の大半をカバー |
| AI の手抜き防止 | ✅ | 「変更が大きい」を理由に妥協せず、既存 `AssignTaskError` / `resetConductor` / `conductor_taskid_reconciled` と統合する筋の良い設計 |
| DRY / SSOT | ✅ | task-state.json を真のソース、team.json を cross-check 観測値と位置付け（D3）。既存 atomic save を再利用（§2.3）。新規 `findAssignmentConflict` / `detectStartupUniqueViolations` を task.ts に配置し責務を task 層に閉じている |
| 不要な複雑さ | ✅ | 新規ファイルなし、新規 state 型なし、既存 3 ファイルへの追加のみ |
| セキュリティ | ✅ | 外部プロセス書換（S1）への防御としても機能する。コマンドインジェクション / path traversal 懸念なし（JSON 解析のみ） |
| 既存パターンとの整合 | ✅ | `AssignTaskError("task")` + `resetConductor(targetStatus, reason)` + `log(event_name, detail)` の既存パターンに忠実。ログイベント名も `task_unique_violation_runtime` / `task_unique_violation_startup` と既存の snake_case + 接尾辞で区別する命名規則に従う |

---

## 総評

plan.md は A015 (a) の課題分析から技術アプローチ、サブタスク分割、リスク評価、Decision Log まで一貫して設計されている。実コードとの照合で行番号・関数シグネチャ・既存パターン参照は全て一致しており、実装時に大きな障害はない。

Minor findings は主に「plan の説明が実挙動と一部乖離している」「scope reduction の根拠が不正確」といった文書レベルの問題で、実装判断には影響しない。Recommendations に従って plan を更新すると実装者の理解を助けるが、更新しなくても **S6 T1〜T4 の受け入れ基準は満たせる**。

したがって **Approved** とする。実装開始後に発見される論点があれば、別タスクとして継続議論する形で問題ない。
