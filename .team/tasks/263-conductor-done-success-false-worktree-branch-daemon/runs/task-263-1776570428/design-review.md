# T263 Design Review

## Verdict: Approved

## Summary

プランは T263 の根本原因（`handleConductorDone` が success 値と task-state を見ずに
無条件 cleanup する仕様乖離）を正確に捉え、`resetConductor` への `preserveWorktree`
オプション追加 + `handleConductorDone` の task-state 分岐という最小侵襲の設計で
解決している。挙動表（全 10 ケース）・Decision Log（D1-D12）・サブタスク分割
（ST1-ST5）・リスク評価（R1-R7）いずれも網羅性が高く、CRITICAL チェック項目を
全て満たす。Minor な改善提案はあるが、Changes Requested に倒すほどの欠落はない。

## Findings

1. **[minor] `conductor_error` ログと `conductor_done_unresolved` の二重発行**
   `daemon.ts:1305-1309` は CONDUCTOR_DONE handler で既に
   `conductor_done_signal` / `conductor_error` を発行している。プランの変更後、
   success=false && unresolved ケースでは `conductor_error` + `conductor_done_unresolved`
   の 2 行が同じ意図で並ぶ。意図的な役割分担（シグナル受信 vs 判定結果）であれば
   問題ないが、プラン上で「両方出る」ことが明示されていない。実装時に Decision
   として記録しておくとログ読解時の混乱を避けられる。

2. **[minor] `loadTaskState` の重複読み込み**
   `collectResults`（`conductor.ts:671`）が既に task-state.json を読んでいる。
   `handleConductorDone` で再度 `loadTaskState` を呼ぶと同一 tick 内で 2 回読み込む。
   ファイルは小さいので性能影響は無視できるが、`collectResults` の戻り値に
   `currentStatus` を含める / 引数で `taskState` を渡す等の小改修で
   double-read を避けられる。任意改善。

3. **[minor] conductor-role.md 参照パス**
   プラン Section 10 で `skills/cmux-team/templates/ja/conductor-role.md:445-480` を
   参照しているが、CLAUDE.md のリポジトリ構造では `skills/cmux-team/templates/` が
   フラット構造。`ja/` サブディレクトリは実装者が存在確認して実パスに置換すること。
   存在しない場合は `templates/conductor-role.md` を参照対象にする。

4. **[minor] `resetConductor` 呼び出し元のカウント**
   Section 6 R1 は「6 箇所」としているが、実際の production 呼び出し元は 5 箇所
   （`main.ts:780`, `daemon.ts:1334`, `daemon.ts:2151`, `daemon.ts:2709`,
   `daemon.ts:2736`）。テストファイル内の 8 呼び出しを除いた実数。デフォルト
   `preserveWorktree=false` で全て無影響という結論は変わらないため、影響なし。

5. **[minor] ST2 Case A のテスト setup 明示性**
   「worktree ディレクトリが fs 上に残る、git branch も残る」を検証するには
   実際の git worktree + branch を testDir に用意する必要がある。既存の
   `conductor.test.ts:386` 以降のテストは ConductorState 操作のみで fs 検証して
   いないため、新規テストで git コマンドを呼ぶかモックするかの方針を実装時に
   明確化しておくこと。`execFile` を `mock.module` で spy して「呼ばれない」ことを
   検証する方が flaky になりにくい（推奨）。

6. **[minor] ST1 完了条件に `worktree_preserved=true` ログ suffix の検証が無い**
   Section 2.2 で「`preserveWorktree` が true の場合は `reasonSuffix` の手前に
   ` worktree_preserved=true` 等の補助フィールドを追加する」と明記しているが、
   ST1 の完了条件にはこのログフォーマット検証が含まれていない。ST2 Case A の
   検証項目に「`conductor_reset` ログに `worktree_preserved=true` が含まれる」を
   追加推奨。

## Recommendations

以下は任意の改善提案（Approved 判定のため必須ではない）。

- **Finding 1 対応**: 実装時に `conductor_error` と `conductor_done_unresolved` が
  並んで出ることを Decision Log D13 として追記するか、handler 側のログを
  `conductor_done_signal` だけに整理する選択肢を implementer が検討する。
  後者は既存 grep 利用者への破壊的変更になるため慎重に。

- **Finding 2 対応**: `handleConductorDone` の `loadTaskState` 呼び出しを
  `collectResults` と統合するか、`collectResults` の戻り値を
  `{ journalSummary?, currentTaskStatus? }` に拡張する。任意。

- **Finding 5 対応**: ST2 Case A/B/C の git 操作検証は `execFile` をモック化し
  「git worktree remove が呼ばれない / 呼ばれる」を spy で確認する方式が既存
  パターンと整合的（`conductor.test.ts` の `listSiblingsSpy` / `closeSurfaceSpy`
  と同じスタイル）。

- **Finding 6 対応**: ST1 完了条件に以下を追加。
  - preserveWorktree=true 時、`conductor_reset` ログ本文に `worktree_preserved=true`
    が含まれる
  - preserveWorktree=false / 未指定時、上記 suffix が含まれない

## CRITICAL チェック結果

| 項目 | 結果 | 備考 |
|---|---|---|
| サブタスクカバレッジ | ✓ PASS | ST1(実装) + ST2(単体テスト) + ST3(配線) + ST4(統合テスト) + ST5(E2E) |
| 統合テスト/検証 | ✓ PASS | ST4 Case #9 が `resetConductor` への `preserveWorktree=true` 伝播を spy で検証（handleConductorDone ↔ resetConductor 接続の検証として十分） |
| 既存テストへの影響 | ✓ PASS | ST3 完了条件に「既存 task_completed 系テストが破綻しない」を明記、全 bun test pass を ST5 で要求 |
| 挙動表の完全性 | ✓ PASS | 10 ケース（success × {closed, aborted, deleted, assigned, missing}）全てカバー。missing 両経路（true / false）も明示 |
| 呼び出し元の影響 | ✓ PASS | R1 で 5 呼び出し元の default=false による互換性を保証。変更は `handleConductorDone` の 1 箇所のみ |

## 本タスク固有ポイントの判定

- `preserveWorktree=true` でも ConductorState リセット: **妥当**（D7 で根拠明記、
  taskRunId を残すと次タスク割り当てが破綻するため fs と in-memory を分離）
- `loadTaskState` 失敗時の保守側倒し: **妥当**（R4 / D4 で明記、worktree 温存側に
  倒す方が被害が小さい）
- `conductor_done_unresolved` ログから要対応タスク復元: **可能**（task_id / surface /
  task_state / reason / worktreePath / title が揃っているため `grep
  conductor_done_unresolved manager.log` で列挙し、worktreePath で直接 `cd` できる）
- `close-task` を daemon が自動発動しない: **仕様一致**（D8 で Step 9.5 準拠を明記）
