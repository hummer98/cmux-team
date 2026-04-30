# T357 Inspection

## Verdict
GO

## Summary
docs/spec/10-events-stream.md は §1〜§9 の章立て・16 event の payload schema・retention policy・reader ガイドラインを plan.md と整合した形で過不足なく定義しており、glossary.md / 00-project-overview.md への波及も想定どおり最小差分。scope outside（T358-T361）への侵食はなく、コード/workflow への変更も無い。`package-lock.json` の差分は worktree bootstrap の副作用で本タスクのスコープ外。

## Findings

### Critical（NOGO 要因）
なし

### Major（GO だが対応推奨）
- なし。検品観点リスト（spec §1〜§9 章立て / 16 event 全数 / 共通 field §3 / schema_version=2 と bump rule §4 / retention 4 理由 / 手動 GC 例 / reader 実装ガイドライン §8 / §9 リンク群 / `task_aborted.reason` 6 値 / surface ID `surface:N` 表記 / cascade 非 emit / `task_completed` vs `state_mismatch` 使い分け / `conductor_done_unresolved` と `task_aborted reason=judgment_pending` の重複正当化）はすべて満たされている。

### Minor（informational）
- §9 関連 spec で `08-runtime-boundary.md` を「Deliverable / `close-task` 仕様の一次資料」として参照しているが、08 の現状内容は **runtime backend abstraction の棚卸し（runtime-specific / agnostic 分類表）** が主題で、Deliverable / `close-task` 仕様本体の一次定義はそこに無い。リンクとしては「task_completed の前提」を辿る導線として残す価値はあるものの、reader が 08 を開いて Deliverable 章を期待すると裏切られる可能性がある。後続の docs-sync 案件で 08 側に Deliverable 章を追加するか、本 spec §9 の説明文言を「runtime boundary の文脈で `close-task` がどう位置づくか」に修正するかの両案あり。本タスクで触る必要はない。
- 00-project-overview.md の索引表は元から `08` / `09` の行が抜けており、本タスクで `10` のみ追加した結果ギャップが残る。これは impl-summary でも明示済みで、本タスクのスコープ厳守の判断は妥当。後続の docs-sync 案件で `08` / `09` を補完するべき。
- §5.2 / §6 の見出し階層は plan.md 章立て案どおり `### 5.1 Task lifecycle (8 event)` / `### 6.1 task_created` の混在構造（章 5 配下に 5.1/5.2、章 6 配下にフラットな 6.1〜6.16）になっており、TOC 自動生成系では深さの不揃いが気になる可能性があるが、09-token-pool.md と同様の Markdown スタイルで読みやすさは確保されている。修正不要。

## Side-effects（副次的差分）
- `package-lock.json`: `version` フィールドが `4.12.1` → `4.14.0` に更新されている（lockfileVersion / dependencies 構造には変更なし）。worktree bootstrap 時に `npm install` が走り、main 側で残っていた lockfile（4.12.1）と `package.json`（4.14.0）の不整合が解決された副作用。**本タスク T357 のスコープ外**であり、Conductor は最終 commit から除外することを推奨（main 側の docs-sync / release 系タスクで一括処理すべき）。
- 想定 3 ファイル以外の変更は上記 `package-lock.json` のみ。`package.json` / `tsconfig.json` / `bin/*` / `skills/cmux-team/manager/**/*.ts` / `.github/workflows/*` への変更はゼロ（`git diff --name-only HEAD` で確認済み）。

## Coverage check
- 16 event の payload schema 記載: 16/16 ✓
    - Task lifecycle 8/8 ✓: `task_created` / `task_ready` / `task_assigned` / `task_completed` / `task_completed_state_mismatch` / `task_aborted` / `task_sync_guard_rejected` / `task_reverted_to_ready`
    - Conductor lifecycle 8/8 ✓: `conductor_running` / `conductor_recovered` / `conductor_disconnected` / `conductor_asking` / `conductor_done_unresolved` / `conductor_start_timeout` / `conductor_assign_timeout` / `conductor_disconnect_timeout`
- 章立て (§1-§9): 9/9 ✓（§1 概要 / §2 ファイル仕様 / §3 共通 field / §4 Schema versioning / §5 Event 一覧 / §6 各 event の payload schema / §7 Retention policy / §8 Reader 実装ガイドライン / §9 関連 spec）
- glossary 2 用語: 2/2 ✓（`events stream` / `event channel`、共に `Trace DB` 直下に配置、§10 末尾「関連 spec」行にも `10-events-stream.md` 追記済み）
- 00-project-overview 索引: ✓（`10` 行が `07` の直下、`glossary.md` の直上に追加。既存 00-09 行の構造には触れていない）
- scope outside 侵食なし: ✓
    - writer のコード断片なし ✓
    - CLI のコマンドライン具体仕様（`--types` / `--since` / `--format`）なし ✓（`--follow` は「reader の典型例」としての言及のみで、CLI 仕様としては定義していない）
    - watch command のプロンプト・自動化仕様なし ✓
    - CLAUDE.md 反映なし ✓（T361 の参照のみ）

### 補足チェック（観点 1, 4）
- 共通 field の §3 定義 + 各 event 表からの省略宣言: ✓（§6 冒頭でも明記）
- `schema_version=2` と bump rule: ✓（§4 で確定、bump 条件 3 件 / additive 3 件を列挙）
- Retention 4 理由: ✓（既存ログ整合 / live tail 相性 / append-only / 生成レート低、§7 に列挙）
- 手動 GC 例（`tail -n 100000 ...`）: ✓（§7 末尾の bash code block）
- reader forward-compatible（unknown event skip / schema_version mismatch 警告）: ✓（§8 の 5 箇条）
- §9 関連 spec リンク（07 / 08 / glossary / T358-T361 / issue #42）: ✓
- `task_aborted.reason` 6 値（`judgment_pending` / `disconnect_timeout` / `user_clear` / `assign_failed` / `resume_marked_aborted` / `other`）: ✓（§6.6 の reason enum 表）
- surface ID `surface:N` 表記の一次規定: ✓（§6 冒頭）
- cascade（親 abort → 子 draft）非 emit の明記: ✓（§6.6 本文）
- `task_completed` vs `task_completed_state_mismatch` の T274 分岐: ✓（§6.4 / §6.5）
- `conductor_done_unresolved` と `task_aborted reason=judgment_pending` の重複正当化: ✓（§6.13 本文 + §6.6 reason 表脚注）
- 既存 spec との遷移名整合（07-state-machine.md の `ASSIGN(ok)` / `DONE(success=true)` / `SESSION_CLEAR(manual)` / `TIMEOUT(*)` / `REVERT_TO_READY` 等）: ✓（spec §6 各表の発火条件記述と矛盾なし）
- glossary §10 既存用語（EventBus / Trace DB / hook）と新用語の整合: ✓（EventBus は in-process / events stream は外向け、と §1 で明確に区別）
- Markdown 構造（heading / table / code block / 参照ファイル名）: ✓（タイポ・閉じ忘れなし、相互リンクの target ファイルは全て実在）

## Fix Required（NOGO の場合のみ）
N/A（GO 判定のため記載なし）
