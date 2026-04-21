# T274 実装計画: Conductor 完了通知を close-task に一本化

## 1. 課題分析

### 現状の問題点

~/git/Dear の T204 は TUI 上 `[assigned]` のまま放置され、同時に `manager.log` には `task_completed task_id=204 ...` が残っていた。調査の結果、Conductor が `cmux-team close-task` を呼ばず **`cmux-team send CONDUCTOR_DONE --surface ... --success true`** のみを送信していた。daemon 側は `success=true` を「close-task 済み想定」として扱うため、`task-state.json[204].status` が `assigned` のまま固まり、TUI / resume / cascade すべての判定が壊れた。

### 根本原因（テンプレート矛盾）

Conductor が読むプロンプトは 2 層に分かれる:

| 層 | テンプレート | ロード先 | 完了通知の指示 |
|---|---|---|---|
| role layer（常駐プロンプト） | `conductor-role.md` | `.team/prompts/conductor-role.md` | Step 11: `cmux-team close-task --task-id <TASK_ID> --journal "..."` のみ（close-task が内部で `postMessage({ type: "CONDUCTOR_DONE", success: true })` を送る — `main.ts:2906-2912`） |
| task layer（タスク割り当て毎） | `conductor-task.md:37-45` | `.team/prompts/conductor-task-<ID>-<ts>.md` | **"完了通知を送信する"** として `cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true` を明示 |

task layer は role layer より後に送られる・行数が少なく目につきやすいため、Conductor が close-task を飛ばして `send CONDUCTOR_DONE --success true` 単体呼びに短絡しやすい。この経路を通ると task-state は未更新のまま daemon の `handleConductorDone` に `success=true` が届く。

### daemon 側の整合性欠落

`daemon.ts:2967-2973`（T263/T269 実装後の `else` 分岐）:

```ts
} else {
  await log(
    "task_completed",
    `task_id=${taskId} ${formatSurface(conductor.surface, "C")}${...}`
  );
}
// Conductor をリセットして idle に戻す（unresolved 時は worktree/branch を温存）
await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined, {
  preserveWorktree: unresolved,
});
```

`unresolved = !success && currentStatus !== "closed" && ...` なので `success=true` は常に `unresolved=false` → worktree 削除 + `task_completed` ログ。ただし **task-state を読みも書きもしない**。ここで `currentStatus === "assigned"` でもガードされないのが構造的な穴。

### 影響範囲

| 項目 | 影響 |
|---|---|
| `skills/cmux-team/templates/ja/conductor-task.md` | 40-45 行目の指示を削除（必須） |
| `skills/cmux-team/templates/en/conductor-task.md` | 42-45 行目の指示を削除（必須） |
| `skills/cmux-team/manager/daemon.ts` | `handleConductorDone` に success=true 経路の整合性ガードを追加（保険） |
| `skills/cmux-team/manager/daemon.test.ts` | 新規ガードの動作テスト 2 件（auto-close / missing-skip） |
| `CHANGELOG.md` | `[Unreleased] / [next]` 節に破壊的変更と Rollout ガイドを追記 |
| `docs/spec/04-templates.md` | `conductor-task.md` の仕様記述を同期（必要なら） |
| `skills/cmux-team/templates/ja/manager.md:73` `en/manager.md:73` | 「主要な完了検出 = Conductor が `cmux-team send CONDUCTOR_DONE ... --success true`」の記述を「close-task が内部で送信する」に正す（文書整合のための副次修正） |
| `skills/cmux-team/templates/ja/conductor.md:276` `en/conductor.md:276` | deprecated（`docs/spec/04-templates.md:99-101` 参照）。`template.ts` からロードされない dead file のため **対象外**。将来の混乱を避けるため編集しない（仕様書が「編集や再参照は避けること」と明記） |

対象外（明示的に確認済み）:
- `skills/cmux-team/manager/i18n.ts:166,834` — help text 例示。`CONDUCTOR_DONE` コマンド自体は protocol として生きている（close-task から内部 post される）。example として削除しない。
- `skills/cmux-team/templates/{ja,en}/conductor-role.md:477` の `--success false` — rebase abort 経路で close-task が呼べない正当ユースケース。残す。

## 2. 技術アプローチ

### 選択したアプローチ

**二段構え:**

1. **1 次対策（テンプレート修正、必須）**: `conductor-task.md` から `send CONDUCTOR_DONE --success true` 指示を削除し、完了通知は `conductor-role.md` Step 11 の `close-task` に集約する旨だけを残す。
2. **2 次対策（daemon ガード、保険）**: `handleConductorDone` の `success=true` 経路に task-state 整合性チェックを追加。`currentStatus === "assigned"` なら警告ログ + **auto-close**（`status=closed` + journal に `auto_closed_by_daemon: CONDUCTOR_DONE without close-task` を記録）する。`currentStatus` が `undefined`（task-state missing）なら保守側で **state 書き込みを skip し warn ログのみ**。

#### 選択理由

- 1 次対策だけでは旧バイナリで稼働中の Conductor が resume した時に再発する。daemon ガードは「稼働中 Conductor が古いプロンプトを抱えたまま」パターンに対する恒久セーフティネット。
- ガードは将来的にテンプレートを直した後も残す（テンプレートの逸脱検出機構として機能する）。
- auto-close を選んだ理由（Decision D1 参照）: Conductor の `--success true` は「作業完遂」の自己申告。worktree / git 操作は既に完了している（Conductor の Step 9 でマージ or PR を出している）ため、task-state だけ取り残された状態を自動で整合させるのが安全。aborted に倒すと既にマージ済みの成果物と state が不整合になる。

### 代替案と却下理由

| 案 | 却下理由 |
|---|---|
| A. CLI で `cmux-team send CONDUCTOR_DONE --success true` を reject する | 後方互換を破壊（close-task が内部で同じ message を post する — 実装上は `postMessage` 直呼びで CLI を経由しないので技術的には破壊しないが、「user 明示呼び出しだけを reject」の判定ロジックが脆い）。task.md §3 も「2 の daemon ガードで十分なら不要」としている |
| B. `handleConductorDone` で success=true + assigned を **aborted** に倒す（保守側） | 既にマージ / PR 済みの成果物と矛盾。task を aborted に倒すと restart-task でやり直すフローに乗るが、既に close 相当の作業は完了済みなので人間の手間が増えるだけ |
| C. template 修正だけで済ませ daemon ガード見送り | 旧プロンプトで稼働中の Conductor が再発源として残る。受け入れ基準「新規に生成される `.team/prompts/conductor-task-*.md` に上記指示が含まれない」は満たすが、Rollout 期間の不整合を吸収できない |
| D. `close-task` 関数を daemon から呼び出し共通化 | `close-task` は `postMessage({ type: "CONDUCTOR_DONE", success: true })` を同時に post する（`main.ts:2906-2912`）。daemon 内で呼ぶと `handleConductorDone` → `close-task` → `postMessage` → `handleConductorDone` ... の再帰ループを招く。共通化はせず、D2 の通り task-state と trace DB の inline 書き込みに留める |

### 既存パターンとの整合性

T263 / T269 の `success=false + assigned` 経路（daemon.ts:2923-2966）と対称な構造にする:

| 条件 | T263/T269（既存） | T274（本計画） |
|---|---|---|
| `success=false && status ∈ {assigned, missing}` | `conductor_done_unresolved` → task-state を aborted に倒す + worktree 温存 + cascade | 変更なし |
| `success=true && status === "assigned"` | （穴）`task_completed` ログのみ、state 未更新 | **NEW: `task_completed_state_mismatch` ログ → state を closed に倒す + trace DB insert + worktree 削除** |
| `success=true && status === "missing"` | （穴）`task_completed` ログのみ | **NEW: `task_completed_state_missing` warn ログのみ、state 書き込み skip、worktree 削除** |
| 他の組み合わせ（closed/aborted/deleted 含む） | `task_completed` ログ、worktree 削除 | 変更なし |

上記の分類テーブル・inline state 書き込み・trace DB insert は T263 / T269 の `success=false + assigned` ブロック（daemon.ts:2940-2966）のコードパターンをそのまま踏襲する（try/catch、saveTaskState、log 分離）。

## 3. 変更対象

### 変更するファイル

| ファイル | 変更概要 |
|---|---|
| `skills/cmux-team/templates/ja/conductor-task.md` | L37-45「完了通知」セクションを書き換え。`send CONDUCTOR_DONE --success true` を削除し、完了通知は `conductor-role.md` Step 11 の `close-task` に一本化する旨を記述 |
| `skills/cmux-team/templates/en/conductor-task.md` | 同上（英語版） |
| `skills/cmux-team/manager/daemon.ts` | `handleConductorDone` の `success=true` 経路（L2967-2973 の else 分岐）に整合性ガードを追加。`currentStatus === "assigned"` で auto-close、`currentStatus === undefined` で warn+skip |
| `skills/cmux-team/manager/daemon.test.ts` | T274 describe ブロック追加。Case 新 #2（success=true + assigned → auto-close）、Case 新 #11（success=true + missing → warn+skip）の 2 テスト |
| `skills/cmux-team/templates/ja/manager.md:73` | 「主要な完了検出」の説明を「Conductor が `cmux-team close-task` を実行し、その内部で CONDUCTOR_DONE が daemon に送信される」に修正 |
| `skills/cmux-team/templates/en/manager.md:73` | 同上（英語版） |
| `CHANGELOG.md` | `[Unreleased]` 節に Breaking（テンプレート変更）・Added（daemon ガード）・Rollout セクションを追記 |

### 新規作成するファイル

なし。

### 削除するファイル

なし（conductor.md は legacy として残すが無改変）。

## 4. サブタスク分割

実装順序は「テンプレート修正 → daemon ガード → テスト → ドキュメント」。テンプレート修正だけでも成立するが、ガードが無いと rollout 期間の再発リスクが残るため同一タスク内で両方済ませる。

### S1. conductor-task.md（ja）から CONDUCTOR_DONE --success true 指示を削除【実装】

- **対象ファイル**: `skills/cmux-team/templates/ja/conductor-task.md`
- **変更内容**: L37-45 の「完了通知」セクションを以下の文面に差し替える
  ```markdown
  ## 完了通知

  完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
  - Step 11: `cmux-team close-task --task-id <TASK_ID> --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する
  - Step 12: 完了レポートをセッション上に表示する

  **`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
  ```
- **完了条件**:
  - `grep -n "send CONDUCTOR_DONE --surface \$CMUX_SURFACE --success true" skills/cmux-team/templates/ja/conductor-task.md` が 0 件
  - 「完了通知」セクションに `close-task` への参照が含まれる
- **検証コマンド**:
  ```bash
  ! grep -q "send CONDUCTOR_DONE --surface \$CMUX_SURFACE --success true" skills/cmux-team/templates/ja/conductor-task.md
  grep -q "close-task" skills/cmux-team/templates/ja/conductor-task.md
  ```

### S2. conductor-task.md（en）から CONDUCTOR_DONE --success true 指示を削除【実装】

- **対象ファイル**: `skills/cmux-team/templates/en/conductor-task.md`
- **変更内容**: L37-45 の「Completion Notification」セクションを以下の文面に差し替える
  ```markdown
  ## Completion Notification

  Follow the completion procedures in `conductor-role.md` ("Completion Procedures" Steps 1-12). In particular:
  - Step 11: `cmux-team close-task --task-id <TASK_ID> --journal "..."` closes the task and internally sends CONDUCTOR_DONE to daemon.
  - Step 12: Display the completion report on the session.

  **Do not call `cmux-team send CONDUCTOR_DONE --success true` yourself** — close-task does that on your behalf. Use the `--success false` path in `conductor-role.md` Step 8 only when you need to abort without calling close-task (e.g. rebase conflict).
  ```
- **完了条件**: S1 と対称（英語版）
- **検証コマンド**:
  ```bash
  ! grep -q "send CONDUCTOR_DONE --surface \$CMUX_SURFACE --success true" skills/cmux-team/templates/en/conductor-task.md
  grep -q "close-task" skills/cmux-team/templates/en/conductor-task.md
  ```

### S3. manager.md（ja/en）の「主要な完了検出」文を close-task 経由に修正【配線】

- **対象ファイル**:
  - `skills/cmux-team/templates/ja/manager.md`（L73）
  - `skills/cmux-team/templates/en/manager.md`（L73）
- **変更内容**:
  - ja: 「**主要な完了検出**: Conductor が `cmux-team close-task --task-id <TASK_ID> --journal "..."` を実行 → close-task が内部で daemon に CONDUCTOR_DONE を送信する」
  - en: 同等の英文
- **完了条件**:
  - manager.md 内に `close-task` が「主要な完了検出」の主語として現れる
  - `send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true` 単体の記述は残してもよい（protocol 説明として）。ただし「主要検出」ではなく「close-task が内部で post する message」として再位置づけする
- **検証コマンド**:
  ```bash
  grep -n "close-task" skills/cmux-team/templates/ja/manager.md
  grep -n "close-task" skills/cmux-team/templates/en/manager.md
  ```

### S4. daemon.ts の handleConductorDone に success=true 整合性ガードを追加【実装】

- **対象ファイル**: `skills/cmux-team/manager/daemon.ts`
- **メソッド制約**:
  - T263/T269 の `success=false + assigned` ブロック（daemon.ts:2940-2966）と同じパターンで inline 書き込み
  - `closeTask()` 関数は呼ばない（postMessage 再帰ループを避ける — Decision D2）
  - `loadTaskState` / `saveTaskState` / `initDB` / `insertTaskSession` を既存 import のまま再利用
  - journal 文言は固定: `auto_closed_by_daemon: CONDUCTOR_DONE without close-task (taskRunId=<id>)`（Decision D3）
  - ログイベント名: `task_completed_state_mismatch`（assigned 経路）、`task_completed_state_missing`（missing 経路）。logger.ts 規約の `*_mismatch` / `*_missing` はイベント名パターンとしては未確立だが、既存 `conductor_done_unresolved` と同じ「判定分岐の記録」カテゴリなので新規イベント名を追加する（Decision D5）
- **変更内容**（差分イメージ）:
  ```ts
  // daemon.ts の handleConductorDone 内
  const unresolved =
    !success &&
    currentStatus !== "closed" &&
    currentStatus !== "aborted" &&
    currentStatus !== "deleted";
  // --- T274 NEW: success=true でも assigned のまま残っていれば auto-close する ---
  const stateMismatchOnSuccess =
    success &&
    taskId &&
    taskId !== "undefined" &&
    currentStatus === "assigned";
  const stateMissingOnSuccess =
    success &&
    taskId &&
    taskId !== "undefined" &&
    currentStatus === undefined;

  if (!taskId || taskId === "undefined") {
    // 既存: error ログ
  } else if (unresolved) {
    // 既存: T263/T269 の conductor_done_unresolved → aborted 経路
  } else if (stateMismatchOnSuccess) {
    // T274 NEW: Conductor が close-task を skip したまま --success true を送った。
    //           state だけ取り残されるのを防ぐため daemon が代替で close に倒す。
    await log(
      "task_completed_state_mismatch",
      `task_id=${taskId} ${formatSurface(conductor.surface, "C")}` +
        ` prev_status=assigned reason=missing_close_task` +
        ` worktreePath=${conductor.worktreePath ?? "-"}` +
        (conductor.taskTitle ? ` title=${conductor.taskTitle}` : "") +
        (journalSummary ? ` journal_summary=${journalSummary}` : "")
    );
    try {
      const journal = `auto_closed_by_daemon: CONDUCTOR_DONE without close-task (taskRunId=${conductor.taskRunId ?? "-"})`;
      taskState[taskId] = {
        ...taskState[taskId],
        status: "closed",
        closedAt: new Date().toISOString(),
        journal,
      };
      await saveTaskState(state.projectRoot, taskState);
      await log("task_completed", `task_id=${taskId} ${formatSurface(conductor.surface, "C")} auto_closed=true`);
      // trace DB: insertTaskSession(event="closed")
      if (state.traceDb) {
        try {
          insertTaskSession(state.traceDb, {
            timestamp: new Date().toISOString(),
            task_id: taskId,
            task_run_id: conductor.taskRunId,
            session_id: conductor.sessionId ?? "",
            role: "conductor",
            surface: conductor.surface,
            event: "closed",
          });
        } catch (e: any) {
          await log("error", `T274 trace DB closed insert failed: ${e?.message ?? e}`);
        }
      }
    } catch (e: any) {
      await log("error", `handleConductorDone auto-close failed: task_id=${taskId} ${e.message}`);
    }
  } else if (stateMissingOnSuccess) {
    // T274 NEW: task-state にエントリが無いのに --success true。race or 手動削除後の goodbye。
    //           state 書き込みはせず warn ログだけ残して worktree 削除で後始末。
    await log(
      "task_completed_state_missing",
      `task_id=${taskId} ${formatSurface(conductor.surface, "C")}` +
        ` reason=missing_state_entry` +
        (conductor.taskTitle ? ` title=${conductor.taskTitle}` : "")
    );
  } else {
    // 既存: 通常の task_completed ログ（closed/aborted/deleted 経路 + success=false の closed 等）
  }
  ```
  ※ `state.traceDb` の初期化状況は既存ブロックに合わせる（test 内部では `state.traceDb = initDB(testDir)` が必要)。
- **完了条件**:
  - `handleConductorDone` に `task_completed_state_mismatch` ログ / auto_closed ブロックが追加されている
  - `success=false` の既存テスト（Case #9, #10）が壊れていない（regression なし）
  - `bunx tsc --noEmit skills/cmux-team/manager/daemon.ts 2>&1 | grep daemon.ts | grep -v "^daemon.ts(|^daemon.test"` が 0 件
- **検証コマンド**:
  ```bash
  grep -n "task_completed_state_mismatch" skills/cmux-team/manager/daemon.ts
  grep -n "auto_closed_by_daemon" skills/cmux-team/manager/daemon.ts
  cd skills/cmux-team/manager && bunx tsc --noEmit 2>&1 | grep -E "^daemon\.ts\(" || true
  ```

### S5. daemon.test.ts に T274 テストを追加【実装】

- **対象ファイル**: `skills/cmux-team/manager/daemon.test.ts`
- **メソッド制約**:
  - 既存の T263 ブロック（daemon.test.ts:4113-4340）の `setupRealGitWithWorktree` / `stubPaneForSurface` ヘルパーを再利用する（関数スコープが閉じているため、新規 describe 内で同等ヘルパーを定義する既存パターンに揃える — T269 ブロック:4348-4369 と同じ）
  - `state.traceDb = initDB(testDir)` を set up してから handleMessage を呼ぶ（T266 ブロック:4487 と同じ）
- **テスト内容**:
  1. **Case 新 #2: success=true && assigned → auto-close + task_completed + worktree 削除**
     - task-state を `{ status: "assigned", assignedAt: ... }` にセット
     - handleMessage で `{ type: "CONDUCTOR_DONE", success: true }` を送信
     - 期待:
       - `task-state[X].status === "closed"`、`closedAt` あり、`journal` に `auto_closed_by_daemon: CONDUCTOR_DONE without close-task` を含む
       - manager.log に `task_completed_state_mismatch task_id=<X> .* prev_status=assigned reason=missing_close_task` が出る
       - manager.log に `task_completed task_id=<X>` + `auto_closed=true` が出る
       - worktree ディレクトリが削除されている
       - `conductor.status === "idle"`
       - trace DB: `getTaskSessions(db, <X>)` に `event="closed"` 行が入る
  2. **Case 新 #11: success=true && missing → warn+skip + worktree 削除**
     - task-state には `<X>` エントリを作らない
     - handleMessage で `{ type: "CONDUCTOR_DONE", success: true }` を送信
     - 期待:
       - `task-state[X] === undefined`（新規 entry を作らない）
       - manager.log に `task_completed_state_missing task_id=<X> .* reason=missing_state_entry` が出る
       - worktree 削除
       - `conductor.status === "idle"`
- **完了条件**:
  - `bun test skills/cmux-team/manager/daemon.test.ts -t "T274"` が 2 件 pass
  - 既存 T263 / T269 の 4 件は regression なく pass（Case #1, #6, #9, #10）
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager && bun test daemon.test.ts -t "T274"
  cd skills/cmux-team/manager && bun test daemon.test.ts -t "T263"   # regression
  cd skills/cmux-team/manager && bun test daemon.test.ts -t "T269"   # regression
  ```

### S6. CHANGELOG.md に破壊的変更として記載【実装】

- **対象ファイル**: `CHANGELOG.md`
- **変更内容**: ファイル先頭の `## [Unreleased]`（なければ新設）に以下を追記
  ```markdown
  ## [Unreleased]

  ### Changed (Breaking)
  - **Conductor の完了通知を `close-task` に一本化（T274、破壊的変更）**。`skills/cmux-team/templates/{ja,en}/conductor-task.md` の「完了通知」セクションから `cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true` 指示を削除し、`conductor-role.md` Step 11 の `close-task` に集約した。close-task が内部で CONDUCTOR_DONE を daemon に送信するため、Conductor 側から重ねて送る必要は無い（~/git/Dear T204 で TUI `[assigned]` + manager.log `task_completed` の不整合を引き起こしていた）。**Rollout 時の注意:** 旧プロンプトを抱えた Conductor が Claude Code のセッション resume で復帰すると古い指示を実行し得るため、リリース後は `cmux-team restart` または各 Conductor ペインで `/clear` を実行して新プロンプトを読み込ませること。

  ### Added
  - **`handleConductorDone` に success=true 経路の整合性ガード（T274）**。Conductor が `--success true` を送ったのに task-state が `assigned` のまま残っていた場合、`task_completed_state_mismatch` を warn ログに出した上で daemon が自動で `closed` に倒す（journal: `auto_closed_by_daemon: CONDUCTOR_DONE without close-task (taskRunId=<id>)`）。`task-state` entry 自体が無い場合は `task_completed_state_missing` warn ログのみ残し state 書き込みは skip。T263/T269 の `success=false + assigned → aborted` パスと対称な保険として機能する。
  ```
- **完了条件**:
  - `grep -q "T274" CHANGELOG.md` が true
  - `grep -q "Rollout" CHANGELOG.md` が true（`cmux-team restart` 案内の存在確認）
- **検証コマンド**:
  ```bash
  head -30 CHANGELOG.md | grep -E "T274|Rollout"
  ```

### S7. docs/spec/04-templates.md の conductor-task.md 記述を同期【ドキュメント】

- **対象ファイル**: `docs/spec/04-templates.md`
- **変更内容**: L114-118（`### conductor-task.md（シンプル版）`）の説明に「完了通知は `conductor-role.md` Step 11 の `close-task` に集約」の 1 行を追記。変数一覧は変更なし。
- **完了条件**: `04-templates.md` の conductor-task.md 節で close-task 一本化に触れている
- **検証コマンド**:
  ```bash
  grep -A3 "conductor-task.md（シンプル版）" docs/spec/04-templates.md | grep close-task
  ```

### 配線・削除タスク

- **配線タスク**: S3（manager.md の文書整合）、S7（spec 同期）
- **削除タスク**: 該当なし。旧実装の物理削除は不要（`conductor.md` は deprecated として温存、`send CONDUCTOR_DONE --success true` CLI 自体は close-task から呼ばれ続けるため削除しない）。

## 5. リスク

### 既存機能への影響

| リスク | 影響度 | 緩和策 |
|---|---|---|
| R1. テンプレート変更後も旧プロンプトを保持した稼働中 Conductor が send CONDUCTOR_DONE --success true を送り続ける | 中 | daemon ガード（S4）で state 整合性を担保。Rollout 時は `cmux-team restart` を推奨（CHANGELOG に明記） |
| R2. auto-close で既にマージ済みの成果物と task-state が矛盾するケース | 低 | そもそも `--success true` は Conductor の自己申告。Conductor Step 9 でマージ / PR 済みなので state を closed に倒しても既存成果物との不整合は生じない。むしろ assigned のまま残る方が TUI / resume が壊れる |
| R3. auto-close が濫用され close-task を呼ばない Conductor が量産される | 低 | ログに `task_completed_state_mismatch` が出るため監視で検知可能。CHANGELOG と docs/spec に「これは fallback であり正規経路は close-task」と明記する |
| R4. cascade（depends_on 子を ready→draft に戻す）が auto-close で走らない | 低 | close は cascade を起こさない（cascade は abort/delete のみ — T241）。既存挙動と一致するので問題なし |
| R5. T263/T269 テストの regression | 中 | S5 で regression verify。`success=false` の unresolved 経路は条件分岐順で `else if (unresolved)` を先に判定することで影響を与えない |
| R6. trace DB の insertTaskSession が `state.traceDb` 未初期化で落ちる | 低 | 既存 main.ts:2925-2938 と同じ try/catch パターン。test では明示的に `state.traceDb = initDB(testDir)` をセット |

### エッジケース

- **E1. success=true + status=missing（race ケース）**: Decision D4 により state 書き込み skip + warn ログのみ。T263 の `success=false + missing → aborted` のように新規 entry を作る選択肢もあるが、success=true で unknown な task に closed 状態を書くのは source of truth が無く危険。既存挙動（state 未書き込み）を保つほうが保守的
- **E2. success=true + status ∈ {closed, aborted, deleted}**: 既存の `else` 分岐をそのまま通し `task_completed` ログ。重複完了 / late completion で成立するので挙動変更しない
- **E3. conductor.taskId === undefined**: 既存 error ログ経路のまま（変更なし）
- **E4. taskState.json が読めない**: `loadTaskState` の throw は handleConductorDone の呼び出し側にバブルアップする。既存挙動と同じ（変更なし）

### テスト戦略

- **新規テスト**: S5 の 2 ケース（Case 新 #2 / Case 新 #11）で daemon ガードをカバー
- **回帰テスト**: 既存 T263 の Case #1/#6/#9/#10、T269 の 2 件を通す
- **手動 E2E**: `cmux-team start` で daemon 起動 → Conductor が `send CONDUCTOR_DONE --success true` だけを送る古いプロンプトを手動シミュレート → manager.log に `task_completed_state_mismatch` が出て `task_completed auto_closed=true` で closed になり TUI が assigned に張り付かないことを確認

## 6. 既存型エラーの先読み

対象ファイルは TypeScript 2 ファイル（`daemon.ts`, `daemon.test.ts`）。事前確認:

```bash
cd skills/cmux-team/manager && bunx tsc --noEmit 2>&1 | grep -E "^(daemon\.ts|daemon\.test\.ts)\("
```

結果:

```
daemon.test.ts(3650,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
```

### 6.1 本タスクのスコープで解消するエラー

| ファイル | エラー | 方針 |
|---|---|---|
| （なし） | — | — |

### 6.2 後続タスク（cleanup）に分離するエラー

| ファイル | エラー | 分離理由 | 予定 cleanup タスク名 |
|---|---|---|---|
| `daemon.test.ts(3650,9)` | `"new_session"` is not assignable to `SessionStartSource` | T260 broken 検知テストの既存エラー。本タスクが触らない describe ブロック内（L3618-3660 付近）に閉じている。スコープ外（修正は `SessionStartedMessage.source` の enum 拡張か test の文字列修正で別タスク推奨） | `T275-sessionstart-source-enum-new_session` 等で分離 |

`daemon.ts` 本体は 0 件。S4 で追加するコードが型安全であることを保証する。

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|---|---|---|---|
| D1 | success=true + assigned を auto-close するか aborted に倒すか | **auto-close** | Conductor の `--success true` は「作業完遂」の自己申告。Step 9（マージ/PR）までは既に終わっている前提なので state だけ closed にすれば整合する。aborted に倒すと人間の restart-task が必要になり既に存在する成果物と state が矛盾する。なお T263/T269 で aborted を選んでいるのは `success=false`（判断待ち）経路であり前提が異なる |
| D2 | `closeTask()` 関数を呼ぶか inline state 書き換えか | **inline** | `closeTask` は `postMessage({ type: "CONDUCTOR_DONE", success: true })` を同時に post する（`main.ts:2906-2912`）。daemon 内で呼ぶと `handleConductorDone` → `closeTask` → `postMessage` → `handleConductorDone` の再帰を招く。T263/T269 の inline 書き換えパターン（daemon.ts:2940-2947）と同形にする |
| D3 | journal 文言 | `auto_closed_by_daemon: CONDUCTOR_DONE without close-task (taskRunId=<id>)` | task.md §2 の提案どおり。grep 可能な固定プレフィクス + taskRunId で事後追跡。T263 の `conductor_done_unresolved: <reason> (worktree=...) taskRunId=...` と命名パターンを揃える |
| D4 | success=true + task-state missing の扱い | **warn ログのみ、state 書き込み skip** | missing = entry 自体が無い状態。closed に倒すには「何を closed にするか」の source of truth が無い（title / priority も不明）。既存挙動（state 未書き込み）を保ちつつログで可視化する。成果物が git に残っていれば後で手動で close-task / restart-task 可能 |
| D5 | ログイベント名 | `task_completed_state_mismatch` / `task_completed_state_missing` | logger.ts 規約の `*_mismatch` / `*_missing` は前例無しだが、`conductor_done_unresolved` と同じ「判定分岐の記録」カテゴリ。grep でペアで追跡できるよう prefix を揃えた |
| D6 | conductor-task.md の「完了通知」セクション自体を残すか | **残す（文面を差し替える）** | セクション削除だと Conductor が「どこに完了通知手順があるか」を探し回る。`conductor-role.md` Step 11 への参照 + `send CONDUCTOR_DONE --success true` 禁止 + 例外（`--success false`）の 3 項目を 1 セクションで示すことで逸脱を防ぐ |
| D7 | `conductor.md`（legacy）も同時修正するか | **修正しない** | `docs/spec/04-templates.md:99-101` で「編集や再参照は避けること」と明記済み。runtime で `template.ts` からロードされない dead file。ここを触ると却って新旧乖離の錯覚を招く |
| D8 | `manager.md:73` の「主要な完了検出」文を修正するか | **する（副次）** | テンプレート整合性。close-task が主要経路になったので記述を合わせる（S3）。実行時には manager.md はロードされないが、次の dockeeper スキャンや人間の読解を阻害しないよう |
| D9 | CLI で `cmux-team send CONDUCTOR_DONE --success true` を reject するか | **しない** | close-task が内部で同じ message を post する。CLI 層で reject すると close-task が壊れる。判定を「ユーザー明示呼び出しのみ」に絞ると脆い。daemon ガード（S4）だけで十分 |
| D10 | i18n.ts の help 例示を変えるか | **変えない** | `cmux-team send CONDUCTOR_DONE` は protocol として生きているコマンド。help の example を削ると逆に「使えないコマンドか？」と混乱する。conductor-task.md と CHANGELOG で「Conductor からは呼ばない」旨を示せば十分 |

---

## 備考

- 本計画は `~/git/Dear/.team/tasks/204-*` の T204 事例を根本原因として分析した結果に基づく。
- daemon ガード実装と CHANGELOG の Rollout セクションはセットで価値を持つ（旧 Conductor が resume した場合の保険）。S4 と S6 はどちらかだけを省略しないこと。
- 受け入れ基準 4 件はすべて S1–S6 でカバーされる:
  - [x] conductor-task.md（ja/en）から `send CONDUCTOR_DONE --success true` 削除 → S1/S2
  - [x] 新規生成の `.team/prompts/conductor-task-*.md` に含まれない → S1/S2 の帰結（template.ts が同ファイルから生成するため）
  - [x] daemon の handleConductorDone に整合性チェック → S4
  - [x] CHANGELOG に破壊的変更 + Rollout ガイド → S6
