# T232 plan.md 設計レビュー

**対象 plan**: `/Users/yamamoto/git/cmux-team/.team/tasks/232-conductor-status-assigning-daemon-clear-user-clear/runs/task-232-1776384479/plan.md`
**レビュアー surface**: `task232-reviewer`
**実施日**: 2026-04-17

---

## Verdict: Approved

Critical findings 0 件、CRITICAL チェック項目 4 項目すべてパス。Minor findings のみのため Approved。実装時に Recommendations を反映することを推奨。

---

## Summary

`assigning` ステータス新設により「daemon 自身が送信した `/clear`」と「ユーザー手動 `/clear`」を状態機械で区別するアプローチは、race condition の根本対策として妥当。状態遷移・タイムアウト・UI 対応・テスト追加が網羅的に計画されており、plan に記載された行番号とコードベース現状の整合も検証済み。Decision Log が具体的で実装時の判断揺らぎを抑制できる。

---

## Findings

### 1. [minor] `assignTask` 内で `assigning` をセットした後、AssignTaskError 以外の例外が飛ぶ経路で status が取り残される可能性

- **根拠**: plan §2 Sub-task 2 で `/clear` 送信**直前**に `conductor.status = "assigning"` をセット。`cmux.send` 失敗は try-catch で `AssignTaskError("conductor", ...)` に包まれ外側 catch（`daemon.ts:1614`）で `disconnected` に遷移する。ただし `assignTask` L390-406 の trace DB insert（現状は catch で log のみ、throw しない）、L408-418 の ConductorState 更新、L420 の log 呼び出しのどこかで AssignTaskError 以外の例外が生じた場合、外側 catch では `AssignTaskError` の instanceof チェックしか行っていないため、`throw` で再伝播し、呼び出し側（`scanTasks`）の catch も `AssignTaskError` 以外は再 throw する構造（要確認）。
- **影響**: 現状コードでは trace DB insert の catch は swallow するため実害は軽微だが、将来変更でこの経路に非 AssignTaskError 例外が増えると assigning 状態で固着する危険性。
- **緩和**: plan §5 リスク表で「確認必要、必要なら追加」と記載されている通り、実装時に `scanTasks` の catch 分岐に `e instanceof AssignTaskError === false` でも `conductor.status === "assigning"` なら `disconnected` に倒すセーフティネットを追加するか、`assignTask` の最外殻 try-catch で finally で `status !== "running"` (本 plan 後は `!== "running"` は `"assigning"` を意味) なら `disconnected` に倒す保険を入れることを推奨。
- **severity**: minor（60 秒 timeout で結局救済される）

### 2. [minor] `assigning` 中に SESSION_IDLE / SESSION_ACTIVE が先に到達した場合の保険が欠如

- **根拠**: plan §5 リスク表で「既存ハンドラは starting/disconnected/asking の 3 種のみ遷移させるため、`assigning` はフォールスルー。これで問題なし」と判断しているが、cmux 側の hook 配送順保証が不明。もし何らかの理由で SESSION_STARTED より先に SESSION_IDLE / ACTIVE が到達するケース（Claude プロセスが /clear 処理と並行して前回ターンの Stop hook を発火する race 等）があれば、60 秒 timeout まで `assigning` のまま残り、その後 disconnected → 5 分後 forced close + `task_aborted`（journal=disconnect_timeout）となる。**実タスクは既に走り始めている**ため状態と実体が乖離する。
- **緩和案**:
  - SESSION_IDLE / SESSION_ACTIVE ハンドラの既存 Conductor 分岐に `assigning → running`（`taskRunId` 埋まっている前提）の遷移を追加する
  - Decision Log D6 の「SESSION_STARTED 経由のみで遷移」原則と矛盾するが、保険としての優先度は高い
  - あるいは `daemon.test.ts` に「assigning 中に SESSION_IDLE が来ても状態が壊れない」ことを確認するテストを追加（現状 Sub-task 7 にこのケースなし）
- **severity**: minor（実観測されていないが、hook 配送順は cmux 実装依存でブラックボックス）

### 3. [minor] Sub-task 2 の `notifyStateChanged` source 文字列

- **根拠**: plan §4 Sub-task 2 で L418 の `notifyStateChanged("conductor.ts:assignTask:status-running")` を `conductor.ts:assignTask:assigned` 等に変更と記載。ただし L416 の `status = "running"` 削除後も L408-415 で taskId / taskRunId / taskTitle / worktreePath / outputDir / startedAt / agents が更新されているため、これを TUI に反映する notify は引き続き必要。
- **改善提案**: source 文字列は「状態遷移の名前」ではなく「実際にどの state mutation が起きたか」を示す命名にすべき（CLAUDE.md EventBus ポリシー「source は呼び出し位置を明示」）。例: `conductor.ts:assignTask:task-info-updated` / `conductor.ts:assignTask:assigning-set`（`/clear` 直前と L418 の 2 箇所で呼び分ける）。
- **severity**: minor（命名のみ、動作に影響なし）

### 4. [minor] SESSION_CLEAR 早期 return と既存 `stale guard` の順序関係の明示

- **根拠**: plan Decision Log D3 で「`assigning` スキップは Master 分岐の直後、`disconnected/starting → idle` 分岐よりも**前**」と明記されており適切。しかし現コード `daemon.ts:1457` の `disconnected/starting → idle` 分岐は`conductor.status === "disconnected" || conductor.status === "starting"` のみを条件にしているため、`assigning` と diamond 干渉はない。plan §3「変更対象: L1450 付近」だけだと、実装者が挿入位置を誤る可能性がある。
- **改善提案**: 挿入位置を「`daemon.ts:1456` の `const conductor = findConductor(...)` 直後、L1457 の `if (conductor && (conductor.status === "disconnected" || conductor.status === "starting"))` よりも**前**」と具体的な行番号で指示すべき。
- **severity**: minor（実装者が plan §4 Sub-task 4 の擬似コードを見れば判断できる）

### 5. [minor] dashboard ヘッダー `assigningCount` の表示条件

- **根拠**: plan §4 Sub-task 6 で「ヘッダー集計が 0 のときは既存規則どおり省略」と記載されているが、現コード（`dashboard.tsx:857-859`）の `startingCount` / `runningCount` / `askingCount` は filter で集計しているだけで、表示側で 0 省略しているかは該当箇所の後続を実装者が確認する必要がある。
- **改善提案**: plan §4 Sub-task 6 の「ヘッダー集計 L857 付近」に加え、実際にヘッダー部分でこれらのカウントを描画している箇所（例: 状態サマリ行）の行番号も明示するとベター。実装者が `assigningCount` を追加したが表示箇所で反映漏れ、というリスクを低減できる。
- **severity**: minor

### 6. [minor] `monitorConductors` の `assigning` 分岐の `continue` 配置

- **根拠**: plan §4 Sub-task 5 の擬似コードで `if (conductor.status === "assigning")` ブロック末尾で `continue` するとあり、これは OK。ただし既存コード（`daemon.ts:1859-1871`）の `starting` 分岐と同じ形（timeout 到達時のみ disconnected に倒し、`continue` でループを抜ける）に揃っているかの検証が必要。
- **補足**: 現 `monitorConductors` は `starting` 分岐 L1859-1871, `disconnected` 分岐 L1874-1886, 最後に暗黙の fall-through（running/idle/asking は PID watcher に任せる）という構造。ここに `assigning` を挿入する際、timeout しない場合も `continue` で抜ける必要がある点を明示したほうがよい（さもないと PID watcher 未起動の assigning 窓中に fall-through して副作用が出る危険性）。plan では「starting 分岐の直後」かつ擬似コード末尾に `continue` があるので概ね OK。
- **severity**: minor（実装者が既存パターンに従えば問題なし）

---

## CRITICAL チェック項目

| 項目 | 結果 | 備考 |
|------|------|------|
| サブタスクカバレッジ | ✅ PASS | schema → conductor → daemon (STARTED/CLEAR/timeout) → statusline → dashboard → test → 全体緑化 の 8 分割で網羅 |
| 統合テスト / 検証 | ✅ PASS | Sub-task 7 で daemon.test.ts に SESSION_CLEAR/STARTED/timeout の 3 パターン + 回帰防止 (running 中 SESSION_CLEAR) をカバー |
| 削除タスク | ✅ PASS | Sub-task 2 で L416 `status = "running"` の**完全削除**を明示（Decision Log D5 で根拠付き） |
| 既存テストへの影響 | ✅ PASS | 回帰防止テスト (Sub-task 7 ケース 4)、既存の classify-stop.test.ts は無関係と明記 |

---

## 良い点（評価）

1. **問題の本質を正確に捕捉**: daemon 自身の `/clear` と user_clear の区別不能という race の核心を L374-416 と L1450-1508 のコード引用で特定している
2. **代替案の却下理由が明確**: カウンタ方式 / 時間窓方式 / トークン方式を却下した理由が具体的で、`assigning` 状態化が最も状態機械として健全という判断が妥当
3. **Decision Log が詳細**: timeout 値 60s の根拠（実測 10s × 10 マージン）、ログイベント名の対称性、D5 の「コメントアウトではなく削除」といった実装時の迷いを潰す記述
4. **CLAUDE.md 原則への準拠**: 「異常検知時のリカバリは人間に委ねる」（§リスク緩和）、「hook 側にロジックを持たせない」（代替案却下）、「emit 箇所 = state mutation 箇所」（notifyStateChanged の扱い）
5. **段階的検証**: schema から着手して型エラーで未対応箇所を炙り出す戦略、Sub-task 8 で全体緑化確認

---

## Recommendations（Approved だが実装時に反映推奨）

### R1. Finding 2 の保険対応

`daemon.ts` の SESSION_IDLE / SESSION_ACTIVE ハンドラ (L1260-1267 / L1328-1360) の既存 Conductor 分岐に以下の保険分岐を追加することを推奨:

```ts
if (conductor.status === "assigning" && conductor.taskRunId) {
  conductor.status = "running";
  await log(
    "conductor_running",
    `${formatSurface(message.surface, "C")} via=SESSION_${IDLE|ACTIVE} taskRunId=${conductor.taskRunId}`
  );
}
```

**根拠**: SESSION_STARTED が配送順逆転で SESSION_IDLE / ACTIVE より後着する race は理論上あり得る。保険分岐を足しても Decision Log D6 の「複数経路で遷移するとデバッグ性が下がる」問題は `via=` ログで区別可能なため緩和できる。Sub-task 7 のテストに「assigning 中の SESSION_IDLE は `running` に遷移する」ケースを追加。

### R2. Finding 1 の保険対応

`scanTasks` L1614 の catch、または `assignTask` の finally で `conductor.status === "assigning"` のまま関数を抜ける経路がないか確認。

```ts
// scanTasks catch 内
} catch (e: unknown) {
  if (idleConductor.status === "assigning") {
    idleConductor.status = "disconnected";
    idleConductor.disconnectedAt = new Date().toISOString();
    // 既存ログ
  }
  // ...既存分岐
}
```

Finding 1 は 60 秒 timeout で救済されるため severity は minor だが、state 一貫性の観点から推奨。

### R3. Finding 4 の具体的行番号

実装 PR 時の commit message / コメントで「SESSION_CLEAR ハンドラの `assigning` 早期 return は `daemon.ts:1456` の `findConductor` 直後、L1457 の既存 `disconnected/starting → idle` 分岐の**前**に挿入」と明記する。あるいは plan §4 Sub-task 4 の擬似コードを「位置: L1456-1457 の間」と補足する。

### R4. Sub-task 7 テストケース追加

以下 2 ケースの追加を推奨:

1. **assigning 中の SESSION_IDLE/ACTIVE**: R1 採用時は `running` に遷移することを検証、非採用時は state が壊れない（status が保持される）ことを検証
2. **assignTask 中に `/clear` 送信失敗**: AssignTaskError("conductor", ...) が throw され、`conductor.status === "disconnected"` に倒れることを検証（現状テストではカバーされているか要確認）

### R5. dashboard アクティブ判定への追加の妥当性確認

plan §4 Sub-task 6 で `dashboard.tsx:1303` の `needsAnimation` 判定に `assigning` を含めるか検討とある。**推奨は「含める」**: `assigning` は数秒〜60 秒の一時的な遷移状態で、spinner アニメーションでユーザーに「処理中」を伝える価値がある。plan の方針（含める）で妥当。

---

## 実装前の最終確認事項

- [ ] `scanTasks` の catch 分岐 (daemon.ts L1614-1644) で `AssignTaskError` 以外の例外も `conductor.status === "assigning"` なら `disconnected` に倒す処理を加える必要があるか確認
- [ ] Sub-task 7 テストケースに Finding 2 対応（SESSION_IDLE during assigning）を追加するか確認
- [ ] dashboard.tsx の `assigningCount` 描画位置（表示行）がヘッダー集計計算 L857 だけで足りるか、実際の描画箇所も合わせて修正するか確認

以上の確認を経て実装に着手すれば、本計画に沿った修正で T230 の race condition は根絶できる。
