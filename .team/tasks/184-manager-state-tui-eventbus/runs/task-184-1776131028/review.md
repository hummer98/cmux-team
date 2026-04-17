# T184 Plan Design Review (2nd round)

## Verdict: Approved

v1 レビューで提起した Major 2 件（R1, R2）および Minor 5 件（R3〜R7）、加えて受け入れ基準の数値目標問題（「15 箇所以上」「1 秒以内」）がいずれも適切に反映されている。Blocker は 0 件、残存 Major なし。実装に進んで差し支えない。

## Changes from v1 plan

### R1 対応状況：✅ 解消

- §2.2 で `ConductorState` を実 mutate する点のみを列挙し直し、assignTask L474-481（ブロック末尾で 1 回 emit）と resetConductor L562-571（status="idle" + フィールドクリア）に絞り込んだ
- §Step 3 を刷新し、L353（ローカル変数 `worktreeCreated`）/ L395（direnv allow 完了）/ L423（prompt file 生成）/ L442（cmux send 完了）/ L559（renameTab 完了）の notify を「挿入しない」と明示的にリスト化
- 「state mutation 直後のみ emit」の不変条件を §1 / §3 / §Step 7 CLAUDE.md ポリシー / §Step 6 Event Catalog / §受け入れ基準に一貫して記載
- phase 可視化（worktree 作成中の中間状態表示）は §9 Open Questions #1 に別タスクとして切り出し済み

### R2 対応状況：✅ 解消

- §3.4 で `TASK_CREATED` / `TASK_UPDATED` は **handleMessage 内でも CLI 側でも notify しない** 方針に統一
- §Step 4 で `TASK_CREATED` / `TASK_UPDATED` を「notify 不要」と明記
- §Step 5 で「前版の『Step 5 で TASK_UPDATED / TASK_CREATED に notify を追加する』記述は撤回する」と明示
- 達成経路が「`requestWakeup` → 次 tick の `scanTasks` 内差分検出 notify」に一意化され、受け入れ基準「update-task --status ready から即時 TUI 反映」の実現経路が明確

### Minor 対応状況

| 指摘 | 反映 | 確認事項 |
|---|---|---|
| **R3** scanTasks 差分あり時のみ notify | ✅ | §3.5 に `openTasks` 件数 / `pendingTasks` length / `taskList` JSON ハッシュ比較による差分検出方針を明記。§Step 4 / §受け入れ基準にも反映 |
| **R4** Step 2 行番号修正 | ✅ | §2.1 `dashboard.tsx:1320` 以降を cleanup と明記。§Step 2 で「L1316 付近 `return { scheduleRefresh }` 直前に unsubscribe 宣言」「cleanup は L1320 以降」「unsubscribe 変数スコープは `startDashboard` 関数内」まで指定 |
| **R5** Event 型 / API 整合 | ✅ | §3.1 / §3.2 で **案 B（YAGNI）採用**を明記。`Event` union 未導入、`notifyStateChanged(source: string)` のみ export。拡張時の手順（union 導入 + 専用 `notify*` ラッパー + `switch` exhaustiveness）も記述 |
| **R6** logger 循環依存禁止 | ✅ | §Step 7 `## EventBus ポリシー` および §Step 6 Event Catalog の両方に「`logger.ts` は `eventBus.ts` を import してはならない」を明記。§5 リスク表にも記載 |
| **R7** TRACE フラグ検証方法 | ✅ | §Step 1 テスト項目で「動的 import + 先頭で `process.env.CMUX_TEAM_TRACE_EVENTS = "1"` 設定 + `await import("./eventBus")`」を明記。必要に応じて `eventBus.trace.test.ts` を別ファイル化する方針も提示 |
| 受け入れ基準「15 箇所以上」 | ✅ | §1 / §8 から数値目標を削除。「箇所数の多寡は KPI にしない」と明示し、grep で列挙可能であることのみを基準に修正 |
| 受け入れ基準「1 秒以内」 | ✅ | §1 / §6 で「目視で即時反映されること」に緩和。厳密計測は §9 Open Questions #3 に切り出し |

## Remaining Issues

### [Minor] Step 4 の CONDUCTOR_DONE / SESSION_CLEAR が条件付き記述

§Step 4 の以下 2 項目は「実装時に確認」「直接代入パスがあれば」と条件付きで書かれており、最終的な挿入位置が plan 時点で一意化されていない。

- `CONDUCTOR_DONE` (L578): 「`resetConductor` 経由で mutation → resetConductor 側で既に notify される。ただし done マーカー削除など handleConductorDone 固有の state 変更があれば追加 notify する（実装時に確認）」
- `SESSION_CLEAR` (L802): 「`resetConductor` 経由パスは conductor.ts 側で notify 済み。直接 `status="idle"` を代入するパスがあればそこで notify する」

実装者が読めば判断できる範囲ではあり、かつ「実 mutation 直後のみ emit」の不変条件に照らせばブレない（resetConductor 経由なら conductor.ts 側で既に notify されるので二重不要、直接代入なら追加）。**Blocker ではない**が、実装時にこの 2 箇所の実コードを必ず確認し、plan のコメント欄 or PR description に結論を明記することを推奨する。

### [Minor] §Step 4 末尾の `scanTasks:conductor-updated` と assignTask 内 notify の重複

L926 `state.conductors.set(updated.surface, updated)` 直後の notify は、「assignTask 内でも notify 済みだが debounce で吸収」と plan が明記している通り冗長ではあるが安全側。実害はなく、100ms debounce で 1 回に集約されるため許容範囲。ただし §3 の「emit 箇所 = state mutation 箇所」原則を厳格に適用するなら、assignTask が成功した場合の `state.conductors.set` は「値が変わっていない再セット」（オブジェクト参照更新のみ）に相当するため emit をスキップする選択肢もある。**本タスクでは現方針（両方 emit + debounce 吸収）で問題ないが、将来 state observer に移行する際の再検討ポイントとして §9 Open Questions に追加すると親切。**

## Final Recommendation

**Approved. 実装に進んでよい。**

v1 の Major 2 件が構造的に解消され、plan 全体の論理一貫性が向上している。特に以下が評価点：

1. **「emit 箇所 = state mutation 箇所」の不変条件** が §1 受け入れ基準 / §3.1 設計 / §Step 6 docs / §Step 7 CLAUDE.md の 4 箇所で一貫して明文化され、将来の逸脱防止策として堅牢
2. **scanTasks 差分検出** により「アイドル時は止まる」原則を保ちつつ外部トリガからの TUI 即時反映を両立
3. **案 B（YAGNI）採用の理由** を明記し、将来の拡張ポリシーも具体的な手順（union 導入 + 専用ラッパー + `switch` exhaustiveness）として記述
4. **循環依存禁止** を CLAUDE.md ポリシー + Event Catalog + リスク表に多重記載し、新人 Agent が誤って logger 側で emit する事故を予防
5. **Open Questions** に 5 件の未決事項（phase 可視化、scheduleRefresh 完全置換、計測ログ、CI 化、TRACE ログ分離）を整理し、本タスクのスコープが明確

### 実装時の留意点

- Step 4 の `CONDUCTOR_DONE` / `SESSION_CLEAR` は実コードを確認し、resetConductor 経由か直接代入かを判定した上で notify 配置を確定すること
- `eventBus.test.ts` と `eventBus.trace.test.ts` の分離判断は、動的 import での env 操作が 1 ファイル内で副作用を持たないなら 1 ファイル化も許容
- 受け入れ基準チェックリスト §8 の全項目を PR description に転記し、セルフレビューの踏み台にすること
- 実装 PR ではテンプレート（`skills/cmux-team/templates/*.md`）への影響がないことを確認（本タスクは manager 実装のみ）
