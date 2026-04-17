# T195 Plan — PID ベース監視への移行計画

作業ディレクトリ: `/Users/yamamoto/git/cmux-team/.worktrees/task-195-1776202229`
対象リリース: v3.47.0（予定）
関連 artifact: A011（`cmux list-status` が `tree` と同じ deadlock 経路を通る）

## 改訂履歴

- **rev 2** (本稿): design-review.md の Changes Requested を受けて改訂。主な変更点:
  - `isMasterAlive` が dead code ではない事実を反映（`daemon.ts:466 startMaster()` から呼ばれている）。§2.1 / §3 D1 / §4 Step 3 を全面修正
  - `startMaster` の Master resume 経路を PID 化（§3 D3.1 を新設、§4 Step 3 / Step 7 を拡張）
  - §3 D1 表に `daemon.ts:466` 行を追加
  - SESSION_CLEAR ハンドラの既存 3 分岐構造を反映した diff に書き直し（§2.2 Q2 / §4 Step 6）
  - spawnAgentPidWatcher に冪等性チェックを追加（§4 Step 5）
  - send-agent の pid 未反映ウィンドウに 200ms × 3 リトライを追加（§4 Step 8 / §8 リスク）
  - §2.2 Q1 に `$PPID` fallback 代替コマンドを列挙
  - §5 テスト戦略を named export + `__testSpawnPidWatcherTick` に統一（real timer fallback 削除）
  - §7 CHANGELOG Breaking に PID 再利用リスク + `isMasterAlive` シグネチャ変更を追加
  - §6 templates 行番号をタスク指示に合わせて L125-148 / L177-179 に修正
- **rev 1**: 初稿

---

## 1. 目的・背景

`cmux tree` / `cmux list-status` / `cmux read-screen` はすべて cmux サーバ側で `DispatchQueue.main.sync` を経由する（A011 参照）。SwiftUI main thread が `LazyVStack` 等のレイアウトループで占有されると、cmux 側 CLI が永久ハングし、我々の Manager daemon は `monitorConductors` の tick ごとに数秒〜無限に待たされる。PR #2601 (v0.63.2) は mutation 系のみ `.async` 化し、read 系 (`list-status` / `system.tree`) は未修正で、当面 upstream 修正は期待できない。

一方、cmux-team では以下の状況により **tree / list-status に依存する必要はすでに無い**:

- 全 spawn 経路で `CMUX_CLAUDE_HOOKS_DISABLED=1` が設定されており、`cmux list-status` が返す `claude_code=` 値は cmux-team の Conductor 状態を反映しない
- Conductor / Master の生死は独自 hook（`SESSION_STARTED` / `SESSION_IDLE` / `SESSION_CLEAR` / `SESSION_ENDED`）で push 型に追跡済み
- `spawnPidWatcher` / `spawnMasterPidWatcher` が既に稼働しており、`process.kill(pid, 0)` を 1 秒間隔で呼んで disconnected 昇格している
- Agent の完了は `cmux-team await-agent` + done マーカー fs.watch で検知するプロトコルが既に完成している（T181）

つまり **`monitorConductors` の tree 依存と、新規 surface 作成直後の `validateSurface` 呼び出しは、`spawnPidWatcher` + SESSION_* hook に対する二重の保険** になっており、deadlock の唯一のリスク源となっている。本タスクでこれを撤廃する。

`getPaneForSurface` (`cmux.ts:148`) と `getPaneIdForSurface` (`conductor.ts:51`) の 2 箇所だけは、Agent タブを既存 Conductor pane に new-surface する際の pane 逆引き用途で、init 時の低頻度呼び出しのため `cmux tree` を残す。この 1 箇所ずつだけが、実装変更後に残る唯一の tree 呼び出し経路となる。

---

## 2. 調査結果

### 2.1 現状の実装（実機確認不要・コードで確定）

#### `schema.ts`

- `ConductorState.pid: z.number().optional()` は **既に存在**（L163）。プロンプトの「pid フィールド無し → 追加」は古い記述
- `ConductorState.treeFailureCount` / `treeFailureFirstAt` が T180 で追加されている（L170-171）→ 本タスクで削除対象
- `ConductorState.pidWatcherInterval` は実行時フィールドとして既に存在（L180）
- `AgentState` は `surface / role / taskTitle / spawnedAt / sessionId` のみで **pid なし**（L145）→ 本タスクで pid 追加

#### `daemon.ts`

- `SESSION_STARTED` ハンドラ (L705-740) で **Master / Conductor の pid 保存・spawnPidWatcher 呼び出しは既に動いている**。Agent の case は未実装
- `spawnPidWatcher` (L1220-1254) は `process.kill(pid, 0)` を 1 秒間隔で呼び、失敗時に `conductor.status = "disconnected"` を設定 + SESSION_ENDED をログ
- `spawnMasterPidWatcher` (L1256-1284) は Master 用
- `monitorConductors` (L1307-1463) は tick 冒頭で `cmux.tree()` を 1 回呼んでキャッシュし、`surfaceAlive(surface)` で `treeOutput.includes(surface)` により alive 判定している。これが **tree 依存の主経路**
- `UNRESPONSIVE_MAX_TICKS` / `UNRESPONSIVE_MAX_SEC` は tree タイムアウト時の保険で、tree を消すと不要
- `updateTeamJson` (L1542-1585) は `conductors[].pid` を書き出していない → 復元時の pid check には永続化が必要
- `initializeLayout` (L525) で team.json 復元時に `cmux.validateSurface` を呼んでいる
- `startMaster` (L459-488) はマーカーファイル `.team/master.surface` を読み、`isMasterAlive(surface, workspace)` で生存確認してから `state.masterSurface` / `state.masterStatus = "idle"` を復元して return する。**現状 `state.masterPid` を復元していないため Manager 再起動時に `spawnMasterPidWatcher` が起動されず、Master クラッシュが次の SESSION_* 受信まで検知できないリグレッションを抱えている**（本タスクで pid ベース復旧に書き換える）

#### `cmux.ts`

- `tree()` (L140) は 5 秒タイムアウト付き、テストフック `__setTreeImpl` あり
- `getPaneForSurface` (L148) は tree の出力をパース。**残す**
- `validateSurfaceDetailed` (L188-216) はリトライ 3 回 + タイムアウト判定で `"alive" | "missing" | "unknown"` を返す
- `validateSurface` (L222) は上記の bool ラッパー
- 新 surface 作成直後の生存確認（`main.ts:1488`, `master.ts:22`）では tree が直接使われる

#### `master.ts`

- `spawnMaster` → `validateSurface` 呼び出し (L22) は Master 起動時の cmux 側 surface 作成成功確認
- `isMasterAlive` (L49-51) は `validateSurface` の薄いラッパー。**呼び出し元は `daemon.ts:466` `startMaster()`**（L466: `const alive = await isMasterAlive(surface, state.workspace ?? undefined);`）。Manager 再起動時にマーカーファイル `.team/master.surface` から既存 Master surface を読み取り生存確認する経路である。**dead code ではない**（前稿の「grep で呼び出し元 0 件」は事実誤認）。本タスクで pid ベース実装に書き換える（削除ではない）

#### `conductor.ts`

- `getPaneIdForSurface` (L51-67) は Conductor 用 pane 逆引き。tree を内部で呼ぶ。**残す**
- `checkConductorStatus` (L568-578) は `validateSurface` を呼んで crashed/running 判定。**daemon.ts:8 で import されているが使用箇所なし** → dead code、削除

#### `main.ts`

- spawn-agent コマンドで L1488: `validateSurface(surface)` で newSurface 直後の生存確認
- send-agent コマンドで L1781: `validateSurface(targetSurface)` で送信先 Agent の生存確認
- `generateAgentSettings` (L1065-1101) は Agent 用 `settings.json` を書き出す。**SessionStart hook なし**（Stop / SessionEnd のみ）

### 2.2 実機確認が必要な項目（プロンプト §未確定事項の回答）

#### Q1. `$PPID` が返す PID は Claude 本体か？

**回答**: Conductor については既に動作しているため Claude 本体 PID であることが実運用で確認済み。`generateConductorSettings` の SessionStart hook は `bash -c 'cmux-team send ... --pid "$PPID"'` で起動され、`$PPID` は bash の親である claude プロセスを指す。`spawnPidWatcher` は `process.kill(conductor.pid, 0)` で disconnected 昇格しており、`/clear` / Claude クラッシュで正しく発火している。

**Agent については未確認**。`generateAgentSettings` には現状 SessionStart hook が存在しないため、Agent 用 hook 追加時に同じ `--pid "$PPID"` パターンが使えるかは実機で 1 度だけ確認する。`cmux-team spawn-agent` の起動経路（`main.ts:1517-1534`）を見ると:

```
cmux send "$surface" "export ROLE=... CMUX_SURFACE=... ...\n"
sleep 0.5
cmux send "$surface" "claude --settings '$agentSettingsPath' ...\n"
sleep 0.5
cmux send-key return
```

bash が親、claude が子の構造は同じ（bash で `claude ...` を実行すると claude は bash の子プロセスになり、SessionStart hook は claude から起動される bash サブシェルから見ると `$PPID` = claude PID）。**理屈上は同じ結果**になる。実装ステップ 5 で hook を仮組みしたら、手動で 1 Agent 起動して `.team/logs/manager.log` の `session_started A[NNN] pid=XXXXX` を確認し、`ps -p XXXXX` で claude プロセスであることを目視確認する（実装者向けチェック）。

**実機確認で `$PPID` が claude 本体を指さなかった場合の代替コマンド**（hook 本文に埋め込む候補）:

- `pgrep -P $PPID -x claude` — `$PPID` の子プロセスから `claude` という名の PID を逆引き
- `ps -p $PPID -o ppid=` — `$PPID` の親 PID を取得し、そちらが claude か確認
- `ps -eo pid,comm | awk -v p=$PPID '$1==p {print $2}'` — `$PPID` 自体のコマンド名を見て `claude` 以外なら fallback に分岐

デフォルトは `--pid "$PPID"` のまま仮組みし、実機確認で狂いがあれば上記に切り替える。plan 時点でこの切替え方針を書いておくことで、実装時の再設計コストを下げる。

#### Q2. `/clear` 後の PID 追跡

**現状の実装（前稿訂正）**: `SESSION_CLEAR` ハンドラ (daemon.ts:1025-1061) は `conductor.status` で 3 分岐している:

1. **`disconnected` / `starting` → `idle`** (L1028-1034): `conductor.status = "idle"` に戻しつつ、L1031 で **既に** `if (message.pid) conductor.pid = message.pid` として新 pid を保存している
2. **`running` → reset** (L1035-1058): `taskRunId` を journal に退避し Conductor を idle にリセット。この分岐では **既に** `clearInterval(conductor.pidWatcherInterval)` 済み
3. その他のケースは break

前稿（「pid の扱いは未定義 + pidWatcher を clear していない」）は実コード未確認による事実誤認。

**hook 動作前提の明文化**: `SESSION_CLEAR` を送るのは旧 Claude が `/clear` コマンドを受けた直後の hook で、この時の `$PPID` は **旧 Claude プロセス**。その後新 Claude が再 spawn され、新 Claude が走らせる `SessionStart` hook で届く pid が新 claude PID。**SESSION_CLEAR で届く message.pid は新旧どちらを指すかが hook 実装依存で、信用して保存すると直後に無効化される可能性が高い**。

**方針**: SESSION_CLEAR では `conductor.pid` を **更新しない**。理由:

- `/clear` 直後に必ず `SESSION_STARTED` hook が発火する。SESSION_STARTED ハンドラが `conductor.pid = message.pid` + `spawnPidWatcher` を適切に行うため、SESSION_CLEAR で pid を触る必要がない
- L1031 の `if (message.pid) conductor.pid = message.pid` は削除し、「pid 更新は SESSION_STARTED の責務」で統一する方が呼び出しの責務が明確
- L1035-1058 の `running → reset` 分岐では既存 `clearInterval` の直後に `conductor.pid = undefined` を明示追加し、ダングリング pid 参照を掃除する

監視側（spawnPidWatcher の interval コールバック）は `conductor.pid == null` を「判定保留」として skip する。

#### Q3. Manager 再起動時の永続化

**回答**: `team.json` に `conductors[].pid` を永続化する。Manager 再起動時に `initializeLayout` で `c.pid && isAlive(c.pid)` を判定し、alive なら status を復元（SESSION_STARTED を待たない）、死んでいる / pid 無しなら `status: "disconnected"` + 次の SESSION_* を待つ。

理由: team.json のアトミック書き込みは既に存在 (`daemon.ts:1578-1581`) し、pid 1 フィールド追加のコストは低い。Manager 再起動が多い開発用途で Conductor / Master が毎回 disconnected を経由するのは UX 劣化が大きい。

#### Q4. ハング中 Claude の false positive

**回答**: プロンプトの指示通り「検出しない（割り切り）」。`kill(pid, 0)` は PID 生存しか見ないため、Claude が応答しなくてもハング中は alive と扱う。ユーザーが `cmux-team abort-task` で手動介入する運用（既に `MEMORY.md` の `feedback_error_recovery` で確認済みの方針）。

#### Q5. PID 未設定の隙間

**回答**: `conductor.pid === undefined` の区間は:
- **starting → idle 遷移前**: `STARTING_TIMEOUT_SEC` (60s) の保険で starting 状態から disconnected に昇格する既存ロジックがあるため、新たな処理は不要
- **SESSION_CLEAR 直後 → 次の SESSION_STARTED まで**: conductor.status は idle で保持。監視ループは `pid === undefined` を「判定保留」として扱い、disconnected 昇格させない
- **team.json 復元直後 pid 無し**: disconnected で開始し、次の SESSION_* を待つ（上記 Q3）

---

## 3. 設計判断

### D1. `validateSurface` / `validateSurfaceDetailed` は **削除**、pid check 専用 API を新設する

プロンプトの「`validateSurface` も PID 置換」は、現状のすべての呼び出し元を分析すると **そのままの API 維持は不可能**。理由:

| 呼び出し元 | 目的 | PID 代替の可否 |
|---|---|---|
| `daemon.ts:466` startMaster（`isMasterAlive` 経由、**前稿抜け漏れ**） | Manager 再起動時のマーカー復旧時に既存 Master surface の生存確認 | **team.json の `master.pid` を読み `cmux.isAlive(pid)` で判定**。pid 無し or dead の場合はマーカー経路を放棄し `spawnMaster` 新規 spawn にフォールバック |
| `daemon.ts:525` initializeLayout | team.json 復元時の Conductor 生存確認 | 可（team.json に `conductors[].pid` 永続化後、`cmux.isAlive(c.pid)` に置換） |
| `daemon.ts:1314` monitorConductors | tick ごとの生存確認 | **不要**（spawnPidWatcher が既に担当） |
| `main.ts:1488` spawn-agent 新規 surface | newSurface 成功後の念押し | **削除可**（newSurface が surface を返した時点で cmux 側に存在している） |
| `main.ts:1781` send-agent 送信先確認 | Agent 送信先の生存確認 | 可（Agent に pid を追加後、`cmux.isAlive(agent.pid)` に置換） |
| `master.ts:22` Master spawn 直後 | newSplit 成功後の念押し | **削除可**（newSplit が surface を返した時点で生存） |
| `master.ts:49-51` `isMasterAlive` 本体 | `daemon.ts:466 startMaster` からのみ呼ばれる | **pid ベース実装に書き換え**（削除ではない）。新シグネチャ `isMasterAlive(projectRoot: string): Promise<boolean>` で team.json から `master.pid` を読み `cmux.isAlive(pid)` を返す |
| `conductor.ts:575` checkConductorStatus | ラッパー | **削除**（daemon.ts:8 で import されているが使用箇所なし、grep で確認済み） |

採用方針: **`validateSurface` / `validateSurfaceDetailed` を `cmux.ts` から削除**（`__setTreeImpl` は `getPaneForSurface` / `getPaneIdForSurface` 用に残す）、代わりに:

- `cmux.ts` に `isAlive(pid: number): boolean` を新設（`process.kill(pid, 0)` のラッパー、テストフック `__setIsAliveImpl` 付き）
- `daemon.ts` に `isConductorAlive(conductor): boolean` と `isAgentAlive(agent): boolean` の薄いヘルパーを新設し、内部で `conductor.pid != null && cmux.isAlive(conductor.pid)` を呼ぶ
- `master.ts isMasterAlive` は **削除せず pid ベース実装に書き換え**。新シグネチャ `isMasterAlive(projectRoot: string): Promise<boolean>` で team.json から `master.pid` を読み `cmux.isAlive(pid)` を返す。呼び出し元 `daemon.ts:466 startMaster` のシグネチャも同時更新する（D3.1 参照）
- 新規 surface 作成直後の「念押し validation」は削除（newSurface / newSplit の return 値でそのまま trust）

**テストフック設計**:

- 既存の `__setTreeImpl` は `getPaneForSurface` / `getPaneIdForSurface` の init 時に引き続き必要 → **残す**
- 新規 `__setIsAliveImpl(fn: ((pid: number) => boolean) | null)` を追加し、`isAlive(pid)` の戻り値を差し替え可能にする
- `daemon.test.ts` で `monitorConductors` をテストする際、従来は fake cmux の tree 出力を書き換えていたが、今後は `__setIsAliveImpl` で直接 pid の alive/dead を差し替える

### D2. Agent へ SessionStart hook を追加し、Agent も PID 追跡対象に組み込む

現状 `generateAgentSettings` は Stop / SessionEnd のみ。`main.ts:1781` の send-agent 送信先生存確認を pid check に置換するため、Agent の pid を daemon に通知する必要がある。

**採用**:

- `schema.ts` `AgentState` に `pid?: number` と `pidWatcherInterval?: ReturnType<typeof setInterval>` を追加
- `SessionStartedMessage` は既に存在。daemon の `SESSION_STARTED` ハンドラに Agent ケースを追加（Conductor.agents 配列を逆引きし、`agent.pid = message.pid` を保存 + spawnAgentPidWatcher 起動）
- `generateAgentSettings` に SessionStart hook を追加（`generateConductorSettings` と同じパターン: `bash -c 'cmux-team send SESSION_STARTED --conductor-id "$CONDUCTOR_ID" --surface "${CMUX_SURFACE}" --pid "$PPID" ...'`）
- `daemon.ts spawnPidWatcher` を **`spawnPidWatcher(target, pid)` の汎用版にリファクタ**（Conductor でも Agent でも使えるように）。または Agent 専用の `spawnAgentPidWatcher` を追加。**どちらでも良いが、差分を最小化するため後者を採用**し、既存 spawnPidWatcher は Conductor 専用のまま残す（agents 配列の削除処理が特殊だから）

### D3. team.json に `conductors[].pid` / `agents[].pid` を永続化、`master.pid` は既存実装を流用

- `updateTeamJson` で conductors / agents の pid を書き出す（**既に master.pid は書き出されている**）
- `initializeLayout` の復元ロジックで `c.pid && cmux.isAlive(c.pid)` を満たす Conductor のみを alive として取り込む
  - 満たさない Conductor は `status: "disconnected"` + `pid: undefined` で取り込み、次の SESSION_STARTED で復旧
  - 復元時に `spawnPidWatcher(state, conductor, c.pid)` を起動する
  - Agent についても同様に `a.pid && cmux.isAlive(a.pid)` なら `spawnAgentPidWatcher` を起動する

### D3.1. Master resume 経路（`daemon.ts:466 startMaster`）の PID 化

**背景**: `startMaster` は `.team/master.surface` マーカーから既存 Master surface を読んで `isMasterAlive(surface)` で生存確認するが、現状は surface ベースで `cmux.tree` を経由する（`validateSurface` 削除とともに破綻する）。加えて Manager 再起動時に `state.masterPid` を復元していないため `spawnMasterPidWatcher` が起動されず、Master クラッシュが次の SESSION_* 受信まで検知できない隠れリグレッションがある。

**新しい `startMaster` のフロー**:

1. マーカーファイル `.team/master.surface` を読み `markerSurface` を取得（現状通り）
2. `team.json` を読み `teamJson.master.pid` を取得
3. **`master.pid` が無い場合**: マーカー経路を放棄し、マーカーファイルを削除して新規 `spawnMaster` にフォールバック
4. **`isMasterAlive(state.projectRoot)` が true の場合** (内部で `cmux.isAlive(teamJson.master.pid)`):
   - `state.masterSurface = markerSurface`
   - `state.masterPid = teamJson.master.pid`
   - `state.masterStatus = "idle"`
   - **`spawnMasterPidWatcher(state, state.masterPid)` をここで起動** + `log("master_restored", ...)`
   - return
5. **`isMasterAlive` が false の場合**: マーカーファイルを削除して新規 `spawnMaster` にフォールバック

新規 `spawnMaster` 経路では従来通り、`state.masterSurface` 設定後、`SESSION_STARTED` ハンドラが `state.masterPid` 保存 + `spawnMasterPidWatcher` 起動を担う。

**どちらが `spawnMasterPidWatcher` を起動するかのライフサイクル**:

- `initializeLayout` は Master を扱わない（Conductor/Agent の state 復元のみ）
- `startMaster` 内部で Master 復旧時の `spawnMasterPidWatcher` を起動する（責務を 1 箇所に集約）
- 新規 spawn 経路では `SESSION_STARTED` ハンドラが起動する（既存と同じ）

Master resume 失敗時のフォールバックコスト: マーカー削除 → `spawnMaster` の split + claude 起動で約 1〜2 秒。頻度は低い（Manager 再起動 + PID 再利用衝突時のみ）ため許容する。

### D4. `SESSION_CLEAR` ハンドラで PID と pidWatcher を明示的にクリア

`/clear` race 対策。

### D5. `monitorConductors` の責務を縮減

tree ベースの生存確認を削除し、以下の責務だけを残す:

1. **starting 状態のタイムアウト判定** (既存 STARTING_TIMEOUT_SEC = 60s)
2. **disconnected 状態のタイムアウト判定 + forceClose** (既存 DISCONNECT_TIMEOUT_SEC = 300s)
3. ~~Conductor surface 生存チェック~~ → **削除**（spawnPidWatcher に一本化）
4. ~~Agent surface 生存チェック~~ → **削除**（spawnAgentPidWatcher に一本化）

副次的に以下を削除:

- `treeOutput` キャッシュ
- `surfaceAlive` ローカル関数
- `UNRESPONSIVE_MAX_TICKS` / `UNRESPONSIVE_MAX_SEC` 定数とカウンタロジック
- `ConductorState.treeFailureCount` / `treeFailureFirstAt`
- `conductor_unresponsive_started` / `conductor_unresponsive_threshold` / `conductor_responsive_recovered` / `monitor_skip_agents` / `monitor_tree_failed` ログイベント

### D6. conductor テンプレート (ja/en) の Agent 監視ループを await-agent + send-agent ベースへ全面書き換え

現状の `cmux list-status` diff + 30 秒ポーリングは、T181 で既に CLI (`cmux-team await-agent`) が用意されていながらテンプレートには未反映。本タスクで同期する。

テンプレートの新しい Agent 監視ブロック（draft）:

```bash
# Agent spawn — AGENT_SURFACE を出力から取り出す
RESULT=$(cmux-team spawn-agent \
  --conductor-surface "$CMUX_SURFACE" \
  --role impl \
  --task-title "<title>" \
  --prompt-file "$PROMPT_FILE")
AGENT_SURFACE=$(echo "$RESULT" | grep -o 'SURFACE=surface:[0-9]*' | cut -d= -f2)
echo "Agent spawned: $AGENT_SURFACE"

# 完了を待つ（done マーカー fs.watch、push 型通知）
cmux-team await-agent --surface "$AGENT_SURFACE" --timeout 3600
STATUS=$?
case $STATUS in
  0)  echo "Agent $AGENT_SURFACE: 完了（completed または ask）" ;;
  10) echo "Agent $AGENT_SURFACE: クラッシュ → 再起動または abort 判断" ;;
  2)  echo "Agent $AGENT_SURFACE: タイムアウト → read-screen で状態確認" ;;
esac
```

**1 体ずつ起動**: 起動確認は「`spawn-agent` の exit code 0」で十分（cmux-team が Claude 起動まで面倒を見る）。`cmux list-status` での確認は不要。

---

## 4. 実装ステップ（順序付き）

実装は以下の順番で小さくコミットする。各ステップで `bun test` を通す。

### ステップ 1. schema と型の整理

**ファイル**: `skills/cmux-team/manager/schema.ts`

- `ConductorState` から `treeFailureCount` / `treeFailureFirstAt` を削除
- `AgentState` に `pid?: number` と `pidWatcherInterval?: ReturnType<typeof setInterval>` を追加

差分イメージ:

```typescript
export const ConductorState = z.object({
  // ...
  pid: z.number().optional(),
  sessionId: z.string().optional(),
  disconnectedAt: z.string().datetime().optional(),
-  // T180: cmux tree タイムアウト連続失敗カウンタ
-  treeFailureCount: z.number().optional(),
-  treeFailureFirstAt: z.string().datetime().optional(),
  askQuestion: z.string().optional(),
});

export interface AgentState {
  surface: string;
  role?: string;
  taskTitle?: string;
  spawnedAt: string;
  sessionId?: string;
+  pid?: number;
+  pidWatcherInterval?: ReturnType<typeof setInterval>;
}
```

### ステップ 2. `cmux.ts` に `isAlive` 追加・tree 関連 API の整理

**ファイル**: `skills/cmux-team/manager/cmux.ts`

- `isAlive(pid: number): boolean` を新設（`process.kill(pid, 0)` を try/catch でラップ）
- `__setIsAliveImpl(impl: ((pid: number) => boolean) | null)` テストフックを追加
- `validateSurface` / `validateSurfaceDetailed` / `VALIDATE_SURFACE_*` / `sleep` ヘルパー を **削除**
- `tree()` / `getPaneForSurface()` / `__setTreeImpl()` は**残す**（init 時のみ使う）
- `TREE_TIMEOUT_MS` も残す

差分イメージ:

```typescript
/** テスト用 PID 生存チェックフック */
let isAliveImpl: ((pid: number) => boolean) | null = null;

export function __setIsAliveImpl(impl: ((pid: number) => boolean) | null): void {
  isAliveImpl = impl;
}

export function isAlive(pid: number): boolean {
  if (isAliveImpl) return isAliveImpl(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

### ステップ 3. master.ts `isMasterAlive` を pid ベースへ書き換え、`spawnMaster` の surface 検証を撤去、conductor.ts の dead code 削除

**ファイル**: `skills/cmux-team/manager/master.ts`

- `isMasterAlive` の **シグネチャを変更**し pid ベース実装に書き換え（**削除しない**）。現状 `daemon.ts:466 startMaster()` から呼ばれているため削除するとコンパイル不能になる:

```typescript
// before（surface ベース、dead code 誤判定で削除予定だったもの）
export async function isMasterAlive(
  surface: string,
  workspace?: string
): Promise<boolean> {
  return await cmux.validateSurface(surface, workspace);
}

// after（pid ベース）
import { readTeamJson } from "./team-json"; // 既存の team.json 読み取りヘルパーを使う
import * as cmux from "./cmux";
export async function isMasterAlive(projectRoot: string): Promise<boolean> {
  const teamJson = await readTeamJson(projectRoot);
  const pid = teamJson?.master?.pid;
  if (pid == null) return false;
  return cmux.isAlive(pid);
}
```

（`readTeamJson` が既存ヘルパー名でない場合、`updateTeamJson` 周辺の read 関数を再利用 or 小さな read 関数を追加。実装時に選択）

- `spawnMaster` の L22 `validateSurface` チェックを削除（newSplit 成功 = surface 存在）

**ファイル**: `skills/cmux-team/manager/daemon.ts` `startMaster` (L459-488)

- マーカーファイル読み取り成功後のフロー（D3.1 参照）:
  1. `isMasterAlive(state.projectRoot)` を呼ぶ
  2. alive なら `state.masterSurface = markerSurface` / `state.masterPid = teamJson.master.pid` / `state.masterStatus = "idle"` を復元し、**`spawnMasterPidWatcher(state, state.masterPid)` をここで起動**して return
  3. dead or pid 無しならマーカーファイルを削除し、後続の新規 `spawnMaster` 経路に進む
- `isMasterAlive(surface, state.workspace)` の呼び出しを `isMasterAlive(state.projectRoot)` に変更
- `state.masterPid` 復元のために `startMaster` 内で改めて `readTeamJson` するか、`isMasterAlive` の内部で読んだ teamJson を out-param や戻り値の拡張で渡すかは実装時に選択（最小差分なら `startMaster` 側で再度 `readTeamJson` するのが単純）

**ファイル**: `skills/cmux-team/manager/conductor.ts`

- `checkConductorStatus` を削除（daemon.ts:8 の import も削除）。grep で外部呼び出し元がないことを確認済み

### ステップ 4. `monitorConductors` の縮減

**ファイル**: `skills/cmux-team/manager/daemon.ts`

- `monitorConductors` 本体から tree 呼び出し・キャッシュ・surfaceAlive 関数を削除
- 残す責務: starting timeout, disconnected timeout + forceClose, (Agent に関する done マーカー回収は spawnAgentPidWatcher / SESSION_ENDED ハンドラに委譲)
- `UNRESPONSIVE_MAX_TICKS` / `UNRESPONSIVE_MAX_SEC` / 対応ログ定数を削除
- `monitor_tree_failed` / `conductor_unresponsive_started` / `conductor_unresponsive_threshold` / `conductor_responsive_recovered` / `monitor_skip_agents` ログイベントを削除

差分イメージ（monitorConductors 全体が 40-50 行にまで縮む）:

```typescript
export async function monitorConductors(state: DaemonState): Promise<void> {
  for (const [surface, conductor] of state.conductors) {
    // starting: タイムアウトチェックのみ
    if (conductor.status === "starting") {
      const elapsed = (Date.now() - new Date(conductor.startedAt).getTime()) / 1000;
      if (elapsed > STARTING_TIMEOUT_SEC) {
        conductor.status = "disconnected";
        conductor.disconnectedAt = new Date().toISOString();
        notifyStateChanged("daemon.ts:monitorConductors:starting-timeout");
        await log(
          "conductor_start_timeout",
          `${formatSurface(surface, "C")} elapsed=${Math.round(elapsed)}s`
        );
      }
      continue;
    }

    // disconnected: timeout チェック → forced cleanup
    if (conductor.status === "disconnected") {
      if (conductor.disconnectedAt) {
        const elapsed = (Date.now() - new Date(conductor.disconnectedAt).getTime()) / 1000;
        if (elapsed > DISCONNECT_TIMEOUT_SEC) {
          await log(
            "conductor_disconnect_timeout",
            `${formatSurface(surface, "C")} elapsed=${Math.round(elapsed)}s taskRunId=${conductor.taskRunId ?? "-"}`
          );
          await forceCloseDisconnectedConductor(state, conductor);
        }
      }
      continue;
    }

    // running / idle: 生存確認は spawnPidWatcher / spawnAgentPidWatcher に一本化。ここでは何もしない
  }
}
```

### ステップ 5. Agent 用 SessionStart hook 追加 & SESSION_STARTED ハンドラ拡張

**ファイル**: `skills/cmux-team/manager/main.ts` `generateAgentSettings`

- `generateConductorSettings` の SessionStart hook と同等のブロックを追加:

```typescript
SessionStart: [
  {
    matcher: "startup",
    hooks: [{
      type: "command",
      command: `bash -c 'cmux-team send SESSION_STARTED --surface "${surface}" --pid "$PPID" 2>/dev/null || true'`,
      timeout: 5000,
    }],
  },
],
```

（Conductor と違い `--conductor-id` は付けない。Agent は conductor-id を持たない）

**ファイル**: `skills/cmux-team/manager/daemon.ts` `SESSION_STARTED` ハンドラ

- Master / Conductor の次に Agent ケースを追加:

```typescript
// Agent surface か？ agents 配列を全 Conductor から逆引き
for (const c of state.conductors.values()) {
  const agent = c.agents.find(a => a.surface === message.surface);
  if (agent) {
    agent.pid = message.pid;
    spawnAgentPidWatcher(state, c, agent, message.pid);
    notifyStateChanged("daemon.ts:handleMessage:session-started-agent");
    await log(
      "session_started",
      `${formatPair(c.surface, message.surface, "C", "A")} pid=${message.pid}`
    );
    return;
  }
}
// どれにも該当しない → session_started_ignored
```

`spawnAgentPidWatcher` は `spawnPidWatcher` をコピーして Agent 向けに改変。**冪等性を明示的に持たせる**こと（SESSION_ENDED ハンドラが先に Agent を削除していた場合は no-op で return）:

```typescript
export function spawnAgentPidWatcher(
  state: DaemonState,
  conductor: ConductorState,
  agent: AgentState,
  pid: number,
): void {
  if (agent.pidWatcherInterval) clearInterval(agent.pidWatcherInterval);
  const checkInterval = setInterval(async () => {
    if (!state.running) {
      clearInterval(checkInterval);
      agent.pidWatcherInterval = undefined;
      return;
    }
    if (cmux.isAlive(pid)) return;
    clearInterval(checkInterval);
    agent.pidWatcherInterval = undefined;

    // 冪等性: SESSION_ENDED ハンドラが先に Agent を削除していた場合は no-op で return
    const idx = conductor.agents.findIndex(a => a.surface === agent.surface);
    if (idx === -1) {
      await log(
        "agent_pid_watcher_noop",
        `${formatPair(conductor.surface, agent.surface, "C", "A")} reason=already_removed pid=${pid}`
      );
      return;
    }

    // done マーカー書き出し → SESSION_ENDED 相当の処理
    try {
      await writeAgentDone(state.projectRoot, conductor.surface, agent.surface, {
        status: "crashed",
        reason: "pid_watcher",
      });
    } catch (e: any) {
      await log("error", `writeAgentDone failed (agent pid_watcher): ${e.message}`);
    }
    conductor.agents.splice(idx, 1);
    notifyStateChanged("daemon.ts:spawnAgentPidWatcher:agent-removed");
    await log(
      "agent_done",
      `${formatPair(conductor.surface, agent.surface, "C", "A")} trigger=pid_watcher status=crashed pid=${pid}`
    );
  }, 1000);
  agent.pidWatcherInterval = checkInterval;
}
```

**SESSION_ENDED 側の冪等性**: 既存の `SESSION_ENDED` ハンドラ (`daemon.ts:801-824`) は `agent = conductor.agents.find(a => a.surface === message.surface)` の結果が undefined なら自然に no-op で return する構造のため、変更不要。spawnAgentPidWatcher が先に splice した後に SESSION_ENDED が届いても問題なく処理される。

### ステップ 6. `SESSION_CLEAR` ハンドラの PID 取り扱いを整理（既存 3 分岐構造に沿って変更）

**ファイル**: `skills/cmux-team/manager/daemon.ts` L1025-1061

既存ハンドラは `conductor.status` で 3 分岐している（§2.2 Q2 参照）。前稿の diff は「break 直後に clear 挿入」の単純形だったが、実コードの構造を反映した差分に書き直す。

**本タスクでの変更**:

1. **L1031 `if (message.pid) conductor.pid = message.pid` を削除**
   - 理由: `/clear` 直後に必ず `SESSION_STARTED` hook が発火する。SESSION_STARTED ハンドラが `conductor.pid = message.pid` + `spawnPidWatcher` を行うため、SESSION_CLEAR で pid を更新する必要はない。「pid 更新は SESSION_STARTED の責務」で統一する
2. **`running → reset` 分岐で `clearInterval(conductor.pidWatcherInterval)` 直後に `conductor.pid = undefined` を明示**
   - 理由: `pidWatcherInterval` は clear 済みだが `pid` は過去値が残る状態になるため、ダングリング参照を避けるため明示クリア
3. **`disconnected / starting → idle` 分岐では pid/pidWatcherInterval を触らない**
   - 次の SESSION_STARTED がすべて上書きするため、この分岐では何もしない

差分イメージ（3 分岐構造を保った形。既存コードをアンカーとして参照）:

```typescript
case "SESSION_CLEAR": {
  const conductor = findConductor(state, message.surface);
  if (!conductor) break;
  const prev = conductor.status;

  if (prev === "disconnected" || prev === "starting") {
    // SESSION_CLEAR で pid を更新しない（次の SESSION_STARTED に委ねる）
-    if (message.pid) conductor.pid = message.pid;
    conductor.status = "idle";
    notifyStateChanged("daemon.ts:handleMessage:session-clear-idle");
    // ... 既存の log ...
    break;
  }

  if (prev === "running") {
    // 既存: taskRunId を journal に退避
    // ... 既存ロジック ...
    if (conductor.pidWatcherInterval) {
      clearInterval(conductor.pidWatcherInterval);
      conductor.pidWatcherInterval = undefined;
+      conductor.pid = undefined; // /clear で旧 Claude は死ぬ。次の SESSION_STARTED を待つ
    }
    conductor.status = "idle";
    // ... 既存の notifyStateChanged / log ...
    break;
  }

  break;
}
```

**ログ追加**: `session_clear` イベントに `prev_pid=<旧 pid>` を一言添えると `/clear` race のデバッグが容易になる（optional。実装時に判断）。

### ステップ 7. `updateTeamJson` で pid を永続化 & `initializeLayout` で復元

**ファイル**: `skills/cmux-team/manager/daemon.ts` `updateTeamJson`

```typescript
teamJson.conductors = [...state.conductors.values()].map((c) => ({
  surface: c.surface,
  taskRunId: c.taskRunId,
  taskId: c.taskId,
  taskTitle: c.taskTitle,
  status: c.status,
  worktreePath: c.worktreePath,
  outputDir: c.outputDir,
  startedAt: c.startedAt,
  paneId: c.paneId,
  sessionId: c.sessionId,
+  pid: c.pid,
  agents: c.agents.map((a) => ({
    surface: a.surface,
    role: a.role,
    sessionId: a.sessionId,
+    pid: a.pid,
  })),
}));
```

**ファイル**: `skills/cmux-team/manager/daemon.ts` `initializeLayout` L521-567

- `cmux.validateSurface` 呼び出しを `cmux.isAlive(c.pid)` に置換
- pid 無しの Conductor は `status: "disconnected"` で取り込み（次の SESSION_STARTED を待つ）
- alive な Conductor は `spawnPidWatcher(state, restored, c.pid)` を呼んで watcher を再起動
- Agent 側も `a.pid && cmux.isAlive(a.pid)` の場合は `spawnAgentPidWatcher` を起動

差分イメージ:

```typescript
if (conductors.length > 0) {
  const alive: ConductorState[] = [];
  for (const c of conductors) {
    if (!c.surface) continue;
-    if (await cmux.validateSurface(c.surface, state.workspace ?? undefined)) {
+    const conductorAlive = c.pid != null && cmux.isAlive(c.pid);
+    const restored: ConductorState = {
       surface: c.surface,
       taskRunId: c.taskRunId,
       // ...
+      pid: conductorAlive ? c.pid : undefined,
+      status: conductorAlive
+        ? (c.status === "running" ? "running" : c.status === "disconnected" ? "disconnected" : "idle")
+        : "disconnected",
+      disconnectedAt: conductorAlive ? undefined : new Date().toISOString(),
       agents: (c.agents ?? []).map((a: any) => ({
         surface: a.surface,
         role: a.role,
         sessionId: a.sessionId,
         spawnedAt: a.spawnedAt ?? new Date().toISOString(),
+        pid: (a.pid != null && cmux.isAlive(a.pid)) ? a.pid : undefined,
       })),
+    };
+    alive.push(restored);
+    if (conductorAlive) spawnPidWatcher(state, restored, c.pid!);
+    for (const a of restored.agents) {
+      if (a.pid != null) spawnAgentPidWatcher(state, restored, a, a.pid);
+    }
  }
  // ...
}
```

**Master resume の取り扱い**: `initializeLayout` では Master を復元しない。Master の復旧は `startMaster` 内の D3.1 フロー（マーカー読み → `isMasterAlive(projectRoot)` → alive なら `state.masterPid` 設定 + `spawnMasterPidWatcher` 起動）に一本化する。起動順は `initializeLayout` → `startMaster` で、`initializeLayout` は Conductor/Agent の state 復元のみ担当し、Master 分は完全に `startMaster` に委譲する（責務分離）。

### ステップ 8. spawn-agent / send-agent の validation 置換

**ファイル**: `skills/cmux-team/manager/main.ts`

- L1488 spawn-agent 直後の validation → 削除（newSurface / newSplit 成功で信頼）
- L1781 send-agent の validation → agents 配列から agent を逆引きし `cmux.isAlive(agent.pid)` で確認する。**pid 未反映ウィンドウに 200ms × 3 リトライ**、それでも無ければ reject

**pid 未反映ウィンドウの対処**: Agent 起動直後は `SESSION_STARTED` 処理 → `updateTeamJson` persist の前に `send-agent` が呼ばれると team.json に pid が無く reject される。Conductor が `cmux-team spawn-agent` → `cmux-team await-agent` を直列に呼ぶ運用（現行テンプレート）であれば問題にならないが、将来的に並列ワークフロー化した場合の保険として send-agent 側に 3 回 (200ms 間隔) のリトライを実装する。リトライ回数は `200ms × 3 = 600ms` 以内にほぼ確実に team.json に反映される前提（実機で要確認）。

差分イメージ (send-agent):

```typescript
-// cmux 実態の validateSurface でも確認（team.json と実態のズレ対策）
-const workspace = await cmux.getCallerWorkspace();
-if (!(await cmux.validateSurface(targetSurface, workspace))) {
-  console.error(`Error: surface ${targetSurface} validation failed`);
+// Agent の PID を team.json から引いて生存確認する（起動直後の pid 未反映ウィンドウに 3 回リトライ）
+let targetAgent = await findAgentInTeamJson(targetSurface);
+for (let i = 0; i < 3 && !targetAgent?.pid; i++) {
+  await sleep(200);
+  targetAgent = await findAgentInTeamJson(targetSurface);
+}
+if (!targetAgent?.pid || !cmux.isAlive(targetAgent.pid)) {
+  const reason = targetAgent?.pid == null ? "no pid in team.json" : "pid dead";
+  console.error(`Error: surface ${targetSurface} is not alive (${reason})`);
  // ...
}
+const workspace = await cmux.getCallerWorkspace();
```

`findAgentInTeamJson(surface)` ヘルパーは既存の `findConductorSurfaceForAgent` と同じ team.json 読み取りロジックを流用して pid も返せるよう拡張する。`sleep` は小さなローカルヘルパー or 既存のものを再利用する。

### ステップ 9. ログ定数の整理

**ファイル**: `skills/cmux-team/manager/daemon.ts`

削除するログイベント:

- `monitor_tree_failed`
- `conductor_unresponsive_started`
- `conductor_unresponsive_threshold`
- `conductor_responsive_recovered`
- `monitor_skip_agents`
- `kind=cmux_unresponsive` / `kind=tree_unresponsive_persistent` 関連

追加するログイベント:

- `agent_pid_watcher_started` (spawnAgentPidWatcher で起動時)
- 既存 `session_started` / `session_ended` / `agent_done` を Agent でも使い回す（新イベント名なし）

### ステップ 10. テストの更新

**ファイル**: `skills/cmux-team/manager/cmux.test.ts`

- `validateSurface リトライ (T121)` / `validateSurfaceDetailed (T180)` describe ブロックを **削除**（API がなくなる）
- 新規 describe `isAlive (T195)`:
  - `__setIsAliveImpl` で差し替え → 返り値 true / false のパススルー確認
  - 実 `process.kill` 呼び出しの統合テスト 1 本（own PID で alive、架空 PID で dead）

**ファイル**: `skills/cmux-team/manager/daemon.test.ts`

- `crashed → disconnected 遷移 (T121)` の各ケースを PID ベースに書き換え:
  - fake cmux の tree 出力を書き換える代わりに `__setIsAliveImpl(() => false)` で dead を表現
  - `monitorConductors` を直接呼んでも disconnected にはならない（tick では判定しない）
  - 代わりに「spawnPidWatcher が 1 秒後に disconnected に昇格する」統合テストを追加
  - または spawnPidWatcher の interval 部分を直接呼べるようテスト用エクスポートを追加
- 新規テスト:
  - `SESSION_CLEAR で pid / pidWatcherInterval がクリアされる`
  - `initializeLayout で team.json 復元時に pid alive なら spawnPidWatcher が起動する`
  - `initializeLayout で team.json 復元時に pid dead / 無しなら status=disconnected`
  - `SESSION_STARTED を Agent surface に対して受けると agent.pid が設定される`
  - `spawnAgentPidWatcher が kill 失敗で done マーカーを書き crashed 報告する`

**ファイル**: `skills/cmux-team/manager/conductor.test.ts`

- `checkConductorStatus` が削除されるため、そのテスト（あれば）を削除

**テストで tree を差し替える必要がある残り箇所**:
- `getPaneIdForSurface` / `getPaneForSurface` のテスト — `__setTreeImpl` を引き続き使う

### ステップ 11. docs 同期

(詳細は §6 に一覧)

### ステップ 12. CHANGELOG.md 追記

(詳細は §7 に記載)

---

## 5. テスト戦略

### 5.1 既存テスト green 維持

- `cmux.test.ts`: validateSurface テスト群は API 削除により消す。代わりに `isAlive` テストを新設
- `daemon.test.ts`: 既存の monitorConductors ベース crashed テスト 5 本を PID ベースに書き換え（下記）
- `conductor.test.ts`: checkConductorStatus テストがあれば削除

### 5.2 spawnPidWatcher crashed テスト書き換え（named export 方式に統一）

`monitorConductors` から PID チェックロジックが消えたため、従来の `monitorConductors(state)` を 1 回呼んで disconnected を assert する形は使えない。**`spawnPidWatcher` の interval コールバック本体を named export し、テストから直接呼ぶ方針で統一**する（fake timer / real timer 両論併記を廃止し前者に絞る）。

**方針**:

1. `daemon.ts` の `spawnPidWatcher` / `spawnAgentPidWatcher` を `export function` 化
2. interval コールバック本体を外部関数に抽出し、`__testSpawnPidWatcherTick(state, conductor, pid)` / `__testSpawnAgentPidWatcherTick(state, conductor, agent, pid)` として test-only export（`__` prefix で実行時には呼ばれない規約）
3. テストは `__setIsAliveImpl(() => false)` を先に設定 → `__testSpawnPidWatcherTick` を await → `conductor.status === "disconnected"` を assert

Before:
```typescript
await writeFakeCmux(`echo "tree error" >&2; exit 1`);
// ... setup conductor ...
await monitorConductors(state);
expect(conductor.status).toBe("disconnected");
```

After:
```typescript
import { __setIsAliveImpl } from "./cmux";
import { __testSpawnPidWatcherTick } from "./daemon";

__setIsAliveImpl(() => false);
try {
  // ... setup conductor with pid=99999 ...
  await __testSpawnPidWatcherTick(state, conductor, 99999);
  expect(conductor.status).toBe("disconnected");
} finally {
  __setIsAliveImpl(null);
}
```

**real timer + `sleep(1100)` 方式は採用しない**（CI 時間増 + flaky リスク）。bun の fake timer 有無を調査する必要もなく、1 tick の直接呼び出しで済む。どうしても interval の実挙動を確認したい場合は手動 smoke テスト（§5.4）で補う。

### 5.3 spawnAgentPidWatcher のテスト

`__testSpawnAgentPidWatcherTick` で同様に書く。必須テスト:

- **Agent dead → done マーカー書き出し + conductor.agents から削除**
- **冪等性**: `conductor.agents` から事前に該当 Agent を削除してから tick を呼び、`writeAgentDone` が呼ばれないこと + `agent_pid_watcher_noop` ログが出ることを assert
- **SESSION_ENDED 先行**: SESSION_ENDED handler がすでに Agent を削除した状態から tick を呼んでも副作用ゼロ

### 5.4 新規統合テスト (手動 smoke テスト)

以下のシナリオを手で 1 回ずつ確認する（自動化難易度が高いため）:

1. **基本稼働**: `cmux-team start` → Conductor pane が idle 状態で出る → `cmux-team create-task` → タスクが割り当てられる → Conductor が worktree 内で作業 → 完了で idle に戻る
2. **Conductor /clear**: 稼働中 Conductor で `/clear` 実行 → `.team/logs/manager.log` に `session_clear` と直後の `session_started` が連続で出る。`disconnected` が間に入らないことを目視
3. **Conductor kill**: `ps` で Conductor の claude PID を特定 → `kill -9 <pid>` → 1 秒以内に `session_ended ... reason=pid_watcher` ログ + Conductor が disconnected
4. **Manager 再起動**: 稼働中に `cmux-team stop` → `cmux-team start` → team.json 復元で alive な Conductor が running で復帰（新規プロンプト送信なし）
5. **Agent crash**: 稼働中 Agent を `kill -9` → 1 秒以内に Agent の done マーカー (`status=crashed reason=pid_watcher`) が書かれる → Conductor 側の `cmux-team await-agent` が exit 10 で返る
6. **cmux daemon ハング**: `kill -STOP <cmux_pid>` で cmux daemon を一時停止 → Manager の `monitorConductors` が **固まらない**（tree 呼び出しがゼロになっている）→ その間も spawnPidWatcher が機能し続ける → `kill -CONT <cmux_pid>` で復旧後、Manager は何事もなかったかのように継続

### 5.5 CI チェック

本タスクの完了条件の grep を CI に仕込むかは議論の余地あり（現状 CI 無し）。ここでは **release ノートにチェック結果を記載** する運用を採用。

---

## 6. docs 同期の差分リスト

### `CLAUDE.md`

| 行 | 現状 | 修正 |
|---|---|---|
| L435 | `- **フォールバック**: cmux list-status で Idle 検出` | `- **主要判定**: 独自 hook の SESSION_IDLE / SESSION_STARTED / SESSION_ENDED が daemon に push され、pid 単位で spawnPidWatcher が生存追跡` に置換 |
| L498 | 通信表の `| cmux list-status | 上位が下位の状態を取得（pull 型監視） |` | 行ごと削除。続く `cmux tree` 行に注記「init 時の pane 逆引きのみ。監視は hook + PID」を追記 |
| L519 | `Manager の状態 \| Manager workspace \| cmux list-status --workspace MANAGER_WS` | `Manager の状態 \| .team/logs/manager.log \| cat .team/logs/manager.log または cmux-team status` に置換 |
| L520 | `稼働中 Conductor \| cmux ペイン構成 \| cmux tree` | `稼働中 Conductor \| .team/team.json \| jq .conductors .team/team.json` に置換 |
| L572 | `| Agent クラッシュ | Conductor | cmux list-status で消失検出 → 再 spawn |` | `| Agent クラッシュ | Conductor | cmux-team await-agent が STATUS=crashed で exit 10 → Conductor が判断 |` |
| L577 | `**異常検出**: cmux list-status で Running/Idle を判定。検出できない場合は cmux read-screen にフォールバック（...）` | `**異常検出**: PID ベース生存確認（spawnPidWatcher が process.kill(pid, 0) を 1s 間隔で呼ぶ）と hook push（SESSION_STARTED / SESSION_IDLE / SESSION_ENDED）で行う。read-screen は Trust 確認検出にのみ使う` |

### `skills/cmux-team/SKILL.md`

| 行 | 現状 | 修正 |
|---|---|---|
| L60 | `| Conductor ← Agent | pull（cmux list-status で Idle/Running 検出） |` | `| Conductor ← Agent | cmux-team await-agent（done マーカー fs.watch）+ PID watcher |` |
| L61 | `| Manager → Master | .team/logs/manager.log + cmux list-status（直接参照） |` | `| Manager → Master | .team/logs/manager.log + cmux-team status（team.json + ログ） |` |
| L167 | `| cmux tree | ペイン・サーフェス階層を表示 |` | **残す** + 注記「init 時の pane 逆引きのみ使用」 |

### `docs/spec/01-skill-cmux-team.md`

| 行 | 現状 | 修正 |
|---|---|---|
| L46 | `... + fallback の cmux list-status` | fallback 部分を削除。`Conductor ← Agent | cmux-team await-agent（Agent の Stop/SessionEnd hook が書き出す done マーカーを fs.watch で監視）` |
| L47 | `| Manager → Master | .team/logs/manager.log + cmux list-status（直接参照） |` | `| Manager → Master | .team/logs/manager.log + cmux-team status |` |
| L131 | `... surface 検証や tree 取得には常に --workspace を付けて問い合わせる` | 「surface 検証」を「pane 逆引き・surface 作成」に修正 |
| L138 | `| cmux tree --workspace <id> | ペイン・サーフェス階層を表示 ... |` | **残す**（init 時の pane 逆引きに使用する旨を注記） |

### `docs/spec/04-templates.md`

| 行 | 現状 | 修正 |
|---|---|---|
| L78 | `- Agent 監視: 30秒間隔ポーリング + cmux list-status で Idle/Running 検出` | `- Agent 監視: cmux-team await-agent（done マーカーの fs.watch、push 型通知）+ 生存はPIDウォッチャー` |

### `skills/cmux-team/templates/ja/conductor.md`

| 行 | 修正内容 |
|---|---|
| L67 | `cmux list-status で Idle 検出 → TaskUpdate: task-1 → completed` → `cmux-team await-agent が STATUS=completed で返る → TaskUpdate: task-1 → completed` |
| L115 | `起動確認（cmux list-status で Running 検出）してから次を起動する。` → `起動確認（spawn-agent が exit code 0 を返す）してから次を起動する。` |
| L125-148 | 「Agent 監視ループ」セクション全体を書き換え。§3 D6 の新しい await-agent ベースのスクリプトに差し替え。`STATUS_BEFORE` / `STATUS_AFTER` / `AGENT_KEYS` / 30 秒ポーリングループを削除 |
| L177-179 | 「完了判定」リストを await-agent の exit code 表に差し替え（`0 completed/ask`, `10 crashed`, `2 timeout`） |

**行番号に関する注記**: 前稿（L121-174, L176-180）とタスク指示（L125-148, L177-179）の間に行番号差があった。実装時は **行番号ではなく Markdown の見出し/前後のブロックをアンカーとしてセクション単位で置換** する。行番号差は本改訂で指示に合わせた（タスク指示は現状ファイルに対する正確な行番号の前提）。

### `skills/cmux-team/templates/en/conductor.md`

同上。L67, L115, L125-148, L177-179 を英語で同じ内容に書き換え（行番号注記は ja 版と同じく「セクション単位で置換」方針）。

### `.team/specs/requirements.md`

| 行 | 現状 | 修正 |
|---|---|---|
| L69 | `REQ-012: Agent 監視 — Conductor が cmux list-status で Running/Idle/Needs input を検出（pull 型、hooks ベース）` | `REQ-012: Agent 監視 — Conductor が cmux-team await-agent で done マーカー（Stop/SessionEnd hook が書き出す）を fs.watch し、Manager 側は spawnPidWatcher / spawnAgentPidWatcher で PID 生存を追跡` |

---

## 7. CHANGELOG エントリ案

`[3.47.0] - 2026-04-16` (予定日)

### Changed (Breaking)

- **Manager daemon の監視ループから `cmux tree` / `cmux list-status` 依存を完全に撤廃（T195）**。SwiftUI main thread 占有による cmux 側 deadlock（upstream #2586、v0.63.2 で read 系は未修正）の影響を受けないよう、Conductor / Master / Agent の生存確認を PID ベース（`process.kill(pid, 0)`）と独自 hook（`SESSION_STARTED` / `SESSION_IDLE` / `SESSION_CLEAR` / `SESSION_ENDED`）に一本化。`monitorConductors` は starting/disconnected タイムアウトと forceClose のみを担当するシンプルなループになった。`cmux tree` が残るのは `getPaneForSurface` / `getPaneIdForSurface` による init 時の pane 逆引きのみ。`cmux.ts` から `validateSurface` / `validateSurfaceDetailed` / `VALIDATE_SURFACE_*` を削除し、代わりに `isAlive(pid)` を追加
- **Agent プロセスにも SessionStart hook を追加し PID を daemon に通知（T195）**。`generateAgentSettings` に Conductor と同等の hook を追加。`schema.ts` `AgentState` に `pid?: number` を追加し、`spawnAgentPidWatcher` が 1 秒間隔で生存確認 → 死亡時に done マーカーを書き出して `cmux-team await-agent` 側に crashed を通知する。これにより `cmux-team send-agent` の送信先生存確認、および Manager 再起動時の team.json 復元も PID ベースになった
- **`master.ts isMasterAlive` のシグネチャ変更（T195）**: `isMasterAlive(surface, workspace?)` → `isMasterAlive(projectRoot)`。`.team/team.json` の `master.pid` を読み `cmux.isAlive(pid)` を返す実装に書き換え。`daemon.ts:466 startMaster` も合わせて更新し、Master resume 時に `state.masterPid` 復元 + `spawnMasterPidWatcher` 起動をこの関数内で行う。マーカー経路失敗時はマーカーファイル削除 → 新規 `spawnMaster` にフォールバック
- **Manager 再起動直後は team.json 復元時の PID が OS 側で再利用されるリスクあり（T195、既知の限界）**: `cmux-team stop && cmux-team start` の間にカーネルが同じ PID を別プロセスに再割り当てしていた場合、`cmux.isAlive(pid)` は `true` を返し `initializeLayout` / `startMaster` が死んだ Conductor / Master を alive と誤認する。発生確率は低い（PID 最大値 × 短時間隔）が、確実に避けるには `cmux-team stop` 後、即座に `cmux-team start` せず新規 Claude セッションを spawn し直すこと。将来的には `isAlive` を「`kill(pid, 0)` + `ps -p pid -o comm=` が `claude` を含む」に拡張する余地あり（今回は採用しない）
- **削除ログイベント**: `monitor_tree_failed` / `conductor_unresponsive_started` / `conductor_unresponsive_threshold` / `conductor_responsive_recovered` / `monitor_skip_agents` / `kind=cmux_unresponsive`。`CMUX_TEAM_UNRESPONSIVE_MAX_TICKS` / `CMUX_TEAM_UNRESPONSIVE_MAX_SEC` 環境変数も廃止（T180 で導入されたが tree 呼び出しが無くなるので不要）

### Changed

- **conductor テンプレート (ja/en) の Agent 監視ループを await-agent + exit code ベースに全面書き換え（T195）**。T181 で導入済みだった `cmux-team await-agent` がテンプレートに未反映だった箇所を同期。`cmux list-status` の cN キー diff + 30 秒ポーリングを廃止
- **docs 同期**: `CLAUDE.md` / `SKILL.md` / `docs/spec/01,04` / `.team/specs/requirements.md` から `cmux list-status` を使う旨の記述を削除または置換し、PID ベース監視に統一

---

## 8. リスクと軽減策

| リスク | 影響 | 軽減策 |
|---|---|---|
| Agent SessionStart hook の `$PPID` が意図した Claude PID を返さない | spawnAgentPidWatcher が即死して Agent が起動直後に crashed 判定 | 実装後に 1 Agent 起動 → `ps -p <pid>` で目視確認（§2.2 Q1）。問題あれば hook で `pgrep -P $PPID -x claude` / `ps -p $PPID -o ppid=` などの補正コマンドに差し替え（§2.2 Q1 に具体的な代替コマンドを列挙済み） |
| Manager 再起動時 team.json に pid 永続化されていても PID は OS で再利用され得る | 別のプロセスを Conductor / Master と誤認 | team.json の更新頻度（tick ごと）で最新化されており、再起動直後の一瞬だけのリスク。かつ Conductor / Agent は `claude` プロセスのため `ps` で判別可能。心配なら `isAlive` を将来「`kill(pid, 0)` + `ps -p pid -o comm=` が `claude` を含む」に拡張可。今回は採用しない（割り切り）。CHANGELOG Breaking 項目で明記 |
| `cmux-team send-agent` 呼び出し時に team.json の `agents[].pid` が未反映 | 起動直後の Agent への送信が reject される | Step 8 で 200ms × 3 回リトライを実装（合計 600ms 待機）。Conductor が `spawn-agent` → `await-agent` → `send-agent` の順序で直列呼び出しする現行運用なら発生しないが、並列ワークフロー化した場合の保険 |
| SESSION_CLEAR → SESSION_STARTED 間の隙間で monitorConductors が disconnected 化 | UI のちらつき | ステップ 6 で明示的な pid クリア + §3 D5 で monitorConductors が PID ベース判定を行わないため、そもそも起きない |
| spawnPidWatcher の 1 秒間隔が Conductor 数に比例して負荷増 | 負荷増の可能性 | 最大 3 Conductor + 数 Agent 程度。interval は fork/exec なしの `process.kill` 1 call なので無視できる負荷 |
| テストで real timer を使うと遅くなる | CI / テスト遅延 | §5.2 で named export + `__testSpawnPidWatcherTick` 方式に統一し、real timer 依存をなくす。fake timer / sleep(1100) 方針は不採用 |
| 他プロジェクト（Dear / mado 等）の `.team/team.json` には pid が無い | 既存環境で resume 時に全 Conductor が disconnected になる | Breaking リリースとして CHANGELOG に明記。resume で disconnected 表示される場合は一度 `cmux-team stop && cmux-team start` すれば SESSION_STARTED で復旧することを案内 |
| `cmux.validateSurface` 公開 API の削除で外部プラグイン / スクリプトが壊れる | 可能性低（内部関数） | `cmux.ts` は内部モジュール。export を使う外部利用者は存在しない前提 |
| `startMaster` のマーカー経路 PID 化で Manager 再起動時に Master 復旧に失敗するケース増 | Master の再 spawn が走る（1-2 秒のコスト） | 従来の「surface 生存だけ」より厳しい条件になるが、正しい挙動。失敗時は自動で新規 spawn にフォールバックするためユーザー影響は起動遅延のみ |

---

## 9. 完了条件チェックリスト

- [ ] `grep -rn "cmux\.tree\|await tree" skills/cmux-team/manager --include="*.ts" | grep -v "\.test\.ts" | grep -v "getPaneForSurface" | grep -v "getPaneIdForSurface"` が **空**
- [ ] `grep -rn "validateSurface" skills/cmux-team/manager --include="*.ts"` が **空**（テストファイル含む。テストからも削除）
- [ ] `grep -rn "isMasterAlive" skills/cmux-team/manager --include="*.ts"` の結果が **`master.ts` の定義 1 行 + `daemon.ts:startMaster` の呼び出し 1 行のみ**（pid ベース実装 + projectRoot シグネチャになっていること）
- [ ] `grep -n "cmux\.isAlive\|readTeamJson" skills/cmux-team/manager/master.ts` が **`isMasterAlive` の実装を含む**
- [ ] `grep -rn "cmux list-status" CLAUDE.md skills/cmux-team/SKILL.md docs/spec/ skills/cmux-team/templates/ .team/specs/` が **空**（注記付きの歴史記録が残る場合はそれのみ）
- [ ] `grep -rn "UNRESPONSIVE_MAX\|treeFailureCount\|treeFailureFirstAt\|cmux_unresponsive" skills/cmux-team/manager --include="*.ts"` が **空**
- [ ] `bun test` が green
- [ ] `cmux-team start` で Master + Conductor x3 が起動、`cmux-team create-task` でタスク割り当て、Conductor が完走して idle に戻る基本シナリオが動く（手動 smoke テスト）
- [ ] `kill -9 <conductor_pid>` で 1 秒以内に `session_ended reason=pid_watcher` ログ + Conductor が disconnected になる
- [ ] `/clear` 実行時に `session_clear` → `session_started` が連続で出て、disconnected を経由しない
- [ ] Agent を `kill -9` すると `cmux-team await-agent` が exit 10 (crashed) で返る
- [ ] Manager 再起動シナリオ: `cmux-team start` で Conductor 稼働 → `cmux-team stop` → `cmux-team start` で team.json から復元 → `manager.log` に `master_restored ... pid=<N>` が出る（新規 spawn ではなくマーカー経由で復旧）→ その Master を `kill -9` すると `spawnMasterPidWatcher` が 1 秒以内に検出してログする
- [ ] `CHANGELOG.md` の `[3.47.0]` セクションに 2 項目（Changed Breaking + Changed）追加済み
- [ ] docs 6 ファイル（CLAUDE.md / SKILL.md / spec 01, 04 / templates ja,en conductor.md / requirements.md）同期済み

---

## 10. 未実施の TODO（本タスク範囲外として plan.md に記録）

- upstream #2586 へのコメント追記（プロンプト明記でスコープ外）
- proxy trace 併用による「ハング中 Claude」検出強化（別タスク）
- `cmux read-screen` の Trust 確認検出経路は deadlock リスクを抱えたまま残る。将来的に hook + proxy で置き換え検討
- 他プロジェクト（Dear / mado 等）の resume 時の破壊的互換は release ノートで案内する運用で対応
