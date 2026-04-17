# T230 Design Review: Master self-register 化

- Reviewer: design-reviewer-task-230
- Reviewed plan: `.team/tasks/230-master-self-register-pane-cmux-team-spawn-master/runs/task-230-1776382576/plan.md`
- Base: `b2c6c0a` (T229 完了直後)
- Worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-230-1776382576`

## Verdict: Approved

CRITICAL チェック項目はすべて満たされており、Critical findings は 0 件。
ただし実装着手前に下記 **Major findings** に必ず対処すること。Major を放置するとテストが通らないか、Master 監視機能が壊れるリスクがある。

## Summary

T230 計画は T228 (Conductor self-register) の成功パターンを Master へ忠実に拡張する妥当な設計。サブタスク分割は実装→配線→削除→テスト→docs と論理順で、Decision Log と Risk Table も網羅的。`state.masters.set` を boot 時復元と MASTER_REGISTERED handler の 2 箇所のみに限定する守護条件 (D3) も grep 検証コマンドつきで受け入れ条件に明記されており、`spawnAndRegisterMaster` の解体方針も妥当。

ただし (1) MASTER_REGISTERED より先に SESSION_STARTED が届いた場合の PID watcher 起動経路、(2) `spawnMasterPane` と既存 `master.ts:spawnMaster` の責務境界の曖昧さ、(3) T6 統合テストでの `cmux.closeSurface` モック方針の欠如、の 3 点で実装時に詰まる可能性があるため Major として指摘する。

## Findings

### F1. [Major] SESSION_STARTED 先着時に PID watcher が永続的に起動しない race

- **対象**: 計画 §5「リスク - エッジケース」末尾、§4 S5 (D6 の根拠)
- **指摘内容**: D6 で「MASTER_REGISTERED handler では PID watcher を起動しない、既存 SESSION_STARTED handler に委ねる」としているが、現状の `daemon.ts:1010-1029` の SESSION_STARTED handler は `state.masters.get(message.surface)` が undefined なら master 経路を飛ばし conductor 経路へフォールスルーする。conductor にも該当しなければ最終的に `session_started_ignored reason=not_found` (L1117) でドロップする。
- **race 経路**:
  1. `cmdLaunchMaster` は `await registerSelfAsMaster(surface)` → `execFileSync("claude", ...)` の順なので通常はメッセージ順序が守られる
  2. ただし **handleMessage は queue から順次処理** されるため、daemon が他のメッセージ処理で詰まっている間に SESSION_STARTED が POST 経由で先着するケースは絶対にゼロではない
  3. proxy-port 変化時の再 spawn (S8) では既存 PID watcher を `removeMaster` で停止 → cmux.closeSurface → `spawnMasterPane` の順だが、close → 新 claude 起動 → SessionStart hook の発火タイミングが MASTER_REGISTERED より早まる可能性が高い
- **影響**: PID watcher が起動されないまま Master state が残ると、`spawnMasterPidWatcher` の生存検知ループが一切走らず、Master 死亡を検出できなくなる（status は disconnected に遷移しないまま固着）
- **推奨対処**: SESSION_STARTED handler の master 経路 (L1012-1029) に「`master` が undefined の場合は仮 entry を作成 (status=starting, startedAt=message.timestamp) してから pid 更新と watcher 起動を行う」フォールバックを追加するか、MASTER_REGISTERED handler 内で `pid` が optional 引数として渡されていれば `spawnMasterPidWatcher` を起動する経路を残す

### F2. [Major] `spawnMasterPane` の責務境界が S7 の記述だけからは確定しない

- **対象**: 計画 §4 S7
- **指摘内容**: S7 は `spawnAndRegisterMaster` を `spawnMasterPane(state, daemonSurface?)` に改名し「責務は pane を立てて `cmux send 'cmux-team spawn-master'` を送るだけ」と記載。しかし master.ts には既存の `spawnMaster` (L105-129) が export されていて、pane 作成 + cmux send + renameTab + ログを既に行っている。
- **判明していない設計判断**:
  - (a) `spawnMasterPane` は内部で `await spawnMaster(daemonSurface)` を呼ぶラッパーになるのか
  - (b) それとも master.ts:spawnMaster と同等の処理を daemon.ts 内に重複実装するのか
- **影響**: (b) を採用すると DRY 違反 + master.ts:spawnMaster がデッドコード化する。(a) の方が自然だが、その場合「spawnMasterPane の存在意義は何か」(daemonSurface 引数を受け取る薄いラッパー?) が plan に書かれていないため実装者が迷う
- **推奨対処**:
  - (推奨案): `spawnAndRegisterMaster` を**新設しない**。`startMaster` から直接 `await spawnMaster(daemonSurface)` を呼び、戻り値の `surface` のみ使う（startedAt は MASTER_REGISTERED 経路に委ねる）。そうすれば master.ts:spawnMaster の責務は変わらず、daemon.ts の責務減少だけで済む
  - もしくは S7 に「spawnMasterPane は内部で `await spawnMaster()` を呼び、daemon 側で master.ts への薄いラッパーとなる」を明記

### F3. [Major] S11 T6 テストで `cmux.closeSurface` のモック方針が欠如

- **対象**: 計画 §4 S11 T6、§5 テスト戦略
- **指摘内容**: T6 は「`state.proxyPortChanged = true` + 既存 Master 2 件 → `startMaster` 呼び出し → 2 件とも closeSurface」を unit test として要求しているが、`cmux.closeSurface` は実 cmux サーバへの IPC を伴う外部依存。既存テストでこのモック化方針が確立されていないなら、T6 は実装不能か手動 E2E に分類すべき
- **影響**: テスト実装に着手して詰まる、または通らないテストを書いてしまう
- **推奨対処**: 以下いずれかを S11 に追記
  - (a) bun:test の `mock.module()` で `cmux` モジュール全体を差し替え、`closeSurface` の呼び出し回数をスパイする（既存 T228 で同パターンが無いなら新規導入のリスクも書く）
  - (b) T6 を E2E に格下げし、unit test では「`startMaster` の proxy_port_changed 分岐内で `removeMaster` が呼ばれる」までを検証する縮退テストにする

### F4. [Minor] T2 テストでの保護対象フィールド明記が不足

- **対象**: 計画 §4 S11 T2
- **指摘内容**: 既存 `daemon.test.ts:1862-1901` の CONDUCTOR_REGISTERED T2 では `status / taskId / taskRunId / taskTitle / worktreePath / agents / pid` の 7 フィールドを破壊しないことを明示的に assertion している。Plan T2 は「status/pid/startedAt が破壊されない」だけ書かれており、Master 特有の `disconnectedAt / prompt` の保護検証が漏れている可能性がある
- **影響**: テスト不足。skip 経路で disconnectedAt 等が undefined に書き戻されても気付けない
- **推奨対処**: T2 の検証フィールドを `surface / pid / status / startedAt / disconnectedAt / prompt` の全 6 フィールド明示に拡張

### F5. [Minor] S7 のリネームに伴う既存テスト影響評価が plan に無い

- **対象**: 計画 §4 S7
- **指摘内容**: `daemon.test.ts:1619 startMaster restore (T229)` の describe ブロック内で `startMaster` 経由で `spawnAndRegisterMaster` を間接呼び出ししている可能性がある。S7 の改名で関数名が変わっても `startMaster` の呼び出し側コードを更新すれば外向き挙動は同じだが、テスト内で関数名を直接参照していたら fail する
- **影響**: 既存テストの修正漏れ
- **推奨対処**: S7 の検証コマンドに `cd skills/cmux-team/manager && bun test daemon.test.ts -t "startMaster restore" 2>&1 | tail -10` を追加し、リネーム後も既存 11 ケース (T229 で追加) が green であることを確認

### F6. [Minor] S9 の参照モデル (`help_spawn_conductor`) が想定と乖離

- **対象**: 計画 §4 S9
- **指摘内容**: Plan は「既存の `help_spawn_conductor` (L476 付近、T228 で更新済み) と同じトーンで」とあるが、現状 (worktree base) の `i18n.ts:191-198` の `help_spawn_conductor` は self-register / fail-fast / proxy-port 必須の記述を含まない極めて簡潔なテキスト。参照モデルとして不十分
- **影響**: 実装者が「同じトーン」を真似ても self-register の説明が薄くなる
- **推奨対処**: S9 に以下の文面例を直接書く
  ```
  Notes:
    - Registers itself with daemon via MASTER_REGISTERED before launching Claude Code
    - Fails with exit 1 if daemon is not running (.team/proxy-port unreachable)
    - Can be invoked from any pane to add a new Master to the running daemon
  ```

### F7. [Minor] D5 の MasterStateSchema 拡張に restoreMasters の挙動説明が無い

- **対象**: 計画 §4 S6, Decision D5
- **指摘内容**: `MasterStateSchema.status` enum に `"starting"` を追加する。daemon クラッシュ時に starting 状態の master state がファイルに永続化される可能性があるが、`restoreMasters` (daemon.ts:652-665) は status を `"idle"` にハードコード reset するため挙動上は問題ない（T228 Conductor も同パターン）。Plan に「starting で永続化された場合、次回 restore で idle に reset される」確認を 1 行追記すべき
- **影響**: 後続レビュアーが「starting で永続化されたら何が起きるか」を独立調査する手間が発生
- **推奨対処**: D5 の説明文に「`restoreMasters` が status をハードコード reset するため永続化された starting も safely idle 化される」を追記

### F8. [Minor] S12-1 (normalizeSurfaceForPath 二重定義) のスコープ判断が緩い

- **対象**: 計画 §4 S12-1
- **指摘内容**: `daemon.ts:104` と `master.ts:16` の同名関数の正規化ルールが**異なる**点 (`[^a-zA-Z0-9_-]` vs `:` のみ) に Plan は気付いており「保守的対応として別名にリネーム」と書いている。良い判断。ただし「影響範囲が読み切れない場合は後続タスクに切り出す」と曖昧に逃げ道が用意されている
- **影響**: 実装者が「読み切れない」と判断して常に後続タスク化してしまう可能性
- **推奨対処**: S12-1 を必須から外して S12-1 専用の後続タスクを Plan で明記する (例: 「T232: surface 正規化ロジック統合」)。または逆に S12-1 を「本タスクの最後に必ず実施」と必須化し、別名リネーム案を decision として確定

## Recommendations

実装着手前に **F1, F2, F3** の 3 件は plan を加筆修正してから着手することを強く推奨する。

- **F1 対処**: SESSION_STARTED handler の master 経路に仮 entry 作成 + watcher 起動のフォールバックを足す方針を S5 (または新サブタスク S5b) に明記
- **F2 対処**: `spawnAndRegisterMaster` を新設・改名せず単純削除し、`startMaster` 内で `await spawnMaster(daemonSurface)` を直接呼ぶ案を採用。S7 を「`spawnAndRegisterMaster` の単純削除 + `startMaster` の修正」に書き換える
- **F3 対処**: T6 テストのモック方針を S11 に明記。bun:test 既存パターンが無ければ手動 E2E に格下げ

F4-F8 は実装中の詰めで対応可能 (Minor)。

なお、**Critical findings 0 件 + CRITICAL チェック項目 5 つすべてパス** のため判定は **Approved**。Major findings は実装プロセスの中で確実に解消する前提での承認である。
