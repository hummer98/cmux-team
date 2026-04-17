# Design Review: T195 (リビジョン 2)

## Verdict

**Approved**

## Summary

リビジョン 2 は初回レビューで指摘した Blocking 3 件を全て解消し、Non-blocking 7 件も全て plan に反映されている。とくに焦点だった `isMasterAlive` / `startMaster` 周りは、事実誤認の訂正に留まらず §3 D3.1 という独立セクションを新設して Master resume 経路のライフサイクル（マーカー読み → `isMasterAlive(projectRoot)` → `spawnMasterPidWatcher` 起動 or フォールバック）を 1 箇所に集約しており、実装時の判断コストが大きく下がる形になっている。SESSION_CLEAR の 3 分岐構造も実コードを正しく踏まえた diff に書き直され、`spawnAgentPidWatcher` の冪等性・send-agent pid 未反映ウィンドウのリトライ・`$PPID` fallback 代替コマンド・テスト戦略の named export 統一・CHANGELOG Breaking の PID 再利用リスク追記・conductor テンプレート行番号の合わせ込みまで、指摘事項が漏れなく消化されている。実装フェーズに移行して問題ない。

## Strengths

- **§1 と改訂履歴が並び、何が変わったか一目でわかる**: rev 2 セクション冒頭に 8 点の変更点が箇条書きされており、前稿との差分を追いやすい
- **§2.1 master.ts 欄の訂正が徹底している**: 単に「dead code ではない」と書くだけでなく、「前稿の『grep で呼び出し元 0 件』は事実誤認」「Manager 再起動時の現状リグレッション（`state.masterPid` 未復元 → `spawnMasterPidWatcher` 未起動）」まで掘り下げており、Blocking 2 の動機付けが明確
- **§3 D3.1 「Master resume 経路の PID 化」を独立セクションとして切り出した**: フロー 5 ステップ、ライフサイクル（`initializeLayout` は Master を扱わない、`startMaster` 内部で watcher 起動する責務分離）、フォールバックコスト（1-2 秒）まで書かれている。実装者がここだけ読めば迷わない構造
- **§3 D1 表に `daemon.ts:466` 行が追加され、前稿で抜け漏れだった**「前稿抜け漏れ」**マーク付きで明示**されている。網羅性が視覚的に担保された
- **§4 Step 3 が pid ベース書き換えの diff（before/after）を具体的に提示**しており、`isMasterAlive(projectRoot)` の新シグネチャ + `readTeamJson` 再利用の判断基準まで書かれている
- **§4 Step 6 の SESSION_CLEAR diff が実ハンドラの 3 分岐構造に沿った形に書き直されている**: `disconnected/starting → idle` 分岐で `L1031 if (message.pid) conductor.pid = message.pid` を削除、`running → reset` 分岐で `clearInterval` 直後に `conductor.pid = undefined` を明示追加、という 2 点の変更位置が明確
- **§4 Step 5 の `spawnAgentPidWatcher` コード例に `findIndex === -1 なら no-op + agent_pid_watcher_noop ログ`** が明示的に組み込まれている。SESSION_ENDED 側の冪等性も「既存コードが自然に no-op になる」旨の補記がある
- **§2.2 Q1 に `$PPID` fallback 代替コマンドが 3 種類列挙されている**（`pgrep -P $PPID -x claude` / `ps -p $PPID -o ppid=` / `ps -eo pid,comm | awk`）。実装者が実機確認で狂いを見つけた場合に即座に切り替え可能
- **§5.2 テスト戦略が `__testSpawnPidWatcherTick` + `__setIsAliveImpl` 方式に一本化された**: 「real timer + `sleep(1100)` 方式は採用しない（CI 時間増 + flaky リスク）」と明記され、両論併記が解消されている。before/after コードブロックまで示されている
- **§7 CHANGELOG Breaking に PID 再利用リスク + `isMasterAlive` シグネチャ変更** の 2 項目が追加された。とくに前者は「`cmux-team stop` 後即座に `start` せず新規 Claude セッションを spawn し直すこと」という具体的な回避策まで書かれており、ユーザー向け告知として十分
- **§6 conductor テンプレート行番号がタスク指示（L125-148 / L177-179）に合わせ込まれた** うえで、「行番号ではなく Markdown の見出し/前後のブロックをアンカーとしてセクション単位で置換する」という実装方針が補記されている。将来の行番号ズレに対する保険
- **§9 完了条件チェックリスト** に「`isMasterAlive` の結果が `master.ts` 定義 + `daemon.ts:startMaster` 呼び出しの 2 行のみ」「`master.ts` に `cmux.isAlive` / `readTeamJson` が出現」「`master_restored ... pid=<N>` ログが出る」という D3.1 の機械検証条件が追加されている

## Issues

### Blocking

なし。初回レビューの Blocking 3 件は全て解消された。

### Non-blocking（改善提案）

リビジョン 2 で初回の Non-blocking 7 件は全て反映済みだが、実装フェーズで注意すべき細かい論点を 2 件だけ追記する。Approved 判定には影響しない。

1. **`readTeamJson` ヘルパーの存在確認**
   - §4 Step 3 で「`readTeamJson` が既存ヘルパー名でない場合、`updateTeamJson` 周辺の read 関数を再利用 or 小さな read 関数を追加」と書かれているが、実装者が最初に `rg "readTeamJson|readFileSync.*team\.json" skills/cmux-team/manager` で確認してから進める運用を推奨する
   - 存在しない場合は `master.ts` 内にインライン実装（5 行程度の `JSON.parse(await fs.readFile(...))` + try/catch）で十分。追加ヘルパーを新設する必要はない
   - plan 本文の記述自体は実装時判断に委ねる形で正しく、変更不要

2. **`startMaster` → `spawnMasterPidWatcher` 呼び出しタイミングの副作用**
   - §3 D3.1 で「`startMaster` 内部で Master 復旧時の `spawnMasterPidWatcher` を起動する」と決めているが、`startMaster` は `initializeLayout` の後に呼ばれる（§4 Step 7 末尾の「起動順は `initializeLayout` → `startMaster`」参照）
   - 実装時、`initializeLayout` 内で Conductor 側の `spawnPidWatcher` を起動するタイミングと、`startMaster` 内で `spawnMasterPidWatcher` を起動するタイミングの間に Master surface が死んでいた場合の race（極稀）が発生し得るが、死亡時は `spawnMasterPidWatcher` が 1 秒以内に検知するため実害なし
   - plan 本文に追記する必要はないが、実装レビュー時に「`startMaster` 内で watcher を起動する順序」を再確認すると見落としが減る

## Recommendations

なし。実装ステップを順に進めてよい。強いて挙げれば:

- 実装は §4 Step 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 の順で小さくコミット（plan 記述通り）
- Step 3 完了時点で一度 `bun tsc --noEmit` を走らせ、`startMaster` / `master.ts` 周辺のシグネチャ変更がコンパイル整合していることを確認してから Step 4 に進む
- Step 5 で Agent SessionStart hook を仮組みしたら、実装ステップ内の手動確認（1 Agent 起動 → `.team/logs/manager.log` の `session_started A[NNN] pid=XXXXX` を確認 → `ps -p XXXXX` で claude プロセス確認）を早めに消化し、狂いがあれば §2.2 Q1 の代替コマンドに差し替える
- Step 7 の `initializeLayout` 改修後は、Manager 再起動シナリオ（§9 の `master_restored ... pid=<N>` ログ確認）を手動 smoke テストで必ず 1 回通す

## Verified Coverage

### Blocking 3 件の解消確認

1. **`isMasterAlive` dead code 誤認の訂正**
   - §2.1 master.ts 欄（L74）で「**呼び出し元は `daemon.ts:466` `startMaster()`**」+ 「**dead code ではない**（前稿の『grep で呼び出し元 0 件』は事実誤認）」+ 「本タスクで pid ベース実装に書き換える（削除ではない）」と明記 **✓**
   - §3 D1 表（L166）で `master.ts:49-51 isMasterAlive 本体` 行が「**pid ベース実装に書き換え**（削除ではない）」に訂正 **✓**
   - §4 Step 3（L350）で「`isMasterAlive` の **シグネチャを変更**し pid ベース実装に書き換え（**削除しない**）。現状 `daemon.ts:466 startMaster()` から呼ばれているため削除するとコンパイル不能になる」と明記、before/after コード例付き **✓**

2. **`startMaster` Master resume 経路の PID 化設計**
   - §3 D3.1 新設（L201-226）で 5 ステップのフローが記載 **✓**
   - マーカー surface 復元後に team.json から `master.pid` を読み `isAlive(pid)` する設計 **✓**
   - `spawnMasterPidWatcher(state, state.masterPid)` を **`startMaster` 内部で起動する** 責務分離が明記（L214, L223） **✓**
   - pid 無し時のフォールバック（マーカー削除 → 新規 `spawnMaster`）が明記（L209, L216） **✓**
   - `initializeLayout` は Master を扱わない責務分離が §4 Step 7 末尾（L653）で再掲 **✓**

3. **`validateSurface` 呼び出し元網羅表への `daemon.ts:466` 追加**
   - §3 D1 表 1 行目（L160）に `daemon.ts:466 startMaster（isMasterAlive 経由、**前稿抜け漏れ**）` 行が追加 **✓**

### Non-blocking 7 件の反映確認

1. **SESSION_CLEAR 実ハンドラ構造（3 分岐）に即した Step 6 diff** — §2.2 Q2 で 3 分岐（`disconnected/starting → idle` / `running → reset` / その他）を明記（L115-131）、§4 Step 6 で分岐を保った diff に書き直し（L533-580） **✓**
2. **`spawnAgentPidWatcher` 冪等性ノート** — §4 Step 5 の `spawnAgentPidWatcher` コード例（L501-509）に `findIndex === -1 なら no-op で return + agent_pid_watcher_noop ログ` が明示。SESSION_ENDED 側は既存コードが自然に no-op の旨も L531 で補記 **✓**
3. **send-agent pid 未反映ウィンドウのリスク表追記** — §8 リスク表（L897）に「cmux-team send-agent 呼び出し時に team.json の agents[].pid が未反映」行が追加、軽減策として 200ms × 3 リトライ（合計 600ms）が記載。§4 Step 8（L660-685）に実装差分イメージあり **✓**
4. **Agent `$PPID` 実機確認フォールバック** — §2.2 Q1（L105-111）に `pgrep -P $PPID -x claude` / `ps -p $PPID -o ppid=` / `ps -eo pid,comm | awk` の 3 種類が列挙、§8 リスク表（L895）からも参照されている **✓**
5. **テスト戦略の `__setIsAliveImpl` + named export 統一** — §5.2（L753-786）で `__testSpawnPidWatcherTick` + `__setIsAliveImpl` 方式に一本化、「real timer + `sleep(1100)` 方式は採用しない（CI 時間増 + flaky リスク）」と明記、before/after コードブロック付き **✓**
6. **CHANGELOG Breaking 項目の PID 再利用リスク追記** — §7（L881）に「Manager 再起動直後は team.json 復元時の PID が OS 側で再利用されるリスクあり（T195、既知の限界）」項目が新規追加、回避策（`cmux-team stop` 後即座に `start` せず新規 spawn）まで記載。同じく L880 で `master.ts isMasterAlive` シグネチャ変更の Breaking 項目も追加 **✓**
7. **conductor テンプレート行番号ズレの解消** — §6（L853-858）で L125-148 / L177-179 に合わせ込み、「行番号ではなく Markdown の見出し/前後のブロックをアンカーとしてセクション単位で置換」という実装方針の補記付き **✓**

### タスク A（実装変更）網羅再確認

- daemon.ts:1307-1325 monitorConductors 縮減: **✓**（§4 Step 4）
- cmux.ts validateSurface 系の撤去: **✓**（§4 Step 2）
- cmux.ts getPaneForSurface 残置: **✓**（§4 Step 2、§1 L37）
- schema ConductorState.pid（既存）+ AgentState.pid 追加: **✓**（§4 Step 1）
- SESSION_STARTED で pid 保存（Conductor 既存 + Agent ケース追加）: **✓**（§4 Step 5）
- validateSurface 全呼び出し元:
  - daemon.ts:466（startMaster → isMasterAlive 経由）**✓**（D3.1 で pid ベースに書き換え）
  - daemon.ts:525 initializeLayout **✓**（§4 Step 7）
  - main.ts:1488 spawn-agent **✓**（§4 Step 8、削除）
  - main.ts:1781 send-agent **✓**（§4 Step 8、pid リトライに置換）
  - master.ts:22 spawnMaster **✓**（§4 Step 3、削除）
  - master.ts:49-51 `isMasterAlive` 本体 **✓**（§4 Step 3、pid ベースに書き換え）
  - conductor.ts:575 checkConductorStatus **✓**（§4 Step 3、dead code として削除）
- T180 UNRESPONSIVE_MAX_TICKS 撤去: **✓**（§3 D5 + §4 Step 4）

### タスク B（docs 同期）網羅再確認

- CLAUDE.md（L435, L498, L519, L520, L572, L577）: **✓**
- skills/cmux-team/SKILL.md（L60, L61, L167）: **✓**
- docs/spec/01-skill-cmux-team.md（L46, L47, L131, L138）: **✓**
- docs/spec/04-templates.md（L78）: **✓**
- skills/cmux-team/templates/ja/conductor.md（L67, L115, L125-148, L177-179）: **✓**（行番号合わせ込み済み）
- skills/cmux-team/templates/en/conductor.md: **✓**
- .team/specs/requirements.md（L69）: **✓**

### タスク C（CHANGELOG）

- `[3.47.0]` Changed (Breaking) 4 項目（tree/list-status 撤廃、Agent SessionStart hook、`isMasterAlive` シグネチャ変更、PID 再利用リスク + 削除ログイベント）: **✓**
- Changed 2 項目（conductor テンプレート、docs 同期）: **✓**

### 完了条件チェックリスト

- §9（L907-923）で機械チェック可能な grep 条件 + 手動 smoke テスト条件が列挙されている。Blocking 2 起因の `master_restored ... pid=<N>` ログ確認も追加済み **✓**
