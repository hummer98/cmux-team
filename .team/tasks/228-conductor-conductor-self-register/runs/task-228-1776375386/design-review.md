# T228 Design Review

## Verdict: Changes Requested

## Summary

方針自体（登録責務を `cmdConductor` / `cmdResume` に移す）は根本対策として妥当で、サブタスク分割・Decision Log も網羅的。ただし **S6（fallback 削除）が resume 経路の state pre-population を壊す** という構造的な破壊変更を含んでおり、plan のリスク表と S6 の説明自体が自己矛盾している。本実装に進めば resume タスクの taskId/taskRunId/worktreePath が state に反映されず、ダッシュボード・PID watcher・SessionStart 経路が壊れる。併せて D3 soft cap の判定条件も plan 文面では実質デッドコードになる。

## Findings

### 1. [Critical] S6（fallback 削除）が resume 経路を壊す — main.ts:696-718 の前提が失われる

**問題**:
`main.ts:696` の `initializeLayout(...)` 直後、main.ts:699-718 は `state.conductors.get(r.surface)` で既存エントリを取得して taskId/taskRunId/worktreePath/taskTitle/status を書き込む（`c.taskId = r.taskId; ...`）。この取得が成功するのは、現状 `initializeConductorSlots` の fallback ブロック（`conductor.ts:239-267`）が state に**同期的に**エントリを pre-set しているため。

S6 でこの fallback を削除すると、resume 経路では以下のタイミングになる:
1. `launchConductor` が pane に `cmux send 'cmux-team resume <id>'` を投入（非同期。pane が読んで bun/cmdResume を起動するまで数秒かかる）
2. `initializeLayout` が即座に return
3. **main.ts:699-718 のループ実行 — この時点で `state.conductors` は空**
4. `state.conductors.get(r.surface)` → undefined → `resume_assignment_missing_conductor` ログで continue
5. 結果: resume 対象の Conductor に taskId/taskRunId/worktreePath が **永久に反映されない**
6. 後で cmdResume の self-register POST が届く → daemon は `{ status: "starting", agents: [] }` を set — 依然 taskId 不在

これは plan の risk table が主張している「**resume 前の `initializeConductorSlots` が先に state を作り**、あとで `cmdResume` から POST が届いても skip される」（plan.md:204）と真っ向から矛盾する。S6 は「**initializeConductorSlots が state を作る唯一の箇所**」を削除しているため、この前提は成立しない。

**影響範囲**:
- `cmux-team start` 実行時に assigned タスクを resume する経路全般（T5 の E2E ケース）
- dashboard が taskId 無しの Conductor を "running" として表示できず、結果的に resume した Conductor が "idle" 扱いになる可能性（main.ts:710 で `c.status = "running"` する箇所も skip されるため、`CONDUCTOR_REGISTERED` handler が set した `"starting"` のまま）
- SessionStart hook が届いたとき taskId 不在のため trace DB への task-session 索引が壊れる

**修正案（いずれか）**:
- (A) S6 のうち **resume 側**の fallback（`conductor.ts:244-256` の if 分岐）は残す。非 resume 側のみ削除する。
- (B) S6 を完全削除せず、`initializeConductorSlots` 内に「resume 時のみ state を pre-set」する明示的なブロックを新設する（fallback ではなく primary path として）。
- (C) main.ts:699-718 を `state.conductors.get(...)` + mutate から `state.conductors.set(r.surface, { ...full state... })` に変更し、pre-population に依存しないようにする。さらに cmdResume 側の self-register POST（既存 skip）がこの set を壊さないことを S5 で保証する。
- (D) `CONDUCTOR_REGISTERED` メッセージに任意で taskId/taskRunId/worktreePath を持たせ、cmdResume が POST 時に同梱する。daemon handler は「既存あり → skip、無ければ POST payload からセット」に統合する。

本タスクの trigger「任意 surface からの手動 conductor」だけを見れば (A) が最小差分。(C) は resume 責務を main.ts に一本化でき見通しが良い。(D) は schema 変更を伴うので範囲拡大。どれを取るかは実装者判断だが、plan 文面での明示が必要。

---

### 2. [Critical] D3 soft cap の発動条件が plan 文面では現実に発火しない

**問題**:
plan.md:144 は「`CMUX_TEAM_MAX_CONDUCTORS` が**設定されており**現在の Conductor 数が既にそれ以上の場合、警告ログのみ出す」としている。しかし `daemon.ts:192-195` では:
```ts
const envMax = process.env.CMUX_TEAM_MAX_CONDUCTORS;
const maxConductors = envMax !== undefined && envMax !== ""
  ? Number(envMax)
  : LAYOUT_MAX_CONDUCTORS[layout];
```
env 未指定でも `state.maxConductors` は layout 既定値（wide=3, 16x9=2）で確定している。env の有無を条件にすると、**デフォルト運用（env 未設定）で soft cap 警告が永久に発火しない**。これはタスク本文の「想定外の数が登録されても動作するか確認。必要なら `CMUX_TEAM_MAX_CONDUCTORS` を登録時の soft cap として使うか、無制限にするかを決める（推奨: まずは無制限＋警告ログ）」の意図に反する。

**修正案**:
S5 の判定条件を「env 設定の有無」ではなく「`state.conductors.size >= state.maxConductors` を超えた新規登録」に変える。ログイベント名は現状の `conductor_register_over_cap` のままで可。これで wide デフォルト 3 + 4 個目追加でも警告が出るようになり、本タスクの目的（「任意 surface からの手動追加」を検知可能にする）に整合する。

---

### 3. [Major] `launchConductor` の mainBranch 引数が `cmdSpawnConductor` 経路で未解決

**問題**:
`main.ts:1807-1813` の `cmdSpawnConductor` は `launchConductor(PROJECT_ROOT, surface)` を opts 無しで呼んでいる（現行コード）。S4 で launchConductor は `mainBranch` を env に焼き付ける責務を維持する設計（`opts?.mainBranch ?? "main"`）なので、`cmux-team spawn-conductor` 経路では常に `CMUX_TEAM_MAIN_BRANCH=main` が焼き付けられる。

これは T228 の変更点ではないので**本タスクのスコープ外**だが、以下の点で plan の検証項目を満たさない:
- plan の risk table（206行目）は「spawn-conductor 経路は cmdConductor → self-register が走るため問題ない」と主張。self-register の整合性は OK だが、**main branch 解決は env 経由が第一ソース**（cmdConductor:1610-1611）なので、"main" 以外のブランチを使うプロジェクトで `cmux-team spawn-conductor` を叩くと誤ったブランチで worktree が作られる可能性がある。
- 既存バグの疑いあり。T228 の scope で扱うかは plan に明記が必要（少なくとも「既知の未修正箇所として残す」と決定するなら Decision Log に追加）。

**修正案**:
- スコープ外として明示する（推奨）。または
- S1.5 として `cmdSpawnConductor` でも `resolveMainBranch()` して `launchConductor` に渡すよう修正する。

---

### 4. [Minor] S5 の skip 判定の観測性が弱い

**問題**:
plan.md:143 は「既存あり: `conductor_register_skipped` で記録し break」とする。しかし「なぜ既存があったのか」を追跡するためのキー（`status`, `taskId`, `pid` 等の snapshot）がログに無い。T3（/clear 後 disconnected 経路）での挙動を後で追跡する際、既存 state が `running` か `disconnected` かで取るべき action が変わる（PID watcher が動いてる／いない、SessionStart で復帰可能か等）。

**修正案**:
S5 の skip ログに `existing_status=${existing.status} existing_pid=${existing.pid ?? "null"}` を含める。既存 state が `disconnected` だった場合の復帰シーケンス（E3 で触れている PID watcher 経由の新 PID 設定）がログだけで追跡できる。

---

### 5. [Minor] CONDUCTOR_REGISTERED ハンドラの自動テスト欠落

**問題**:
`daemon.test.ts` には `CONDUCTOR_REGISTERED` のハンドラテストが **0 件**（`grep -c "CONDUCTOR_REGISTERED"` = 0）。handleMessage の他ブランチ（SESSION_STARTED / SESSION_ENDED / SESSION_STOP 等）は充実しているのに、本タスクで変更する箇所のテストだけが空白。S7（型チェック）だけでは D2 の「重複 skip」が将来壊されないことを保証できない。

**修正案**:
S5 に以下のユニットテスト追加を義務化（所要時間 < 30 分）:
- 新規 surface からの CONDUCTOR_REGISTERED → state.conductors に set される
- 既存あり + 同 surface からの 2 回目 → skip ログ、status/taskId/agents が破壊されない
- `state.conductors.size >= state.maxConductors` 超過 → warning ログが出て登録自体は成功

---

### 6. [Minor] fail-fast メッセージの粒度

plan.md:82 の fail-fast 発火条件が `resolveProxyPort()` の返り値 undefined。しかし `resolveProxyPort` は以下 3 ケース全てで undefined を返す:
- `.team/proxy-port` ファイル不在（daemon 未起動）
- ファイルあり + TCP 接続失敗（proxy 死亡）
- ファイル内容空／数値ではない（壊れたファイル）

plan.md:81 のエラーメッセージ「daemon が起動していません (.team/proxy-port 不在 or proxy 死亡)」は上記の 1-2 を両方カバーしているが、3 が orphan。ユーザーが「port file あるのに起動していないと言われた」で混乱する可能性あり。

**修正案**:
S1 で `resolveProxyPort()` の失敗理由を呼び出し側に返すか、あるいは `registerSelfAsConductor` 側で追加のファイル存在 check を挟む。または本メッセージに「壊れた proxy-port ファイルの場合は `.team/proxy-port` を削除して `cmux-team start` をやり直してください」の一行を追加する。

---

## Recommendations（修正の優先度順）

**P1（Changes Requested の主因。対応必須）**:
- **Finding 1**: S6 を修正し resume 経路の state pre-population を保つ。最小差分は (A) — `conductor.ts:244-256` の resume 分岐だけ残し、非 resume 分岐（258-265）のみ削除する。plan.md の risk table 2 行目（resume 時の二重登録）の説明も (A) と整合するように書き換える。
- **Finding 2**: S5 の soft cap 判定条件を「env の有無」ではなく「`state.conductors.size >= state.maxConductors` 超過時」に変更。plan.md:144 の D3 記述を書き換える。

**P2（品質向上。同一 PR で対応推奨）**:
- **Finding 5**: S5 に daemon.test.ts への 3 ケースのユニットテスト追加を含める。
- **Finding 4**: skip ログに `existing_status` / `existing_pid` を含めるよう S5 を具体化。

**P3（スコープ外明示 or 小修正）**:
- **Finding 3**: `cmdSpawnConductor` の `launchConductor` 呼び出しで `mainBranch` を渡さない問題は、Decision Log に「既知の未修正箇所として残す」か、S1.5 として S1 と同じ PR に含めるか、決定する。
- **Finding 6**: fail-fast メッセージに proxy-port 破損ケースの案内を追加（1 行追加で済む）。

上記 P1 2 件を解決した修正版 plan が提出されれば Approved 可能。CRITICAL チェック項目のうち「統合テスト/検証」「既存テストへの影響」が不完全な状態のまま着手すると、実装中盤で resume が動かないことが判明して手戻りが大きい。
