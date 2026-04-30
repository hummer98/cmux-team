# T333 Design Review

## Verdict

**Approved**（軽微な改善提案あり、blocker なし）

## Summary

plan.md は既存コードの構造（`hasFlag("force")` / `applyTaskEvent` / TaskFsmEvent 拡張パターン）に
忠実に従っており、設計判断（assigned 禁止 / deleted 二重削除禁止 / closed・aborted では cascade
を emit しない）はいずれも合理的かつ既存セマンティクスと整合する。Phase 3（実装）に進んで問題ない。
ただし `forceFlag` を draft/ready に渡された場合の挙動と、テスト網羅性で若干の補強余地がある。

## Strengths

- **既存パターン踏襲**: `--force` 判定が `update-task --force` (main.ts:3195) / `create-task --force`
  (main.ts:3329) と同じ `hasFlag("force")` で統一されており、振る舞いの差分（"sync ガード bypass" vs
  "terminal-ish からの前進"）だけが本タスク固有という整理がきれい。
- **state mutation 経路の遵守**: `applyTaskEvent` 経由のみで `taskState` を書き換える方針が崩れていない
  （CLAUDE.md 実装ルールおよび T303 制約に準拠）。
- **TaskFsmEvent 拡張が最小**: `CLOSE; autoClosed?: boolean` の先例と同形で `DELETE; force?: boolean`
  を追加するだけ。reducer 側の分岐も既存 `case "DELETE"` 内で完結し、新 event を増やさない判断は良い。
- **deleted の終端不変条件を尊重**: terminal state guard (task-fsm.ts:38) で deleted を全 event
  に対して noop にする現行ロジックを維持し、CLI レイヤで明示 reject に分離している。FSM 側はあえて
  「force でも deleted+DELETE は noop」のままにする方針は構造的正しさを損なわない。
- **cascade を emit しない判断が明示的**: closed/aborted 起点では既に親 close/abort 時にカスケード済み
  であり、再 emit すると `ready` の子を `draft` に巻き戻す副作用が発生する。理由まで含めて plan.md に
  書かれており、テスト T2 で `actions.find((a) => a.type === "cascade_children")` が undefined に
  なることを assert しているのも良い。
- **既存テストの regression check リストが具体的**: `delete-task: TASK_UPDATED が送信される`
  (main.test.ts:795) と `delete-task (T291): slug 渡し` (main.test.ts:898) を明示しており、
  `Task FSM — deleted は終端 state` ブロック (fsm.test.ts:604-624) との重複対応も検討済み。
- **i18n の en/ja 同期**: R5 で en/ja の二重メンテを明示しており、両方の更新差分が plan.md に並んでいる。

## Recommendations

### R1. `forceFlag` を draft/ready に渡されたときの log / 出力メッセージ

- **該当箇所**: plan.md Step 5（main.ts:cmdDeleteTask の log と OK 出力）
- **指摘**:
  - 提案コードでは `forceFlag` が立っているだけで `force=true prev=${currentStatus}` を log と stdout
    に追記する。ところが draft/ready は `--force` を必要としないため、`delete-task --task-id 100 --force`
    で draft タスクを削除した場合「force=true prev=draft」という、実質意味のない（force が無くても通る）
    ログ・メッセージが残る。
  - reducer 側はすでに「`event.force && (state === "closed" || state === "aborted")`」で限定して detail
    を emit しているため、main.ts 側だけが broader になっている。この差は検索性にもノイズを混ぜる
    （grep "force=true prev=draft" が実際のニーズと無関係にヒットする）。
- **推奨修正**: main.ts 側の log / OK 出力でも reducer と同じ「closed/aborted 起点に限定」ガードを掛ける:

  ```typescript
  const usedForce = forceFlag && (currentStatus === "closed" || currentStatus === "aborted");
  await log(
    "task_deleted",
    `task_id=${taskId}${title ? ` title=${title}` : ""} journal_summary=${journal}${usedForce ? ` force=true prev=${currentStatus}` : ""}`,
  );
  console.log(`OK deleted ${taskId}${usedForce ? ` (force, prev=${currentStatus})` : ""}`);
  ```

  これにより「force が実際に効いた遷移」のみマーキングされ、reducer 側 detail と semantics が一致する。

### R2. `draft + DELETE(force=true)` / `ready + DELETE(force=true)` のテスト追加

- **該当箇所**: plan.md §4.1 / Step 1（fsm.test.ts への追加）
- **指摘**: 6 テストの中に `draft/ready + DELETE(force=true)` が無い。reducer 側は `state === "draft"
  || state === "ready"` 分岐を最初に通すため force は無視される（cascade は emit 続行）が、これが
  「force 付きでも cascade が走る／detail に force=true は付かない」ことを保証するテストは欲しい。
  将来 reducer に「force 付きは別経路」と誤って分岐を増やす変更が入ったときの安全網になる。
- **推奨修正**: fsm.test.ts に以下 2 件を追加（軽量）:

  ```typescript
  test("draft + DELETE (force=true) → deleted (force は無視され通常経路 + cascade あり)", () => {
    const { next, actions } = taskReduce("draft", { type: "DELETE", force: true }, tctx({ hasConductor: false }));
    expect(next).toBe("deleted");
    expect(actions.find((a) => a.type === "cascade_children")).toBeDefined();
    const log = actions.find((a) => a.type === "log" && a.event === "task_deleted");
    expect(log && log.type === "log" ? log.detail : undefined).toBeUndefined();
  });
  test("ready + DELETE (force=true) → deleted (同上)", () => {
    const { next, actions } = taskReduce("ready", { type: "DELETE", force: true }, tctx({ hasConductor: false }));
    expect(next).toBe("deleted");
    expect(actions.find((a) => a.type === "cascade_children")).toBeDefined();
  });
  ```

### R3. `task_deleted` ログの二重 emit について明示

- **該当箇所**: plan.md §5（リスク欄）/ Step 5
- **指摘**:
  - 現行コードでも、reducer の `{ type: "log", event: "task_deleted" }` action（apply-task-actions.ts:49 で
    `log(event, detail ?? "")` を呼ぶ）と、`cmdDeleteTask` の `await log("task_deleted", ...)`
    の **2 回**、`task_deleted` ログが出ている。force 対応後は `force=true prev=closed` も両側で出る。
  - これは T333 が新規に作る issue ではない（既存パターン）が、「force=true detail を 2 行残す」のは
    検索者にとって混乱の元。少なくとも plan.md にこの二重 emit を「**意図的に維持する**（reducer 側=
    FSM 監査線、main.ts 側=ユーザ可読 ID/title 付き）」と注記しておくか、reducer 側の log を抑制して
    main.ts 側に集約するかを判断したい。
- **推奨修正**: plan.md §5 リスク欄に「R8. `task_deleted` の二重 emit は既存仕様を踏襲（reducer = FSM
  監査用、CLI = ユーザ可読）。`force=true prev=...` も両方に出るが、検索性のため許容する」を追記する。
  実装上の変更は不要。

### R4. CLI テストの assigned/deleted 用 stderr 文字列を「`--force`」非言及まで assert

- **該当箇所**: plan.md §4.2 C4 / C5（main.test.ts への追加）
- **指摘**:
  - C4 (`assigned + --force`) は `stderr.toContain("is assigned")` のみ。
  - C5 (`deleted + --force`) は `stderr.toContain("already deleted")` のみ。
  - assigned/deleted の reject メッセージには「`--force` を使えば通る」と誤誘導する文言を**入れない**
    ことを明示的に検証したほうが、UX のリグレッション防止になる。提案メッセージは
    `Use abort-task to stop a running task.` / `is already deleted.` で実際 `--force` を勧めて
    いないので、`expect(r.stderr).not.toContain("Use --force")` を一行足すと固まる。
- **推奨修正**: C4 / C5 にそれぞれ `expect(r.stderr).not.toContain("Use --force")` を追加。

### R5. `currentStatus === undefined` のときの挙動

- **該当箇所**: plan.md Step 5（cmdDeleteTask の status guard 3 段）
- **指摘**:
  - `taskState[taskId]` が存在しない（task ファイルはあるが task-state.json に entry が無い）場合、
    `currentStatus` は undefined。提案コードでは 3 つの guard どれにもヒットせず、`applyTaskEvent`
    に渡る。task-state-store.ts:182 で prev は "draft" にフォールバックされ、reducer は draft + DELETE
    を deleted に遷移させる（cascade あり）。これは既存の振る舞い（`--force` 無し時）と一致する。
  - `--force` を渡した場合も同様に「prev=draft → deleted」となるが、これは意味的には正しい（force は
    closed/aborted 専用なので draft フォールバックでも force は無視される）。
- **推奨修正**: plan.md §5 リスク欄に「R9. `task-state.json` に entry が無い task に対する `--force`
  は draft フォールバック扱いで通常削除になる（force は無視される）。これは既存のフォールバック
  経路と整合する」とコメントだけ追加。コード変更は不要。

### R6. 既存「Task FSM — deleted は終端 state」ブロックでの DELETE(force=true) 追加方針

- **該当箇所**: plan.md Step 1 末尾（fsm.test.ts:605-616 の events 配列拡張 vs 独立テスト）
- **指摘**:
  - plan.md は「独立テストを推奨」（R6）としているが、既存ループ (fsm.test.ts:617-623) は
    `events` 配列を回して `deleted + ${e.type} → deleted (no-op)` を生成している。仮に
    `{ type: "DELETE", force: true }` を配列に追加しても、test name は `deleted + DELETE → deleted (no-op)`
    と既存と衝突する（force の有無が test name に出ない）。
  - 独立テスト追加方針が正しい結論だが、その理由として「test name が衝突するため」を plan.md に
    一行加えると、後で実装者が迷わない。
- **推奨修正**: plan.md R6 の説明文に「既存 events 配列を拡張すると test name が `deleted + DELETE`
  で衝突するため、独立 test として T6 を追加する」と明示。

## Risk Assessment

plan.md §5 R1〜R7 で主要リスクは網羅されている。追加で以下を補足:

- **Concurrent delete-task（複数 surface 同時叩き）**: `applyTaskEvent` 内部の `withTaskStateLock`
  (task-state-store.ts:35,115) でシリアル化されるため race condition は発生しない。CLI 側の
  `currentStatus` チェックは TOCTOU 的に古くなる可能性があるが、その後の applyTaskEvent → reducer
  noop guard で確実に弾かれる（最悪「already closed」と表示されるべきところで exit 0 になる程度の
  良性 race）。**コードへの追加対応不要**。
- **daemon との通信整合性**: `postMessage({ type: "TASK_UPDATED", ... })` は現行 delete-task と同形で
  送られる。proxy/daemon 側の TASK_UPDATED ハンドラに force-specific な分岐は不要（status の現在値が
  deleted になっていればそれだけで TUI 側は適切に再描画される）。**問題なし**。
- **trace DB / api_usage への副作用**: `task_deleted` log 行が 2 行（reducer + main.ts）残る点は
  R3 で言及済み。trace DB の `task_log` テーブルへ等しく流れるので検索性のみの懸念。**重大なリスクなし**。
- **`worktree`/`branch` 残骸**: plan.md R7 で対象外と明示。closed/aborted の時点で通常掃除済みであり、
  delete-task が改めて手を出さない方針は既存仕様と一致する。**問題なし**。

## 結論

**Approved.** 設計判断（FSM 拡張点、cascade 抑止、CLI ガードの 3 段構成、i18n の en/ja 同期）はいずれも
妥当で、既存コード構造との整合性も高い。R1〜R6 はいずれも軽微な改善提案であり、Phase 3 の実装中に
取り入れれば足りる（特に R1 は実装の品質に直接効くので、採否を判断したうえで進めると良い）。

実装着手 OK — TDD（Step 1 赤 → Step 3 緑 → Step 4 赤 → Step 5 緑）の順序も明確で問題なし。
