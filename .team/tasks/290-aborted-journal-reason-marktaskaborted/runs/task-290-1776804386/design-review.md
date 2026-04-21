# T290 Design Review

**Reviewer:** design-reviewer (task-290-1776804386)
**Date:** 2026-04-22
**Reviewed artifact:** `plan.md` (668 行)

---

## Verdict: Approved（軽微な指摘を実装時に解消すること）

Planner の構成（案 A の prefix string + `markTaskAborted` + `parseAbortJournal` + `formatAbortedTaskLine`）は T290 が求める 3 つの要件（reason が冒頭に出る / 6 経路一貫性 / T269 型乖離の構造解消）を**構造的に**満たしており、既存の CLAUDE.md ログポリシー（grep 可能・1 行 1 イベント）とも整合している。破壊的変更（applyResumeTransitions のシグネチャ変更）は見かけの大きさほどコストは大きくなく、Planner の判断（構造劣化を避けるため内部互換案を却下）は正しい。

ただし、下記 **Concerns C1（detail 空時のシリアライズ／パーサ非対称）** は「書き手と読み手のフォーマット合意」が崩れる構造的ミスマッチで、実装時に必ず解消しておかないと将来別種のバグの温床になる。内容は軽微なので Changes Requested まで差し戻す必要はないが、Implementer への申し送り（Recommendations）として明記する。

---

## Strengths

- **6 経路の構造的統合が正当**: 現状の「7 ステップ × 6 箇所 = 42 ステップ手書き複製」を 1 ヘルパーに圧縮する方針は、CLAUDE.md §判断基準「構造的正しさを優先 / 局所 if/else のモグラ叩きを続けない」と合致している。T269 が示した「log reason と journal prefix の独立文字列化による乖離」は同一変数（`reason` 引数）を両方で使う構造にすることで**再発し得なくなる**（Section 2 D2 の設計）。
- **idempotentSkip を T269 regression guard の置換にした判断が適切**: `closed/aborted/deleted` への冪等 skip を helper 内で行い、呼び出し側の個別ガード（`current?.status !== "closed" && ...`）をヘルパー 1 箇所に集約する構造は、現状 4 箇所（daemon.ts 2258 / 3049 / 3163, handleConductorDone 周辺）に散らばっている条件式の複製を消せる。
- **on-disk 互換（案 A）の選択理由が妥当**: `TaskState.journal: string | undefined` を維持することで migration 不要、`rg 'reason=judgment_pending'` で経路別フィルタ可能、dashboard.tsx:285-297 の `journal_summary=(.+)` 正規表現とも（greedy キャプチャのまま）互換。
- **責務分離が明確**: `notifyStateChanged` / `TASK_UPDATED` postMessage / worktree 削除 / resetConductor を helper スコープから意識的に外している（D2 責務分離節）。これにより「emit = mutation 元の呼び出し位置」という EventBus ポリシーを壊さない。
- **ロールバック戦略が現実的**: Phase 単位のコミット分割（C1〜C8）が `git revert` 可能な粒度になっており、特に Phase 2.6（破壊的変更）が 1 コミット（C7）に集約されている。
- **Inspection Checklist の grep パターンがそれぞれ異なる観点をカバー**: A（status 直代入の集約）/ B（log 集約）/ C（cascade 集約）/ D（新 prefix 出現）/ E（旧 prefix 残存）/ H（reason 一致の構造保証）が互いに独立した検査になっている。実装完遂性を機械的に担保できる。
- **Planner 推奨理由の明文化**: 代替案（applyResumeTransitions 内部互換維持 / 旧 format reason 不明時に `unknown` を書き込む等）を**棄却理由付きで**並べているため、Implementer が判断を巻き戻しにくい。

---

## Concerns（Blockers — Changes Requested に当たる）

なし。ただし以下 C1 は実装直前に設計上の穴が残っているため、Implementer への申し送りとしては blocker 相当に扱うこと（Recommendations 参照）。

---

## Minor suggestions（Optional — Approved でも良い）

### C1: detail 空時の writer／reader フォーマット非対称

D2 step 3:
> journal 組立 = `` `reason=${reason}; ${detail}` ``（detail が空なら `` `reason=${reason}` ``）

D3 新 format regex:
> `/^reason=([a-z_]+);\s?(.*)$/s`

writer は detail 空時に `reason=user_clear`（セミコロンなし）を書き出すが、reader の regex は `;` を**必須**にしている。結果として writer が書いた `reason=user_clear` を reader が新 format として認識できず、旧 format フォールバックで `/^user_clear: /` にもマッチせず `unknown` に落ちる。

表示層（formatAbortedTaskLine）を経由すると `[unknown] (no reason)` となり、seller の意図（reason 先頭表示）に反する。Inspection Checklist D（`rg 'reason=[a-z_]+;'`）もそのような journal を検出しない。

**修正案（いずれか）:**
- **Option A（推奨）:** writer 側を常に `;` 付きで書き出す。detail 空時は `reason=user_clear;`。regex はそのまま。
- **Option B:** reader regex を `/^reason=([a-z_]+)(?:;\s?(.*))?$/s` に変更し、`;` 以降を optional にする（`reason=user_clear` 単体も match）。

現状の 6 経路で detail が実測空になる箇所は存在しない（全経路で非空）ため実害は小さいが、abort_task CLI で `--journal ""` を受け付ける可能性・将来新経路を足す際の罠になる。契約の対称性を取り戻すため **Option A** を推奨。Step 1.2 T2 テストも `reason=user_clear;` 期待に修正。

### C2: markTaskAborted が常に `journal_summary=` を emit することによるログ表面の破壊的変更

現状の `task_aborted` log は 6 経路で以下のように不揃い:

| 経路 | 現行 log |
|---|---|
| user_clear (daemon.ts:2265) | `task_id=X reason=user_clear` ← `journal_summary=` 無し |
| judgment_pending (daemon.ts:3169) | `task_id=X reason=judgment_pending` ← `journal_summary=` 無し |
| assign_failed / disconnect_timeout / abort_task / resume_* | `journal_summary=...` あり |

Plan D2 Step 7 は「従来互換の `task_id=<id> reason=<reason> [title=<t>] journal_summary=<journal> [extraFields]`」と書いており、**6 経路全てで journal_summary を出す**方針。user_clear / judgment_pending は新たに `journal_summary=` を持つため、dashboard.tsx:291 の `summary || title || "aborted"` 分岐で表示文言が変わる（現状は `"aborted"` フォールバック → 実装後 `reason=user_clear; C[...] taskRunId=...`）。

- これは T290 のゴール「TUI で reason が見える」と整合する**前向きな変更**である
- ただし「現行の挙動を壊さない」という CLAUDE.md §判断基準に一瞬抵触する形に見えるので、plan に「journal_summary 追加は意図的（TUI 可視性向上）」と一行書いておくと後で readers が混乱しない

修正は任意（コード上の修正なし。plan.md に 1 行追加のみ）。

### C3: Step 2.4 における dual skip log（Section 9.1 Option B）

Plan は markTaskAborted 内で `task_abort_skipped` を出し、かつ呼び出し側（handleConductorDone unresolved 分岐）でも `conductor_done_unresolved_skip` を出す（Option B）。情報は失われないが**同一事象 2 行**。

```
[time] task_abort_skipped task_id=263 existing_status=aborted reason=judgment_pending
[time] conductor_done_unresolved_skip task_id=263 reason=already_closed_or_aborted status=aborted
```

観点として、
- Option B 利点: 「どの層で skip が起きたか」を区別できる（helper が skip を記録 / caller が「judgment_pending 処理を諦めた」を記録）
- Option A（helper 沈黙）利点: 単一事象 1 行、grep でのカウントが素直
- Option C（caller 沈黙）利点: helper に emit を完全集約、呼び出し側に `idempotentSkip` 分岐不要

**推奨:** Option A に倒す（helper 側を skip 時サイレントにする）。理由は helper の "emit 集約" という構造的メリットが、「skip 時だけ呼び出し側が別ログを出す」という非対称性で相殺されるため。ただし Planner 判断を尊重するなら Option B のままでも可（plan §9.1 に明記済み）。

### C4: parseAbortJournal の旧 format 推定順序の堅牢性

D3 旧 format 推定順序（先勝ち 6 正規表現）で次の順番:

```
/^user_clear: /         → user_clear
/^assign_failed: /      → assign_failed
/^disconnect_timeout: / → disconnect_timeout
/^conductor_done_unresolved: / → judgment_pending
/^\[resume\] lost worktree/    → resume_no_worktree
/^\[resume\] missing session id/ → resume_no_session_id
/^\[resume\] missing task run id/ → resume_no_task_run_id
```

- 各 prefix は相互に prefix-overlap が無いため順序依存は実質的にない。先勝ちの理由（「短い方から一致するから安全」等）は plan に書かれておらず、順番が構造上どうでもいいなら「順序は問わないが見やすさのため上記の固定順」くらいのコメントを入れておくと保守時の誤解を防げる
- `abort_task` CLI の i18n 文字列（`中断: TNNN <title>` / `Aborted: TNNN <title>`）は意図的に推定対象外。await-task 表示では `[unknown] 中断: T290 ...` となる。**これは setup-level の既存 task-state.json（旧 format）にしか影響せず、新規 abort-task 以降は `reason=abort_task;` 付き**になる。plan §9.3 の許容方針と一致。

修正は任意（コメント追加のみ）。

### C5: `applyResumeTransitions` シグネチャ変更は内部互換維持より素直

Planner 推奨（シグネチャ変更 + main.test.ts 4 ケース書き直し）に同意。代替案（内部で mutate + cmdStart 側で再度 markTaskAborted を重ねる）は:
- saveTaskState が 2 回走る
- taskState mutation の責務が 2 箇所に分裂（applyResumeTransitions 内 + markTaskAborted 内）
- 書き込み順序によっては helper の idempotentSkip が誤発火する可能性（applyResumeTransitions が既に `status: aborted` を書き込んだ後で markTaskAborted が呼ばれれば idempotentSkip=true になり log/cascade が走らない）

という構造劣化を招く。Planner の決定（破壊的変更に倒す）が正しい。

### C6: `formatAbortedTaskLine` の配置は main.ts で妥当

Plan は formatAbortedTaskLine を main.ts 内（CLI 層）に配置する方針。`parseAbortJournal` は task.ts（core）。この分離は正しく、task.ts が UI formatting に依存しない形を保てる。将来 show-task CLI を実装する場合もここから再利用できる。

### C7: Inspection Checklist Item D の regex を C1 修正に合わせる

C1 で「writer 常に `;` 付け」にした場合、`rg 'reason=[a-z_]+;'` はそのままでよい。C1 を採らず「detail 空は `;` 無し」にしたまま reader regex 側で対応する場合、Checklist D を `rg 'reason=[a-z_]+(?:;|$)'` 等に変える必要がある。

---

## Detailed comments by section

### Section 2 (Design Decisions)

| 決定 | 評価 |
|---|---|
| D1（案 A prefix string） | ✅ 採用妥当。案 C（union）は consumer 側ディスパッチを増やす劣化。案 B（JSON）は grep 可能性劣化 + CLAUDE.md ログポリシー違反 |
| D2（markTaskAborted シグネチャ） | ✅ `MarkTaskAbortedResult` が revertedChildren / journal / idempotentSkip / existingStatus を返す粒度は適切。consumer の TUI reflection / 条件分岐に過不足なし |
| D2（責務分離） | ✅ notifyStateChanged を helper の外に置く判断は EventBus ポリシー「emit = mutation 元の呼び出し位置」の維持に必須。shouldn't be changed |
| D3（parseAbortJournal） | ⚠️ C1 指摘（writer/reader 非対称）を除けば良い。best-effort 推定失敗を `reason=unknown` にせず `undefined` に残す方針は正しい（ユーザー入力を `reason=abort_task` と断言する誤誘導回避） |
| D4（formatAbortedTaskLine） | ✅ main.ts 内配置、await-task/printSummaries から再利用、show-task 新設見送りの scope 判断すべて妥当 |
| D5（buildResumeAbortJournal 維持） | ✅ 既存 test `journals["1"].toContain(".team/tasks/1-foo/runs/task-1-123/")` を detail 内一致で維持できるため破壊影響なし |

### Section 3 (Implementation Steps)

- **Phase 1（task.ts 追加 + test）** — ✅ 12 ケース網羅。C1 修正が入れば T2 の expect が `reason=user_clear;` に変わる
- **Phase 2.1〜2.5（daemon.ts 3 経路 + abort-task CLI）** — ✅ 各 before/after のコード例が具体的で、reviewer が一目で diff を把握できる
- **Phase 2.4（judgment_pending）** — ✅ T269 の reason/journal 乖離が「同一変数 `reason` を引数と journal 組立で使う」構造で**再発不能**になる点が最大の価値。Test 追加 `toMatch(/^reason=judgment_pending;/)` でこれを永続ガードする設計が良い
- **Phase 2.6（applyResumeTransitions シグネチャ変更）** — ✅ Planner 推奨に同意（C5）
- **Phase 3（表示側）** — ✅ formatAbortedTaskLine の設計シンプル。printSummaries の closed/aborted/deleted 分岐も妥当（closed は既存通り journal そのまま、aborted のみ reason 先頭、deleted は task_deleted 経路で本 scope 外）
- **Phase 4（回帰防止）** — ✅ 既存 assert は全て detail 部への一致で PASS 維持、新規 assert は prefix 一致で T269 乖離を永続ガード

### Section 7 (Inspection Checklist)

- **A（`status: "aborted"` 直接代入が 1 箇所）** — ✅ `rg -v test` exclude で test setup 除外。現状 7 箇所（daemon.ts 4 + main.ts 3）→ 実装後 1 箇所
- **B（`log("task_aborted"` 集約）** — ✅ 現状 7 箇所（daemon.ts 4 + main.ts 3）→ 1 箇所。C3 の Option B を採る場合、`conductor_done_unresolved_skip` が残るのは想定内（`log("task_aborted"` 自体は helper 1 箇所のまま）
- **C（cascadeAbortToChildren 呼び出し集約）** — ✅ delete-task 経路（main.ts:3778）は task.md scope 外として 1 箇所残す方針は正当（今回の対象は abort のみ）
- **D（`rg 'reason=[a-z_]+;'`）** — ⚠️ C1・C7 参照
- **E（旧 prefix 手書き禁止）** — ✅ detail 生成では prefix を付けない設計が担保
- **F（formatAbortedTaskLine 呼び出し 3 箇所）** — ✅ await-task x2 + printSummaries x1
- **G（古い template literal 残存ゼロ）** — ✅
- **H（reason 一致の構造保証）** — ✅ 「同一引数 `reason` を journal 組立と log emit の両方で使う」構造が plan §D2 Step 3/7 で確立されるため、ここでの grep は防衛ラインとして十分
- **I/J/K（bun test / tsc / parseAbortJournal test カバレッジ）** — ✅

### Section 9 (Unresolved)

- **9.1（dual skip log）** — ⚠️ C3 参照。どちらの設計でも不変条件は破れないが Option A 推奨
- **9.2（applyResumeTransitions 代替案）** — ✅ Planner 棄却判断に同意（C5）
- **9.3（ユーザー --journal の二重 prefix）** — ✅ 許容が妥当。parseAbortJournal 先頭一致で支障なし
- **9.4（FSM shadow）** — ✅ 現状 shadow のみ、markTaskAborted は本番 emit。将来 FSM 昇格時の再設計余地ありの認識が正しい

---

## Recommendations（Implementer への注意点）

### 必ず実施（C1 への応答）

1. **markTaskAborted の writer 側を detail 空時も `;` 付けて書き出す。**
   ```ts
   const journal = detail ? `reason=${reason}; ${detail}` : `reason=${reason};`;
   ```
   - これに合わせて task.test.ts T2 の expect を `reason=abort_task;`（末尾セミコロン付）に修正
   - parseAbortJournal regex はそのまま `/^reason=([a-z_]+);\s?(.*)$/s` を維持（`(.*)` は空文字を許容する）
   - この修正により writer/reader の対称性が保たれ、`rg 'reason=[a-z_]+;'`（Checklist D）も全 journal にマッチする

### 推奨（任意だが望ましい）

2. **Section 9.1 は Option A に倒す（markTaskAborted 内で skip 時は log emit しない）。**
   - helper スコープ: `idempotentSkip: true` を返すのみ、ログは emit しない
   - 呼び出し側: 従来の `conductor_done_unresolved_skip` 等を保持
   - 理由: 同一事象 1 行 log に集約し grep カウントが素直になる。helper の「集約」価値は status 書き込み・cascade・新規 emit に限れば十分

3. **plan §D2 Step 7 に「journal_summary を全経路で出すのは意図的（TUI 可視性向上）」旨の 1 行コメントを追加**（C2）。実装時は `implementer` が plan を読み直すため、意図を文書化しておく

### 実装順序（Phase 単位コミットの順）

Plan §6.1 の C1〜C8 を厳守。特に:
- C7（Phase 2.6）は main.ts / main.test.ts を同一コミットにする
- C5（judgment_pending）で `toMatch(/^reason=judgment_pending;/)` の新 assert を必ず追加する（T269 型乖離の永続ガード）

### リリース前の動作確認

Plan §5 E2E 3 項目を手動実行:
1. `cmux-team abort-task` → `await-task` stderr が `[abort_task]` プレフィックス
2. Conductor `CONDUCTOR_DONE --success=false` → `task_aborted reason=judgment_pending` ログ + journal が `reason=judgment_pending; conductor_done_unresolved: ...`
3. daemon 起動時 worktree 手動削除 → `resume_marked_aborted` + `task_aborted reason=resume_no_worktree` + journal `reason=resume_no_worktree; [resume] lost worktree ...`

---

**Review 完了。Planner の設計は Approved。C1 のみ Implementer が実装直前に修正してから Phase 1 のテスト書き始めること。**
