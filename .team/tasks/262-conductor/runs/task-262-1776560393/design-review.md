# T262 Design Review

## 判定

**Changes Requested**

## 総評

Phase 1 のスコープ限定（純粋関数化 + 網羅テスト、状態削減や XState 化は別タスク）は適切な判断。A014 の遷移表と A015 の fail-stop / best-effort 境界を前提に、`transition(state, event) → { next, effects }` に抽出する基本構造も健全で、「guard のうち時間・PID 判定は呼び出し側で済ませイベント化」という §2.2 の線引きは正しい（Date.now / process.kill を純粋関数に持ち込まない点は A011 type の deadlock 対策とも整合する）。テーブル駆動テストで A014 §2 の 25 遷移 + `broken` 関連を揃える方針も妥当。

一方で、plan.md には実装時に詰まる構造的な穴がいくつかある。特に **(a) `CONDUCTOR_CLEAR` が `FsmEvent` 定義から漏れており `broken → idle` の唯一の復帰経路が FSM 外に残る点（§2.1 と §2.4 の記述不整合）**、**(b) `applyTransition` が state mutation を先に適用してから effect を実行する設計と、fail-stop effect 例外時の rollback 戦略の齟齬**、**(c) T251 の `resetConductor` 内部昇格（surface_missing → broken）で `transition()` の返す `next.status` と実結果が乖離しうる点** の 3 つは Blocker。設計方針を決めてから着手しないと、Phase 1 完了時に「FSM 通るパスと通らないパスが混在」のまま残る恐れがある。

また、現行実装には A014 §2 の 25 遷移表に明記されていない到達可能遷移（例: `asking` 中の `SESSION_ENDED` → `disconnected`、`handleConductorDone` の late_cleanup 経路）があり、「A014 を真に受けて 25 ケース書けば終わる」わけではない。A014 が v3.53.0 スナップショットであることは plan.md §2.4 で言及されているが、差分吸収は `broken` 以外についても必要。以下の個別指摘で列挙する。

## 個別指摘

### 【Blocker】B1. `CONDUCTOR_CLEAR` イベントが `FsmEvent` 定義から欠落している

- **問題**: plan.md §2.1 の `FsmEvent` discriminated union に `CONDUCTOR_CLEAR` が含まれていない。しかし §2.4 最後で「`broken` からの復帰は `CONDUCTOR_CLEAR` メッセージのみ」と明記しており、FSM の網羅範囲と齟齬がある。
- **影響**: `broken → idle` の唯一の復帰パス（`daemon.ts:1238-1265`）が FSM 外の直接代入として残る。Phase 1 のゴール「散在する `conductor.status = ...` の置換」が達成できない。テスト §5.4「broken 状態での全イベント → no-op」も「`CONDUCTOR_CLEAR` だけ例外的に idle に戻る」ケースの assert ができない。
- **推奨修正**:
  - `FsmEvent` に `{ type: "CONDUCTOR_CLEAR"; reason?: string; at: string }` を追加。
  - A014 遷移表 + broken 関連ケースに「`broken` + `CONDUCTOR_CLEAR` → `idle` + effects: [`resetConductor`, `notifyStateChanged`, `log conductor_reset`, `requestWakeup`]」を追加（`daemon.ts:1263` の `requestWakeup(state)` も effect にする必要あり、下記 m2 参照）。
  - §5.5「非対象」から除外するか、対象として扱うかを明記する。

### 【Blocker】B2. `applyTransition` の mutation-first 設計と fail-stop effect 例外時の rollback が両立していない

- **問題**: plan.md §3 Step 4 の `applyTransition` 擬似コードは「`conductor.status = next.status` 等を先に適用」→「`effects` を順に実行」の順序。§R1 では fail-stop effect（`resetConductor` / `abortTask` / `forceCloseDisconnected`）で例外時は「`applyTransition` から throw し、`handleMessage` の catch で state を `disconnected` に倒す」としている。しかし例外時点で `conductor.status` は既に `next.status`（例: `idle` / `running`）に書き換わっており、`disconnectedAt` / `pid` / `sessionId` も更新済み。catch 側で単に `status = "disconnected"` を書くだけでは `pid` や `disconnectedAt` の整合が崩れる（`pid` は新値のまま、`disconnectedAt` は undefined のままで disconnect_timeout 判定が通らなくなる等）。
- **影響**: 現行挙動の「資格情報だけ更新 → reset 失敗 → status は元のまま残る」（例: `daemon.ts:1986-2022` の SESSION_CLEAR + running 経路）を保てない。現行挙動不変という §1 の前提が破れる。特に `conductor.disconnectedAt` は `disconnect_timeout` 判定の基準になるため、残留値ひとつで誤検出・幽霊 Conductor が復活する可能性がある。
- **推奨修正**: 次のいずれかを採用し、設計方針として plan に明記する。
  1. **effect-first**: effect を先に実行し、例外が無ければ最後に state mutation を commit する。ログ順序が現行と変わるため移行前に `log_order` を A014 参照で確認。
  2. **state snapshot rollback**: `applyTransition` 内で更新前の state をスナップショットし、throw 時に復元する。catch 側は追加 effect（`disconnectedAt = now`, `status = "disconnected"`）を適用する責務のみ。
  3. **fail-stop を transition() に含めない**: `resetConductor` 等の fail-stop effect は `applyTransition` の外で呼び、純粋関数化から外す（plan.md §6 が `main.ts:798` と `resetConductor` を据え置きにしているのと同じ方針を Step 5 にも広げる）。

### 【Blocker】B3. `resetConductor` 内部の `surface_missing → broken` 昇格（T251）が FSM 表現から漏れる

- **問題**: 現行 `resetConductor`（`conductor.ts:548-564`）は冒頭で `cmux.getPaneForSurface` を呼び、surface 不在なら `effectiveTargetStatus = "broken"` に昇格する。plan.md §3 の設計では `transition()` が `next.status = "idle"` と決定しても、effect 実行時に `resetConductor` が内部で `broken` に書き換える。結果として FsmState と実 ConductorState の status が乖離する。
- **影響**: 表駆動テストで `result.next.status === "idle"` を assert しても、実際の conductor は broken になる。`conductor.status` の真の source of truth が「FSM の決定」なのか「effect runner の動的昇格」なのか不明瞭になる。Phase 1 のゴールである race 根絶と逆行する。
- **推奨修正**:
  - surface 実在確認を effect runner から **transition() の呼び出し側** に引き上げる。`handleMessage`（or `monitorConductors`）が `cmux.getPaneForSurface` を呼んだ結果を `{ type: "CONDUCTOR_CLEAR"; surfaceMissing: boolean }` や `{ type: "FORCE_CLOSE" }` の判定材料として事前に組み立て、event を分岐させる。
  - もしくは FsmContext の入出力として `resetConductor` の結果（最終 status）を transition が知る仕組みを設ける。いずれにせよ「`next.status` = 最終 status」の不変条件を保つ。
  - 加えて `conductor_broken` / `conductor_reset` のログ分岐を effect runner に完全委譲しているなら、FSM の log effect type 列とログ出力点が 1:N になる点もテスト方針（§5.1 effect 列検証）に影響する。

### 【Major】M1. `log` effect の `detail` 文字列生成に必要な情報が `FsmState` に揃っていない

- **問題**: 現行ログ生成は `formatConductorSnapshot(conductor)`（`pid`/`alive`/`lastHookAt`/`taskRunId` などを展開）や `cmux.isAlive(pid)` を参照する。§2.1 の `FsmState` は `pid` / `sessionId` / `startedAt` / `disconnectedAt` / `lastHookAt` を持つが `alive` は外部 I/O（`process.kill`）。純粋関数で `log` effect の detail を組み立てるなら、`isAlive` 結果を event に含めるか、effect の detail 生成を effect runner に委譲するかの設計決定が必要。
- **影響**: 純粋関数化の利点（fake-timer なしテスト）と現行ログフォーマット不変の両立が曖昧。「ログフォーマット不変を担保するテストを書く」§5 で何を比較するかが決まらない。
- **推奨修正**:
  - `log` effect のペイロードを `{ type: "log"; event: string; ctx: { ...state 投影 } }` にし、detail 文字列は effect runner で `formatConductorSnapshot` を呼んで組み立てる。transition 側は「どの event 名でどの ctx を出すか」だけを返す（detail 文字列比較ではなく構造比較）。
  - 参考: `PID_DEAD` event を組み立てる側が `alive` 情報を持っているので、event 側に `snapshot: { pid, lastHookAt, ... }` を含めて transition にも渡す設計も可。

### 【Major】M2. `handleConductorDone` の late_cleanup 経路（running 以外 + taskRunId truthy）が FSM 表現に漏れている可能性

- **問題**: A014 遷移表 #11 は「`running` または `taskRunId !== null`（late_cleanup 経路）」を明記。現行 `daemon.ts:handleConductorDone` は `disconnected` + taskRunId ありでも cleanup を実施する。plan.md §2 では `CONDUCTOR_DONE` 遷移の扱いを「running → idle」ベースで書いており、`disconnected`/`asking`/`assigning` からの CONDUCTOR_DONE の扱いが不明。
- **影響**: disconnected 復帰中に CONDUCTOR_DONE が届くケース（実例: T244 類似）で、現行は reset するが FSM では no-op になる可能性。§5.4「冪等性」テストでは検出できない。
- **推奨修正**: 表駆動テストに以下ケースを追加。
  - `disconnected` + taskRunId truthy + `CONDUCTOR_DONE(taskRunId 一致)` → `idle` + `resetConductor` effect
  - `idle` + `CONDUCTOR_DONE` → no-op（`no_task` guard 経路）
  - `asking` + `CONDUCTOR_DONE` → 現行挙動を事前に grep で確認し、仕様として固定化

### 【Major】M3. A014 §2 の 25 行に含まれない到達可能遷移を明示的に扱う

- **問題**: plan.md は「A014 §2 の 25 行 + broken 関連 5 遷移」を網羅するとしているが、現行 daemon.ts には A014 に記載のない到達可能な挙動が少なくとも以下ある:
  - `asking` 中の `SESSION_ENDED`（`daemon.ts:1624-1648` は status guard なしで `conductor.status = "disconnected"` に倒す）
  - `asking` 中の `SESSION_CLEAR`（上記 §2.4 では触れられていない）
  - `starting` / `assigning` 中の `SESSION_ENDED`（reason ≠ other でも現行は条件なしで disconnected）
  - `SESSION_ENDED` の `surface mismatch`（`daemon.ts:1627-1633` の `session_ended_ignored`）
- **影響**: これらを表駆動テストに含めないと、「FSM 化後に挙動が変わっていないこと」を担保できない。統合テスト（daemon.test.ts）でたまたま通っているだけでは、race fix（T254/T255/T260/T261）の再発検出が弱い。
- **推奨修正**:
  - 表駆動テストの case 列挙を「A014 §2 の 25 行」ではなく「現行 `handleMessage` で到達可能な (status × event) の組」に広げる。`rg -n "conductor\.status"` と `handleMessage` の switch 階層から逆引きし、現行到達可能セルを列挙する付録を plan に追加する。
  - 追加された遷移のうち A014 と整合しないものは、A014 の更新 or FSM 側の挙動変更のどちらを取るかを Phase 1 前に決める。

### 【Major】M4. FSM 外に残る代入経路一覧が plan に無い

- **問題**: plan.md §6 で `main.ts:798`（team.json 復元）と `conductor.ts:605`（resetConductor 内部）を据え置きとしているが、他に FSM 経由しないパスが残る可能性がある（例: `initializeConductorSlots` の resume 経路で `status = "running"` pre-populate、fallback master → conductor 昇格など）。
- **影響**: Phase 2 の「FSM に引き上げ」計画時に、残存代入箇所の全体像が無いと抜け漏れが発生する。race 検出の根治にもならない。
- **推奨修正**: plan.md §6 に「FSM 外に残す代入箇所の確定リスト」を付録として列挙し、各箇所について「Phase 2 で引き上げ」「恒久的に FSM 外」のタグを付与する。`rg -n "conductor\.status\s*=\s*" skills/cmux-team/manager` の出力を出発点にする。

### 【Major】M5. effect 列の「順序まで厳密一致」検証は保守性が著しく低い

- **問題**: plan.md §5.1 で「`result.effects` の type 列が expected 列と順序含めて一致（`toEqual` で deep 比較）」を採用している。ログイベントの軽微な追加・順序入れ替え・detail 文字列微調整で数十テストが壊れ、変更コストを押し上げる。実際 T260 では `conductor_disconnected` を出す順序（pid クリア前後）を小刻みに調整しており、この種の調整のたびにテーブルテストが red になる運用は継続困難。
- **影響**: 保守コストが実装メリットを上回る。Phase 2 への refactor が進まなくなる。
- **推奨修正**: 検証方針を階層化する。
  - **必須**: destructive effect（`resetConductor` / `abortTask` / `forceCloseDisconnected` / `updateTaskSession` / `spawnPidWatcher`）の **有無** と相対順序（資源取得系 → 破壊系 の order）。
  - **任意**: log effect の event 名存在（順序は検証しない、`expect(effects).toContainEqual(expect.objectContaining({ type: "log", event: "conductor_ready" }))` 程度）。
  - **不要**: log detail 文字列の完全一致、`notifyStateChanged` の source 文字列。
  - この方針を §R3 テスト責務表に追記する。

### 【Minor】m1. `CONDUCTOR_REGISTERED` の idempotent merge は transition の対象外

- `CONDUCTOR_REGISTERED` は state を **新規作成**する経路（`daemon.ts:1191-1236`）で、「既存 state がある場合 no-op」は transition の守備範囲ではない（`transition(state, event)` に渡す state が既に存在する前提のため）。plan.md §3 Step 2 の Case 1 で「(新規) → starting」を扱う書き方になっているが、現実装では new path（`state.conductors.set`）は `handleMessage` 側に残す必要がある。表駆動テストで扱うなら「既存 state あり + CONDUCTOR_REGISTERED → no-op + merge ログのみ」にケースを揃えるのが無難。

### 【Minor】m2. `requestWakeup` を effect に追加する

- 現行 `daemon.ts:1263` は CONDUCTOR_CLEAR 後に `requestWakeup(state)` を呼ぶ（idle 昇格後すぐ scanTasks を走らせるため）。B1 の修正で CONDUCTOR_CLEAR を FSM 化する際、`{ type: "requestWakeup" }` effect を追加するか、effect runner で暗黙に呼ぶかを明記する。

### 【Minor】m3. `AGENT_SPAWNED` 受信時の `broken_conductor_still_alive` ログ（`daemon.ts:1288-1296`）の扱い

- plan.md は `AGENT_SPAWNED` を FSM 対象外としているが、現行は「broken 状態で AGENT_SPAWNED を受けた場合に警告ログを出す」条件付き副作用を持つ。FSM 化しない場合でも「agents 配列 push + status 依存の警告ログ」の責務を `handleMessage` 側に残すことを明記する（さもないと transition 化の過程で消失する恐れ）。`conductor_caller_alive` 系（T260）も同様。

### 【Minor】m4. `SESSION_ENDED reason=other` の record-only の扱いを effect 列で明示

- plan.md §2.3 は「呼び出し側で弾き transition まで到達させない」としているが、`insertHookSignal` は handleMessage 入口で常に呼ばれる（CLAUDE.md「hook 全送信ポリシー」）。pipeline を「hook_signals insert → classify reason=other → transition skip」と図示して、record-only が FSM 前段で完結することを明記する。§5.5「非対象」節でも reason=other は「handleMessage が `session_ended_other_ignored` ログを出す」と触れるとレビュー時の齟齬が減る。

### 【Minor】m5. Mermaid 遷移図を plan.md に同梱する

- A014 は v3.53.0 時点の Mermaid 図のみ。plan.md では `broken` 追加・CONDUCTOR_CLEAR 追加を行うため、差分版の Mermaid 図を §2.4 に置くと、レビュー・実装時の相互参照コストが下がる。

### 【Minor】m6. `PID_DEAD` event の stale ガード

- 現行 `__testSpawnPidWatcherTick`（`daemon.ts:2254-2276`）は `conductor.pid !== pid` のとき `stale` を返し state を触らない。FSM 化した場合、`PID_DEAD` event に `pid` を含めて、transition 側で `state.pid === event.pid` を guard するか、呼び出し側で pre-filter するかを決める。plan.md §2.2 の「PID 生存は `PID_DEAD` をそのまま渡す」方針と合わせてケースを明記。

## Recommendations

Planner に戻す際、優先順に以下を修正してください（Blocker 3 項と Major 5 項は実装前に必須）。

1. **B1 を最優先**: `FsmEvent` に `CONDUCTOR_CLEAR` を追加し、`broken → idle` 遷移を `transition()` の網羅に含める。§2.1 の discriminated union と §5.4「broken 冪等性」テスト設計を更新。理由: 追加しないと Phase 1 ゴール（`conductor.status = ...` 置換）が未達で残る。
2. **B2 で applyTransition の mutation/effect 順序と rollback 戦略を決定**: effect-first / snapshot rollback / fail-stop 除外の 3 案から選定し plan §3 Step 4 と §R1 を書き直す。理由: 選定を保留したまま実装すると、`disconnectedAt` や `pid` の残留で disconnect_timeout 誤検出が再発する恐れがあり、T244 クラスの再発を引き起こす。
3. **B3 で surface_missing 昇格の責務分離**: `resetConductor` 内部の surface 実在確認を `handleMessage` / `monitorConductors` に引き上げるか、effect runner の返り値で `next.status` を補正する設計に決める。理由: FSM の `next.status` と実 status が乖離すると、表駆動テストが実質的に検証力を失う。
4. **M1 で log effect の detail 生成責務を effect runner に寄せる**: `log` effect を `{ type: "log"; event: string; ctx }` とし、detail 文字列は effect runner 側で `formatConductorSnapshot` 等を呼んで組み立てる方針を plan に追記。理由: 現行ログ不変を保証しつつ純粋関数の引数を最小化する。
5. **M2/M3 で網羅対象を A014 25 行から「現行到達可能な (status × event) セル」に拡張**: plan.md §3 Step 2 / §5.1 の網羅対象を「`rg "conductor\.status"` と `handleMessage` switch 階層から逆引きしたセル一覧」に更新。理由: A014 は v3.53.0 スナップショットであり、T250/T254/T255/T260/T261 の修正で増えた到達経路を吸収するため。
6. **M4 で FSM 外の残置代入一覧を plan §6 に付録化**: `main.ts:798` / `conductor.ts:605` の他にも据え置く箇所があるかを grep で洗い出し、Phase 2 で引き上げる / 恒久残置 の区分を付与。理由: Phase 2 の計画根拠になる。
7. **M5 で effect 列検証を階層化**: destructive effect は厳密順序、log は type 存在のみ、notifyStateChanged は無視、の方針を §5.1 と §R3 に明記。理由: 保守コスト上昇を回避し、Phase 2 refactor を阻害しない。

Minor 項目（m1〜m6）は実装着手後でも対応可だが、m1 と m2 は B1 修正と同時に片付けると手戻りが少ない。
