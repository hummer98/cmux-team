## Verdict: Approved

## Summary

T269 plan は「preserveWorktree 経路で task-state が assigned のまま残ることが resume 誤発火の根本原因」という診断を正確に捉え、`handleConductorDone` の unresolved 分岐で既存の user_clear パターン（`daemon.ts:2118-2144`）と同形の inline コードを挿入する方針を採っている。サブタスク分割・テスト設計・ドキュメント更新が受け入れ条件を過不足なく網羅しており、preserveWorktree 契約も `resetConductor` 呼び出し順序で維持される。Critical findings は無い。

## Critical Findings

なし。

## Minor Findings

- **M1. task.md の `markTaskAborted` 前提は実在しない。plan の D1 での却下判断は正しい。**
  - 検証: `skills/` 配下で `markTaskAborted` を grep しても実装は存在せず、過去 T117 の設計ドキュメント内のみ。plan は D1 で「user_clear 経路と同じ inline パターンを踏襲する」と明言し、S2 のコードブロックは既存 `daemon.ts:2115-2144`（SESSION_CLEAR ハンドラ）と journal 構造・cascade 呼び出し・notifyStateChanged 条件まで完全に同形。DRY/SSOT 的には「5 経路目の inline」は将来別タスクでヘルパー化する余地があるが、本タスクスコープとしては低リスク選択で妥当。

- **M2. 行番号は rebase 後の見込み値で、実装時に再確認が必要。**
  - plan §3-1 は `handleConductorDone` を 2583 付近 / caller を 1240 付近と記述しているが、現在の worktree HEAD（`a705acd` = main）では 2715 / 1310 にある。T263/T264/T266 を取り込んだ後の数値の推定値として許容範囲。Implementer は S1 rebase 完了後に grep で再位置確認してから S2 に入る必要がある。

- **M3. `CONDUCTOR_DONE.reason` の message schema 存在確認が未実施。**
  - plan §2-3 / D3 は `message.reason` を `opts.reason` に伝搬するが、本 worktree 時点では `handleConductorDone` に `unresolved` も `opts` も無い（T263 でまだ追加されていない）ため、schema.ts の CONDUCTOR_DONE 型定義の確認は rebase 後に委ねられている。Implementer は S1 直後に `schema.ts` で `reason?: string` フィールドが既存か確認し、無ければ schema も同時に拡張する必要がある。

- **M4. CLAUDE.md の cascade 経路数「6 → 7」は T264 merge 後の前提。**
  - plan §S6 は「T264 で 5→6 になっているので 6→7 に更新」としているが、現在の `CLAUDE.md` §依存タスクの cascade は 5 経路のまま（T264 未 merge）。rebase で T264 が取り込まれた時に T264 分の増分が反映されるはずなので、Implementer は rebase 後の CLAUDE.md 現値を基準に +1 する運用で整合する。

- **M5. S3 の `expect(log).toMatch(...)` は既存テストの log 変数構造に依存。**
  - plan の expect 記述は例示的。daemon.test.ts の T263 Case C が実際に `log` 変数でログを集約しているか、あるいは別途 capture helper を使っているかは rebase 後に確認する必要がある。既存 Case の pattern を踏襲する指示が S3「メソッド制約」に明記されているので運用上の問題は無い。

## Recommendations

- **R1. S1 rebase 完了直後に 3 点を明示的にチェックするガード手順を追加すると安全性が増す。**
  - `rg "opts.*unresolved" skills/cmux-team/manager/daemon.ts`（T263 の unresolved 引数が存在すること）
  - `rg "applyResumeTransitions" skills/cmux-team/manager/main.ts`（T264 の関数が存在すること）
  - `rg "CONDUCTOR_DONE.*reason" skills/cmux-team/manager/schema.ts`（schema に reason フィールドがあること。無ければ追加スコープ）
  - これは plan §0 で記述済みだが、M2/M3 の確認を同じタイミングで実施する具体手順として明示すると、Implementer の判断ミスを減らせる。

- **R2. S2 のコードブロックで `current?.status !== "closed" && !== "aborted" && !== "deleted"` の guard と SESSION_CLEAR 経路の guard が完全同形であることをコメントで残すと、将来のヘルパー抽出タスク（T27x）で grep しやすい。**
  - 例: `// 共通パターン: user_clear (daemon.ts:2123) と同形。将来 markTaskAborted ヘルパーに抽出予定。`

- **R3. S3-3 の統合テストで `applyResumeTransitions` の期待値が T264 実装に依存するため、rebase 直後の Case D / E の既存 test 内で `applyResumeTransitions` がどう呼ばれているかを先に観察し、同じ call signature / option に揃えると書き直しが減る。**

- **R4. S6 CLAUDE.md の 3 パターン state 遷移表は、既存 T263 節にテーブルが無い場合は新規追加、あれば置換という 2 パスに分かれる。Implementer は CLAUDE.md を実際に読んで整合する形で書くこと（plan §S6 にもその旨を 1 行追記する価値あり）。**

- **R5. 手動確認（S7 §3）の実施条件として「clean な `.team/` 環境」と書かれているが、restart-task の挙動は CLI コマンド自体を変更しないため、スモークレベルで十分。必須ではなく best-effort 扱いとしてよい。**
