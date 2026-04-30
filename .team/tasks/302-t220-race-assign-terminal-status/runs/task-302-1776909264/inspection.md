# T302 検品レポート

## 検品結果: **GO**

## 検証したコマンド結果

### `bun test` (ワーキングディレクトリ: `skills/cmux-team/manager`)

```
1088 pass
0 fail
2562 expect() calls
Ran 1088 tests across 36 files. [49.30s]
```

T302 フィルタ実行:

```
bun test daemon.test.ts -t "T302 assign_skipped_terminal"
 5 pass
 159 filtered out
 0 fail
 34 expect() calls
Ran 5 tests across 1 file. [215.00ms]
```

### `bunx tsc --noEmit`

合計 3 件（全て既存エラー）:

- `conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.`
- `daemon.test.ts(3870,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.`
- `daemon.ts(1546,22): error TS2352: Conversion of type 'string | undefined' ...`

**新規エラー 0 件**を確認（`git stash` でベースラインを退避して同一 3 件のみ出ることを自分で検証済み）。

### `git diff HEAD --stat`

```
 skills/cmux-team/manager/daemon.test.ts | 213 ++++++++++++++++++++++++++++++++
 skills/cmux-team/manager/daemon.ts      |  64 ++++++++--
 2 files changed, 265 insertions(+), 12 deletions(-)
```

対象は plan.md 付録の「変更ファイル一覧」と完全一致。無関係ファイルへの波及なし。

## 観点別チェック

### 1. タスク受け入れ条件

- [x] 既存 `bun test` pass（1088/1088、自分で実行）
- [x] 新規テスト: `task-state` を `deleted` に書き換えた状態で `__testApplyAssignCommit` が assign 書き込みを skip し、`resetConductor` 経由で worktree cleanup と Conductor idle 化されるケースが存在（`deleted-race` ケース、`aborted-race` / `closed-race` / `ready normal` / `undefined status` の計 5 ケース）
- [x] `bunx tsc --noEmit` 新規エラー 0 件

### 2. コード品質

- [x] ガード条件は plan.md 3.1 通り: `ts[taskId]?.status` を読み `isTerminalStatus(currentStatus)` で判定（`daemon.ts:2679-2680`）
- [x] ログイベント名 `assign_skipped_terminal`、フォーマットは `C[<surface>] task_id=<id> current_status=<s> taskRunId=<id>` で CLAUDE.md ログポリシー準拠
- [x] `formatSurface(updated.surface, "C")` を使用（`daemon.ts:2683`）
- [x] `TODO(T303): remove after reducer migration` JSDoc 末尾に明記（`daemon.ts:2671`）
- [x] import 追加なし（plan.md 予告通り。`isTerminalStatus` / `resetConductor` / `formatSurface` / `log` / `loadTaskState` / `saveTaskState` は既存 import を再利用）
- [x] 既存コードへの無関係な変更なし（scanTasks 内の該当 12 行ブロックを helper 呼び出し 2 行に置換しただけ。他箇所はコメント 2 行の追記のみ）

### 3. テストの実効性

- [x] 各 terminal ケースで以下を検証している（単なるモック返り値の確認ではない）:
  - **task-state が巻き戻らない**: `tsAfter["302"]?.status === "deleted"`、`deletedAt` 保持、`assignedAt === undefined`
  - **Conductor が idle に戻る**: `conductor.status === "idle"`、`taskId` / `taskRunId` / `worktreePath` が `undefined` にリセット
  - **ログ emit**: `assign_skipped_terminal` / `current_status=deleted` / `conductor_reset` が `.team/logs/manager.log` に記録される
- [x] 3 種の terminal 状態を carry: `deleted` / `aborted` / `closed` を独立ケースで検証。plan.md 4.3 は 4 ケース（`closed` 省略）だったが、`isTerminalStatus` の分岐カバレッジ網羅のため `closed-race` を追加（impl-report.md で逸脱を明記済み、妥当な拡張）
- [x] 正常系 `ready`: `committed=true`、`status=assigned`、`assignedAt/conductorSlot/taskRunId/sessionId` 書き込み、Conductor は `assigning` のまま（reset されない）を検証
- [x] defensive `undefined status`: ガード不発動で `assigned` が書き込まれることを検証
- [x] モック化は最小限: `cmux.getPaneForSurface` / `listSiblingSurfaces` / `closeSurface` の 3 関数のみ `spyOn`（`conductor.test.ts` の T250 と同じパターン）。`beforeEach` / `afterEach` でライフサイクル管理済み

### 4. race window の妥当性

- [x] ガード発動時に残る副作用（既送信済みの `/clear` + プロンプト、cmux セッション状態）について impl-report.md `### 1. テストに cmux 関数のモックを追加した` と plan.md `5.1 既に送信済みの /clear + プロンプトが Claude セッションで空実行される` で明示的に議論されており、受容可の根拠（delete された task の作業続行の方が有害・Conductor は自律再起動可能・T303 reducer 置換で構造的解決予定）が示されている
- [x] `5.1` の補強案（`C-c` 相当の割り込み送信）が検討されたうえで不採用の理由（`cmux.sendKey` のセマンティクス不確定、T303 で廃止予定）が記述されている

### 5. 構造的問題の有無

- [x] plan.md `5.2 race タイミングの網羅性` で「`loadTaskState → 判定 → saveTaskState` の間の非同期割り込みは防げない」サブ race が明示され、発生確率が本題 race の 10^-3 以下であることから受容、T303 reducer 置換で解消予定と記述されている
- [x] T303 削除予定が以下の 3 箇所で明示されている:
  - `daemon.ts:2671` JSDoc 末尾 `TODO(T303): remove after reducer migration`
  - `daemon.ts:2668-2669` JSDoc 本文 `T303 の reducer 置換でガードごと削除する予定`
  - `daemon.ts:2647` インラインコメント `T302: terminal race ガードは __testApplyAssignCommit に集約している`
- [x] `__test` prefix export 慣習（`__testSpawnPidWatcherTick` 等の precedent）と整合しており、T303 で helper ごと削除される前提が明確

## 総評

plan.md に記載された方針 B（`__testApplyAssignCommit` helper への括り出し）を忠実に実装。
ガード本体・ログフォーマット・`resetConductor` の再利用・import 不追加・`TODO(T303)` マーカーいずれも
plan.md 通り。既存テスト 1083 件 + 新規 5 件で pass / 新規 tsc エラー 0 件を自分の環境で確認済み。

plan.md 4.3 の 4 ケースから `closed` を独立した 5 ケース目に拡張した点は、`isTerminalStatus`
（closed / aborted / deleted 同一視）のガード仕様カバレッジとして妥当で、plan.md の意図を
むしろ強化している。テストは単なるモック返り値の確認に留まらず、task-state の状態保持・
Conductor state 遷移・ログ emit まで副作用を網羅的に検証しており、race 発動時の挙動を
回帰テストとして十分記録できている。

T302 は「暫定ガード」という位置付けが明確で、T303 の reducer 置換時に helper ごと削除される
という契約も JSDoc / テスト名 / plan.md の 3 箇所に記録されているため、技術負債としての
管理も適切。**受け入れ条件を全て満たしているため GO**。
