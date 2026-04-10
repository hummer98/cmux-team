# T119 Design Review

## Verdict

**Changes Requested**

## Summary

計画は非常に精度高くコードを読み込んでおり、行番号・関数名・既存パターン（`scanTasks` の `assign_failed` → `aborted + journal` 流用など）との整合性は概ね取れている。`schema.ts` に変更が不要である点・`monitorConductors` の export が必要な点・`resetConductor` の冪等性・`execFile` timeout 指定の既存パターンなど、現状把握は的確。

一方、**C-3 (SESSION_IDLE からの cleanup)** は `SESSION_IDLE` が発火する条件の認識に齟齬があり、そのまま実装すると「生存中の Conductor の worktree を削除してしまう」退行を招きうる重大リスクを抱えている（詳細は Critical 1 参照）。また `monitorConductors` 内で agent 数だけ `validateSurface` を叩くループに対するリトライコスト試算が計画では十分でなく、tick interval を超過する可能性がある（Major 1）。

これらの修正・設計再考が必要なため Changes Requested とする。Critical 1 は少なくとも「disconnected + taskRunId 復帰時は `running` に戻すだけで cleanup はしない」方向の設計変更が望ましい。

## Findings

### Critical

1. **C-3 の `SESSION_IDLE` 復帰 cleanup は生存中 Conductor の worktree を誤削除するリスクがある**
   - 該当箇所: plan.md §6.2 の SESSION_IDLE ハンドラ書き換え（`wasDisconnected && conductor.taskRunId → resetConductor`）、および §6.3 の根拠 "SESSION_IDLE はプロンプト入力待ち = タスク実行が終了した状態"
   - 問題:
     - `SESSION_IDLE` は Claude Code の **Stop hook** から発火する（`skills/cmux-team/manager/main.ts:727-735` の `Stop: [{ matcher: "", hooks: [{ command: 'cmux-team send SESSION_IDLE ...' }] }]`）。Stop hook は「タスク完了時」ではなく「アシスタントが応答を終えて入力待ちに戻るたび」、つまり**ターン境界ごと**に発火する
     - 現状の daemon のコメントも `conductor.disconnectedAt = undefined; // alive の証拠` (`daemon.ts:560`) と、SESSION_IDLE を「生存シグナル」として扱う設計になっている
     - したがって次のシナリオで worktree が破壊される:
       1. `monitorConductors` が cmux の一時的不調で `validateSurface` 連続失敗 → `disconnected` へ誤遷移（A 修正後も、KDG-lab 事例のような長時間不応答なら起きる）
       2. cmux が数秒で回復 → Conductor は実際にはタスクを継続中
       3. Conductor が次のターン境界（例: サブエージェント spawn 後の入力待ち）で `SESSION_IDLE` を emit
       4. 本計画の C-3 分岐が `resetConductor` を呼び、**実行中の worktree とブランチを削除**
       5. その後の `git add / commit / worktree remove` が軒並み失敗し、タスクが壊れる
     - 現状の「`disconnected → idle` に戻すだけ（taskRunId 残存）」は T119 の根本バグだが、少なくとも worktree は破壊しない。本計画はバグの修正と引き換えに、より深刻な退行を招く可能性がある
   - 修正案（推奨）: C-3 を **resetConductor を呼ばない** 形に設計し直す。`disconnected` + `taskRunId` 復帰時は `idle` ではなく **`running`** に戻すだけにし、実 cleanup は C-1（CONDUCTOR_DONE による late cleanup）または C-2（disconnect timeout）に委ねる。具体例:
     ```ts
     case "SESSION_IDLE": {
       // master branch 省略
       const conductor = findConductor(state, message.surface);
       if (conductor) {
         conductor.disconnectedAt = undefined;
         if (message.pid) conductor.pid = message.pid;
         if (conductor.status === "disconnected") {
           if (conductor.taskRunId) {
             // タスク実行中だった Conductor が復活 → running に戻す
             // cleanup は CONDUCTOR_DONE (C-1) か disconnect_timeout (C-2) が担う
             conductor.status = "running";
             await log(
               "conductor_recovered",
               `surface=${message.surface} via=SESSION_IDLE new_status=running taskRunId=${conductor.taskRunId}`
             );
           } else {
             conductor.status = "idle";
             await log("conductor_recovered", `surface=${message.surface} via=SESSION_IDLE`);
           }
         } else if (conductor.status === "starting") {
           conductor.status = "idle";
           await log("conductor_ready", `surface=${message.surface} via=SESSION_IDLE`);
         }
         await log("session_idle", `surface=${message.surface}`);
       }
       break;
     }
     ```
     これにより
     - 本当に死んでいる Conductor: SESSION_IDLE が来ないので C-2 timeout → forced cleanup が動く（T119 のバグ再発防止）
     - 生存中の Conductor: `running` に戻るだけで worktree は保全、CONDUCTOR_DONE で最終 cleanup
   - もし「タスク進捗中でも SESSION_IDLE 時に必ず cleanup する」というタスク指示を厳守したいなら、少なくとも **task-state.json 側で当該 taskId が既に `closed`/`aborted` のときのみ cleanup** という防護を入れる必要がある。ただしその場合、T119 の元バグ（`closed` 後の team.json 残存）は直るが、本質的に C-2 の timeout でも十分な cleanup ができるため、resetConductor 自体を SESSION_IDLE 経路に入れる意義は薄い
   - 合わせて plan §6.3 の前提（"SESSION_IDLE はタスク実行が終了した状態"）の記述を訂正し、"Stop hook はターン境界ごとに発火するため SESSION_IDLE だけでは完了判断できない" と明記する必要がある

### Major

1. **`monitorConductors` の agent 検証ループで validateSurface リトライがコスト肥大**
   - 該当箇所: plan.md §2.4, §10 の遅延見積もり（"最大 1.4s"）および既存 `daemon.ts:807-818` の agent 生存チェックループ
   - 問題:
     - `monitorConductors` は各 Conductor の各 Agent について `cmux.validateSurface(agent.surface, ...)` を呼ぶ (`daemon.ts:811`)
     - Agent は頻繁に spawn/close されるため「surface が実際に存在しない」ケースが正常系として発生する
     - 本計画のリトライ設計では「tree 成功だが surface が含まれない」場合でも最後まで 3 回リトライするため、1 回の missing agent チェックが **最低 200+400+800 = 1.4s + tree 3 回分の execFile オーバーヘッド** を必ず消費する
     - 最悪ケース: 3 Conductor × 3 Agent が同時終了するような状況で `9 × (1.4s + 3 * tree)` = tick interval 10s を超過する恐れ
     - 計画 §10 には「1.4s 程度なので許容範囲」とあるが、これは単発の validateSurface に対する試算で、agent ループの積算を考慮していない
   - 修正案:
     1. **tree() 結果を tick 単位でキャッシュ**: `monitorConductors` の冒頭で一度だけ `tree(workspace)` を呼び、その結果を `validateSurfaceFromTree(surface, treeOutput)` のような純粋関数で突き合わせる。Agent 検証は 1 tick 1 回の tree 呼び出しで済み、リトライは「tree() 自体が失敗したとき」にだけ発火する
     2. **tree-success-but-missing ではリトライしない**: Finding Major-2 と関連。リトライ対象を「tree() 例外のみ」に限定する
     3. **validateSurface にオプション引数 `{ retry?: boolean }` を追加**し、Conductor surface 検証（誤 disconnect のコスト大）は retry あり、Agent surface 検証（missing が正常系）は retry なしで呼び分ける
   - どの案でも構わないが、少なくとも §7.2.2 のテスト 1（running→disconnected）と合わせて「Agent ループで 3s 以上無駄に消費しないこと」を計画に明記してほしい

2. **リトライを「tree 成功 + surface 未検出」にも適用する設計は副作用が大きい**
   - 該当箇所: plan.md §2.3 の `validateSurface` ループ実装、および §7.2.1 のテスト "tree 成功だが surface が含まれなくてもリトライする"
   - 問題:
     - 本タスクの主眼は「tree() 自体がタイムアウト / 一過性 I/O エラーで落ちたときに誤 crash 判定しない」こと。"cmux の描画 race で tree 成功だが surface 未載" はそれとは別の仮説で、発生実績・再現手順が明示されていない
     - この拡張を入れると、**surface が正当に消えている場合** (agent 終了直後、Conductor 停止直後、initializeLayout 起動時の不在チェックなど) にまで 1.4s+ の遅延が載る
     - 呼び出し元の挙動が「missing を素早く確定させたい」ものの方が多いため、退行方向
   - 修正案: `validateSurface` のリトライは **tree() の例外のみ** に限定する。以下のように書き直す:
     ```ts
     export async function validateSurface(surface: string, workspace?: string): Promise<boolean> {
       for (let attempt = 0; attempt < VALIDATE_SURFACE_RETRY_COUNT; attempt++) {
         try {
           const output = await tree(workspace);
           return output.includes(surface); // 成功したら retry せず結果を返す
         } catch (e: any) {
           if (attempt === VALIDATE_SURFACE_RETRY_COUNT - 1) {
             await log("validate_surface_failed", `surface=${surface} attempts=${attempt + 1} last_error=${e.message}`);
             return false;
           }
           await sleep(VALIDATE_SURFACE_BACKOFF_MS[attempt] ?? 800);
         }
       }
       return false;
     }
     ```
   - もし「cmux 描画 race」が実際に観測されているなら、具体的再現手順を計画に追記した上で残す選択肢もある。現状は根拠薄い

3. **`forceCloseDisconnectedConductor` の task-state.json 直更新と §5.4/§5.5 の不整合**
   - 該当箇所: plan.md §5.4 のコード例 `const { loadTaskState, saveTaskState } = await import("./task");` と §5.5 "top-level import を使うだけで済む"
   - 問題:
     - §5.4 のサンプルコードは動的 import を使っているが、§5.5 で「既に top-level import 済みなので動的 import は不要」と訂正している。実装者はどちらに従えばよいのか混乱する
     - 実際 `daemon.ts:18` で `loadTaskState, saveTaskState` は既にトップレベル import 済み → 動的 import は不要
   - 修正案: §5.4 のコード例を top-level import 版に書き換える:
     ```ts
     async function forceCloseDisconnectedConductor(
       state: DaemonState,
       conductor: ConductorState
     ): Promise<void> {
       const taskId = conductor.taskId;
       const taskRunId = conductor.taskRunId;
       if (taskId) {
         try {
           const ts = await loadTaskState(state.projectRoot);
           // ...
           await saveTaskState(state.projectRoot, ts);
           // ...
         } catch (e: any) {
           await log("error", `forceCloseDisconnectedConductor task-state update failed: ...`);
         }
       }
       await resetConductor(conductor, state.projectRoot);
     }
     ```

4. **§3.3 と §5.3/§9 Step 6 の "continue 条件" 指示が表面上矛盾している**
   - 該当箇所: plan.md §3.3 "`if (conductor.status === "idle" || conductor.status === "disconnected") continue;` は **そのまま** 残す" / §5.3 "分岐を分離して `if (disconnected) { ... continue; } if (idle) continue;` にする" / §9 Step 6 "`idle` のみに変更"
   - 問題: B 単独の節では「そのまま残す」と書きつつ、C-2 統合後には「`idle` のみに変更」と書いてあり、実装者が B と C-2 を時系列で実装していく過程で指示に揺れが出る
   - 修正案: §3.3 の文言を「B 単独時点では据え置くが C-2 で `if (disconnected) { 時限チェック; continue; } if (idle) continue;` に分解する。実装順序は §9 Step 4 → Step 6 の流れに従うこと」と明示。最終的な monitorConductors の擬似コード（§5.3）を "完成形" として一箇所に集約してほしい

### Minor

1. **`conductor_disconnected` ログの `kind=` 識別子が既存フォーマットと揃っていない**
   - 該当箇所: plan.md §3.2 の `conductor_disconnected ... reason=validate_surface_failed` / 既存 `daemon.ts:682` の `conductor_disconnected ... reason=assign_failed kind=conductor`
   - 問題: 既存の assignTask エラー経路は `reason=... kind=conductor` の形で出しているが、本計画は `kind=` フィールドを付けない。ログ解析する際の一貫性が崩れる
   - 修正案: `conductor_disconnected ... reason=validate_surface_failed kind=crashed` のように `kind=crashed`（または `kind=monitor`）を付与する

2. **`conductor_done_ignored` の `reason` 表記が既存フォーマットからの非互換変更**
   - 該当箇所: plan.md §4.2 "旧 `reason=not_running` ログは廃止"
   - 問題: 現行運用で `reason=not_running` を拾っているログモニタや grep が壊れる可能性
   - 修正案: 影響は小さい（内部ログのみ）と思われるが、CHANGELOG や リリースノートに明記する項目として PR 記述に入れる

3. **`disconnectedAt` が `resetConductor` でクリアされない**
   - 該当箇所: `conductor.ts:448-456` の `resetConductor` 末尾 / plan.md §5.4 の forced close 後
   - 問題: forced close 後に `status = idle` だが `disconnectedAt` だけ古い値が残る。Dashboard は `isDisconnected` で分岐しているため表示上は問題ないが、将来 `disconnectedAt` を別用途で参照するコードが入ったときに罠になる
   - 修正案: `resetConductor` の 4. ConductorState リセットブロックに `conductor.disconnectedAt = undefined;` を 1 行追加する。もしくは `forceCloseDisconnectedConductor` 内で `resetConductor` の直後に明示的にクリア

4. **`pidWatcherInterval` に関する考慮が計画から欠落**
   - 該当箇所: `schema.ts:129` の `pidWatcherInterval` / `daemon.ts` 内のどこか
   - 問題: `disconnected` に遷移する際、`spawnPidWatcher` で起動した `pidWatcherInterval` が生きたままかどうか、`forceCloseDisconnectedConductor` でクリアする必要があるかが計画未言及
   - 修正案: 既存の `SESSION_ENDED` 経路 (`daemon.ts:481-523`) や `resetConductor` が `pidWatcherInterval` をどう扱っているか確認し、必要なら `forceCloseDisconnectedConductor` で clearInterval する

5. **`DISCONNECT_TIMEOUT_SEC = 300` を固定値にする是非**
   - 該当箇所: plan.md §5.2
   - 問題: 5 分は保守的な値だが、プロジェクトによっては「生存中だが応答が重い」ケースがあるかもしれない
   - 修正案: 既存 `CMUX_TEAM_POLL_INTERVAL` と同じく `CMUX_TEAM_DISCONNECT_TIMEOUT_SEC` 環境変数で上書き可能にする（optional）。実装段階でも追加可能な軽微項目

6. **テスト "1. running → disconnected" の PATH fake setup が計画で未記述**
   - 該当箇所: plan.md §7.2.2 のテスト 1 と §7.4 "PATH 差し替えで E2E 検証"
   - 問題: §7.4 で方針は示されているが、§7.2.2 のコード例にはその `beforeEach` での PATH 書き換え・fake `cmux` 書き出しが記述されていない。実装者が見落とす恐れ
   - 修正案: テスト 1 のコードブロックに `// beforeEach で PATH に fake cmux を置く必要あり` コメントを追加し、§7.2.1 と同じ PATH 差し替えヘルパーを流用する旨を明記

7. **テスト 2 の `worktreePath` が存在しない前提での `resetConductor` 実行が暗黙**
   - 該当箇所: plan.md §7.2.2 test "2. disconnected + CONDUCTOR_DONE で late cleanup"
   - 問題: `worktreePath: join(testDir, ".worktrees/task-010-nothing")` と存在しないパスを与えているが、`resetConductor` 内の `existsSync` ガードで worktree remove はスキップされる。テスト意図として正しいが、コメントがないと「なぜエラーにならないのか」が分かりにくい
   - 修正案: "`worktreePath` は存在しないパス — `resetConductor` の existsSync ガードで冪等に skip されることも同時に検証" とコメント追加

8. **`initializeLayout` (`daemon.ts:289`) への新リトライ影響の評価不足**
   - 該当箇所: plan.md §2.4 の呼び出し元一覧
   - 問題: 起動時の `initializeLayout` は team.json 復元時に **不在である可能性が高い** surface を検証する（前回セッションで消えた Conductor など）。ここで全 surface が 1.4s ずつ遅延するのはスタートアップ体感に響く
   - 修正案: Major 2 の修正（tree 成功時は即 return）と合わせれば解決される。もしくは initializeLayout だけは retry 回数を 1 に落とすか、tree 成功時即 return の設計にする

9. **`conductor_disconnect_timeout` ログ出力の検証テストがない**
   - 該当箇所: plan.md §7.2.2 テスト 3. "disconnect timeout で forced close + journal + aborted"
   - 問題: 状態遷移と task-state の期待値は検証しているが、`conductor_disconnect_timeout` ログが実際に出ることは未検証。log 関数が text ベースなので assertion はしづらいが、`.team/logs/manager.log` を読む等の方法はある
   - 修正案: `readFile(".team/logs/manager.log", "utf-8")` で内容を読み、期待する event 名が含まれていることを `toContain` で検証する軽微な追加で OK。最低限 `conductor_disconnect_timeout` のみでよい

## Recommendations

計画を以下の点で改訂した上で再提出してください。Critical 1 は本タスクの成否に直結するため必須。

1. **C-3 SESSION_IDLE ハンドラの設計を改める**: `disconnected + taskRunId` 復帰時は `resetConductor` を呼ばず、`status = "running"` に戻すだけにする。実際の cleanup は C-1 (CONDUCTOR_DONE late cleanup) および C-2 (disconnect_timeout) が担う。§6.2/§6.3 の根拠文・コード・§7.2.2 のテスト 4 を全て書き換える。テスト 4 は「cleanup が走らず `status = running` に復帰し `taskRunId` が保持される」ことを検証する形に変更する
2. **`validateSurface` のリトライは tree() 例外時のみ**: §2.3 のループから「tree 成功時のループ継続」を外し、tree 成功したら即 `output.includes(surface)` の結果を return する。§7.2.1 のテスト "tree 成功だが surface が含まれなくてもリトライする" を削除または反転（リトライしないことを検証）する
3. **`monitorConductors` の agent ループでのリトライ負荷を軽減**: tree() を 1 tick で 1 回だけ呼んでキャッシュする方針、または Agent 検証専用の retry 無し版 validateSurface を用意する方針を §2 あるいは §5.3 に追記する
4. **§5.4 のコード例を top-level import 版に書き換える**（§5.5 との矛盾解消）
5. **§3.3 と §5.3/§9 Step 6 の矛盾を解消**: 最終形の monitorConductors 擬似コードを一箇所に集約し、§3.3 は「最終形は §5.3 を参照」と明示する
6. **ログイベント名に `kind=` を付けて既存フォーマットと揃える**: `conductor_disconnected ... kind=crashed`
7. **`resetConductor` で `disconnectedAt` もクリアする**: 1 行追加
8. **`pidWatcherInterval` の扱いを forced close で明示**: `forceCloseDisconnectedConductor` 内または `resetConductor` 内で必要な clearInterval を追加
9. **テスト 1 の PATH fake セットアップを §7.2.2 のコードブロック内に明示**
10. **`conductor_disconnect_timeout` ログ出力のテストを追加**（軽量）

## Approved Aspects

- **現状把握が精密**: `schema.ts` に `disconnectedAt` と `"disconnected"` status が既に存在することの確認、`resetConductor` の冪等性、`conductor.ts:465-475` の `checkConductorStatus` 3 値戻り値など、行番号を実コードと照合している
- **既存パターンへの準拠**: `forceCloseDisconnectedConductor` の `aborted + journal` による task-state.json 直更新は、`scanTasks` の assign_failed 経路 (`daemon.ts:662-675`) と同一のパターンを採用しており、conventions 面で一貫している。CLI 経由ではなく直更新を選んだ理由も §5.4 で明示
- **`schema.ts` の不変宣言**: "schema.ts の変更は **不要**" と明記したことで、実装者が不要なスキーマ修正をすることを防げる
- **`monitorConductors` の export 必要性を事前に発見**（§7.3）
- **実装順序の依存関係考慮**（§9）: Step 2 → 3 (テスト) → 4...  の順で進められるよう正しく整理されている
- **非スコープの明示**（§11）: `SESSION_ACTIVE` / `SESSION_CLEAR` / `SESSION_STARTED` を対象外と明記し、スコープが膨らむのを防いでいる
- **タスクの CLAUDE.md フィードバック尊重**（§5.4 "reopen しない"）: "異常検知時のリカバリーは人間に委ねる" という feedback memory と整合
- **落とし穴の予見**（§10）: `disconnect_timeout` が startup 直後に発火しないよう `disconnectedAt` ガードで防ぐなど、計画段階でリスクを列挙できている
- **`cmux.ts` の `readScreen` timeout パターンを既存実装から引用**（§1.1）: 新規パターンではなく既存パターンの踏襲
- **テストフレームワーク特定**（§1.6）: "bun:test、モジュールモック不使用、PATH 差し替え方式が既存流儀" と正しく分析
