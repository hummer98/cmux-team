# T269 Implementation Report

## 概要

`handleConductorDone` の preserveWorktree 経路（success=false）で task-state を `assigned` のまま放置していた回帰を修正し、task-state を `aborted`（reason=judgment_pending）に遷移させる。これにより `applyResumeTransitions`（T264）が preserveWorktree タスクを誤って resume する問題を解消する。

## 実装したファイル一覧（diff 要約）

```
 CLAUDE.md                                       |  25 +++-
 skills/cmux-team/manager/daemon.test.ts         | 158 ++++++++++++++++++++++++
 skills/cmux-team/manager/daemon.ts              |  32 +++++
 skills/cmux-team/templates/en/conductor-role.md |   4 +-
 skills/cmux-team/templates/ja/conductor-role.md |   4 +-
 5 files changed, 218 insertions(+), 5 deletions(-)
```

### 1. `skills/cmux-team/manager/daemon.ts`（+32 行）

`handleConductorDone` の unresolved 分岐（`conductor_done_unresolved` ログ出力直後）に、task-state を `aborted` に遷移させるブロックを追加。

- `status !== closed/aborted/deleted` の場合のみ遷移（既 aborted/closed への上書きを防止）
- journal フィールドに `conductor_done_unresolved: <reason> (worktree=<path>) taskRunId=<id>` を記録
- `cascadeAbortToChildren` で ready 子タスクを draft に戻す
- reverted children がある場合のみ `notifyStateChanged` を発火
- try/catch で既存の `resetConductor` フローをブロックしない（失敗時は `error` ログのみ）

### 2. `skills/cmux-team/manager/daemon.test.ts`（+158 行）

- **Case #9**: preserveWorktree + success=false 経路で task-state が `aborted` かつ journal に `conductor_done_unresolved` を含むことを確認
- **Case #1, #6**: 成功系 / preserveWorktree=true+success=true で `task_aborted reason=judgment_pending` が **出ない** ことを回帰ガード
- **Case #10**: task-state 欠落時の挙動を更新（欠落 task_id でも `aborted` エントリが作成されることを確認）
- **新 describe ブロック T269**: 2 テスト
  - Test 1: `applyResumeTransitions` が preserveWorktree-aborted タスクを resume しない
  - Test 2: parent aborted → 子 ready が draft に戻る cascade

### 3. `skills/cmux-team/templates/{ja,en}/conductor-role.md`（+4 / 各 2 行）

Step 8 の文言修正:
- 旧: 「`assigned` のまま放置」→「Master / ユーザーが `abort-task`」
- 新: 「`aborted` に遷移（reason=judgment_pending）」→「Master / ユーザーが `restart-task` で再投入」

### 4. `CLAUDE.md`（+25 行）

- 新節「CONDUCTOR_DONE の state 遷移（T263 / T269）」を追加
  - 3 パターン表（success=true / success=false 未解決 / success=false 解決済み）
  - journal 形式の説明
- cascade 経路を「6 経路」→「7 経路」に更新し、`handleConductorDone` unresolved を 7 番目として追記

## 追加/修正したテストの結果

```
bun test v1.3.12 (700fc117)
 155 pass
 0 fail
 493 expect() calls
Ran 155 tests across 1 file. [9.80s]
```

全テストパス（既存 151 + T269 新規 2 + Case #9 拡張 + Case #10 更新）。

## 既存テストへの影響

- **Case #9**: 拡張のみ（既存 assertion 削除なし、task-state expect 追加）
- **Case #10**: 期待値を更新（missing entry 時に aborted エントリが作成される新挙動を反映）
- **Case #1, #6**: ポジティブ assertion 追加（`task_aborted reason=judgment_pending` が出ないこと）
- その他の Case: 影響なし

## 型チェック結果

```
bunx tsc --noEmit
conductor.ts(197,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3650,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
```

いずれも **plan §6 に記載済みの pre-existing エラー**（T266 rebase 由来）。T269 由来の型エラーは 0 件。

## plan.md との差分

### 差分あり（ただし plan 意図に準拠）

1. **log フォーマット**: plan では `journal_summary=<journal>` 形式だったが、実装では `task_aborted task_id=X reason=judgment_pending` のシンプル形式（user_clear パターンと統一）を採用。
   - 理由: journal 全文は task-state.json で参照できるため冗長。既存 user_clear 経路 (`daemon.ts:2118-2154`) とログ形式を揃えた。
   - 回帰ガードテストも `/task_aborted .*reason=judgment_pending/` 正規表現で両形式に対応。

2. **`handleConductorDone` のシグネチャ**: plan の M3 では `reason?: string` の追加を指摘していたが、T263 rebase 済みブランチで既に追加済みだったため変更不要。

### 差分なし

- S2: unresolved 分岐挿入位置（`conductor_done_unresolved` ログ出力直後、`resetConductor` 前）
- S3: テスト配置（Case #9 拡張 + 新 describe ブロック）
- S4/S5: conductor-role.md ja/en の文言変更箇所
- S6: CLAUDE.md 新節追加 + cascade 7 経路化

## Review の Minor findings / Recommendations への対応状況

### M1: journal フィールドの形式統一
**対応済み**: `conductor_done_unresolved: <reason> (worktree=<path>) taskRunId=<id>` 形式で記録。

### M2: cascade の notifyStateChanged
**対応済み**: `revertedChildren.length > 0` の場合のみ `notifyStateChanged("daemon.ts:handleConductorDone:unresolved-cascade")` を発火。空配列時は emit しない（「emit 箇所 = state mutation 箇所」不変条件を遵守）。

### M3: `handleConductorDone` のシグネチャ
**対応済み**: T263 rebase 済みで既に `opts?: { success?: boolean; reason?: string }` が付与されていたため追加作業なし。

### M4: 既 aborted/closed への上書き防止
**対応済み**: `status !== closed/aborted/deleted` の guard 条件を追加。guard に引っかかった場合は `conductor_done_unresolved_skip` をログ出力。

### M5: エラーハンドリング
**対応済み**: try/catch で囲み、失敗時は `log("error", ...)` のみで `resetConductor` 本流はブロックしない。

### R1: テスト命名規則
**対応済み**: 新 describe ブロックは `T269: preserveWorktree 経路のタスクが restart 時に resume されない` と仕様準拠の日本語命名。

### R2: conductor-role.md の文言
**対応済み**: ja/en 両方で Step 8 を `aborted` / `restart-task` に統一。

### R3: CLAUDE.md の配置
**対応済み**: T264 resume 節の直後、cascade 節の直前に新節を挿入。cascade 経路表も同時に更新。

### R4: ログ形式の統一
**対応済み**: `task_aborted task_id=X reason=judgment_pending` 形式で user_clear パターンと統一。

### R5: 回帰ガードテスト
**対応済み**: Case #1（success=true）/ Case #6（preserveWorktree=true + success=true）の両方に `expect(log).not.toMatch(/task_aborted .*reason=judgment_pending/)` を追加。

## 検証サマリ

| 項目 | 結果 |
|------|------|
| rebase onto c5f5526 | ✅ クリーン |
| daemon.ts 修正 | ✅ +32 行 |
| daemon.test.ts 全テスト | ✅ 155 pass / 0 fail |
| conductor-role.md ja/en 修正 | ✅ Step 8 両方更新 |
| CLAUDE.md 更新 | ✅ 新節 + cascade 7 経路化 |
| 型チェック（T269 由来） | ✅ 0 件 |
| Review の M1-M5 / R1-R5 | ✅ 全対応 |
