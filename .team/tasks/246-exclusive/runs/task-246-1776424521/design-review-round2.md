# T246 plan.md Design Review — Round 2

**レビュー対象**: `/Users/yamamoto/git/cmux-team/.team/tasks/246-exclusive/runs/task-246-1776424521/plan.md` (rev 2)
**前回レビュー**: `design-review.md`（Changes Requested / Recommendations 1〜9）

## 1. 総評

**Approved**

前回指摘した主要 6 点（Recommendations 1〜6）は全て具体的に反映され、軽微 3 点（7〜9）も plan 本文に織り込み済み。実装時に迷う余地のある箇所は解消されている。§9 の実装順序に従って着手してよい。

## 2. 主要 6 点の反映状況

### 2.1 §2 表の `schema.ts` 行の扱い → **Reflected**

- plan §2 の表で `schema.ts` 行に「**変更なし**（理由は §3 参照。現状 task frontmatter の Zod schema は未定義のため、conductor-prompt.md の『schema 更新』指示は `TaskMeta` 拡張で読み替える）」と明示されている（plan.md:34）。
- §3 本文も「採用案: `TaskMeta` 拡張のみ（`schema.ts` は変更しない）」と言い切っており（plan.md:67-70）、§2 と §3 の矛盾は解消。
- 前回指摘の「表を読んだだけの実装者が schema.ts を変更対象と誤認する」リスクは消えた。

### 2.2 `RUN_AFTER_ALL_CONFLICT` 緩和条件（4 ケース表 + 具体的判定式） → **Reflected**

- plan §5「`RUN_AFTER_ALL_CONFLICT` 緩和条件」に TypeScript の具体判定式が掲載されている（plan.md:214-227）:
  ```ts
  const conflict = tasks.find(
    (t) => t.runAfterAll && t.status !== "closed" &&
           !(exclusive && t.exclusive),
  );
  ```
- 4 ケース表（plan.md:231-236）も全行埋まり、各ケースの「判定式の動き」まで明示されている。
- 特にケース 3（新規=非排他 run_after_all / 既存=exclusive）は「従来互換優先でエラー」と方針を確定し、user-visible な挙動変化として注釈付き（plan.md:238-240）。Notes / README / CLAUDE.md への転載指示も §6 に入っている。

### 2.3 §4 D の方針決定（A か B か） → **Reflected**

- plan §4 冒頭で「**A 案を採用**: `parseTaskMeta` で `exclusive=true` なら `runAfterAll=true` を強制セットする」と明記（plan.md:108-110）。
- B 案を採用しない理由（3 つ）も列挙され、`filterExecutableTasks` / `filterRunAfterAllTasks` / `normalActive` / `dependsOnRunAfterAll` は無変更で済むことが明言されている（plan.md:112-118）。
- 代わりに `scanTasks` に `exclusiveLocked` ガードと `exclusive_lock_active` ログを追加する実装が §4 後半に具体コードで書き下されている（plan.md:130-162）。配置上の注意（taskList 差分通知の後ろ・ratelimit ガードと同じ層）まで明示されており、実装時の迷いは少ない。

### 2.4 `sortByPriority` への ID 昇順二次キー → **Reflected**

- plan §5 の「exclusive 同士の順序保証」に TypeScript コードで二次キーの実装が示されている（plan.md:249-257）:
  ```ts
  if (pa !== pb) return pa - pb;
  return a.id.localeCompare(b.id);
  ```
- §9 実装順序のステップ 2 にも「`sortByPriority` に ID 昇順二次キー追加」が組み込まれている（plan.md:462-463）。
- 副次効果（全タスクの順序を決定的にする）への注意書きもあり、未決事項が解消されたことがわかる。

### 2.5 release.md の 4 箇所記載 → **Reflected**

- plan §2 の release.md 行に「変更（**4 箇所**。§7 と整合）」と明記（plan.md:58）。
- §7 の表も 4 行（3 行目 description / 8 行目本文 / 33 行目 CLI / 188 行目注意書き）に整備され（plan.md:378-383）、§2 と §7 の数え方の食い違いは解消。

### 2.6 テスト観点への `run_after_all` 併存検証追加 → **Reflected**

- plan §8 の手動 E2E に「**7. `run_after_all` と `exclusive` の併存検証（§2.6 観点、両方向）**」が追加されている（plan.md:439-449）。
  - 順方向（非排他 run_after_all → 後起票 exclusive = ケース 2 エラー）
  - 逆方向（exclusive → 後起票 非排他 run_after_all = ケース 3 エラー）
  - exclusive 同士（ケース 1 許可、ID 順で順次実行をログ確認）
- §5 の 4 ケース表と 1:1 で対応しており、実装後の検証手順が明確。

## 3. 軽微 3 点（7〜9）の反映状況

### 3.1 §7 188 行目の書き換え文言（軽微 7） → **Reflected**

- 「既に `--exclusive` タスクが存在しても `/release` は許可され、先行タスクが closed になってから自タスクが drain → 排他実行される」という文言が §7 表の 188 行目に採用されている（plan.md:383）。
- 加えて「非排他 `--run-after-all` タスクが既に存在する場合は `RUN_AFTER_ALL_CONFLICT` でエラーになる」と 1 行追記する余地も軽微・任意として言及（plan.md:387-390）。

### 3.2 i18n.ts Notes 節の具体文言（軽微 8） → **Reflected**

- plan §5 に `help_create_task` Options 行（EN/JA 各 1 項目）と Notes 追加 2 項目（EN/JA）が literal で記載されている（plan.md:266-310）。
- `help_main` の `create-task` 行への `[--exclusive]` 追加、Examples の追加（EN/JA）も明記。

### 3.3 master.md の提案フォーマット例 literal 埋め込み（軽微 9） → **Reflected**

- plan §6 の「master.md（ja / en）への『排他タスク』節追加」に、ja/master.md の literal 文言がコードブロックとして埋め込まれている（plan.md:354-372）。
- 6 パターンの列挙＋提案フォーマット例（「このタスクは `<該当パターン>` に該当するため…」）が含まれており、en/master.md も同内容の英訳と指示されている。
- §10・§11 の方針と整合（Master は自動適用せず提案 → 確認 → 付与）。

## 4. Approved 判定につき Planner への指示

rev 2 の plan.md は前回 Changes Requested の全項目を解消しており、**実装着手可**。

軽微な任意事項（plan §11 に残しているもの、例: `docs/spec/04-templates.md` への master.md 追記言及、`cmux-team status` への `exclusive_lock_active` 表示）は本タスクのスコープ外として妥当。必要なら別タスク化すればよい。

実装フェーズでは §9 の実装順序を守り、特に以下 3 点を「着手前の確認点」として実装者に伝達することを推奨:

- §3 / §4 A 案の相乗り前提 — `parseTaskMeta` での `exclusive=true ⇒ runAfterAll=true` 強制セットが全ての既存フィルタ無変更の前提条件であり、ここを外すと §4 D を再度検討しなければならなくなる。
- §5 判定式の 4 ケース — 実装後に §8 テスト 7 で両方向 + exclusive 同士の 3 パターンを必ず通すこと。
- §7 release.md の 4 箇所 — 188 行目だけ文言の微調整が必要なので diff レビュー時に見落とさないこと。

以上、Round 2 レビュー結果: **Approved**。
