# T283 検品レポート

## Verdict: GO

## Summary

plan.md ST1 〜 ST15 の全サブタスクが期待通り実装され、34 テスト pass / 全 836 テスト pass / 新規型エラー 0 件・pre-existing 3 件の主張も検証済み（`conductor.ts:201` は T283 の import 追加で L197 から L201 にずれた同一エラー、`daemon.test.ts:3720` / `daemon.ts:1538` も pre-existing で一致）。Critical 0 件、Major 0 件、Minor 2 件のため GO 判定。minor はいずれも impl-report / CLAUDE.md 側のドキュメントドリフトで、実装の動作には影響しない。

## Findings

### Finding 1 — [minor] CLAUDE.md のログイベントテーブルが実装と乖離

**場所**: `CLAUDE.md:671-676`（「Ready 昇格時の sync state ガード § ログイベント」表）

**内容**:
- `ready_rejected` / `ready_warning` の detail 列に `sync_state=<state>` と書かれているが、実装は `state=<state>`（`main.ts:2772` / `main.ts:2780`）。grep/検索時の混乱を招く。
- `ready_sync_skipped` の detail 列に `reason=<env|no_main_branch>` が記載されていない（実装は `main.ts:2748` / `main.ts:2758` で `reason=` を emit）。

**影響**: ドキュメントの不整合のみ。ランタイム挙動には影響なし。

**推奨修正**:
```diff
-| `ready_rejected` | reject state で exit 1 | `task_id=<NNN>` `phase=<create\|update>` `sync_state=<state>` |
-| `ready_warning` | warn state で継続 | `task_id=<NNN>` `phase=<create\|update>` `sync_state=<state>` |
-| `ready_sync_skipped` | `CMUX_TEAM_SKIP_SYNC_CHECK=1` で skip | `task_id=<NNN>` `phase=<create\|update>` |
+| `ready_rejected` | reject state で exit 1 | `phase=<create\|update>` `state=<state>` `task_id=<NNN>` |
+| `ready_warning` | warn state で継続 | `phase=<create\|update>` `state=<state>` `task_id=<NNN>` |
+| `ready_sync_skipped` | env / config で skip | `phase=<create\|update>` `reason=<env\|no_main_branch>` `task_id=<NNN>` |
```

### Finding 2 — [minor] plan.md ST15 の手動検証シナリオが impl-report に部分的にしか記載されていない

**場所**: `impl-report.md:75-186`（「検証結果」セクション）

**内容**: plan.md の完了条件 (6) は「手動再現手順ドキュメント化」を要求しており、ST15 でシナリオ 1-10 を列挙している。impl-report は以下を記録している:
- ✅ シナリオ 5 相当（uncommitted ライブ実行）: シナリオ 6 の実演で確認
- ✅ 全 7 state の分岐: `git-sync.test.ts` 34 pass で網羅
- ✅ `resolveFetchBeforeWorktree` の env / default / throw: シナリオ 5 で確認
- ✅ `--force` / env bypass 経路: `runSyncCheckOrExit` の全経路ソース確認（シナリオ 7）
- ❌ シナリオ 2 (behind-ff), 3 (ahead), 4 (diverged), 6 (detached), 7 (no-remote), 8 (--force), 9 (env bypass), 10 (Agent 経路からの起票) のライブ実行結果

**影響**: pure function テストで全 7 state を網羅しており、CLI 統合は `runSyncCheckOrExit` のコードレビューで確認可能。実害は小さい。ただし plan.md の完了条件上は「impl-report に記載」が要求されている。

**推奨修正**: impl-report.md に「ライブ実行の一部は git state を破壊的に作り替える必要があるため pure function テスト + コードレビューで代替した」旨を明示的に追記する。本 inspect-report でもカバー扱い。

## 検証結果

### 1. 計画充足（ST1 〜 ST15）

| ST | 内容 | 結果 |
|----|------|------|
| ST1 | `git-sync.ts` pure function 実装 | ✅ 301 行。`decideSyncState` / `classifyVerdict` / `collectSyncFacts` / `checkSyncState` export 済み、分岐順序も plan 通り |
| ST2 | `git-sync.test.ts` 単体テスト | ✅ 34 pass / 0 fail、全 7 state + `on-other-branch` 入力を網羅 |
| ST3 | `resolveFetchBeforeWorktree` を `config.ts` に追加 | ✅ L114-127、`resolveAutoUpdateMode` と同構造、デフォルト ON / env で opt-out / throw すべて実装 |
| ST4 | `conductor.ts` の worktree 作成経路を更新 | ✅ L354 で `resolveFetchBeforeWorktree().enabled` に置換。旧 `process.env.CMUX_TEAM_FETCH_BEFORE_WORKTREE === "1"` の直書き参照は 0 件 |
| ST5 | `cmdStart` に `fetch_before_worktree` ログ | ✅ `main.ts:513-517` で emit。D14 通り `event-name + key=value` 形式 |
| ST6 | `cmdCreateTask` に sync check | ✅ `main.ts:2809-2814` で `runSyncCheckOrExit` 呼び出し |
| ST7 | `cmdUpdateTask` に sync check | ✅ `main.ts:2926-2932` で `runSyncCheckOrExit` 呼び出し、L2924 の `if (newStatus !== undefined)` 直下に挿入 |
| ST8a | Conductor shell init に env 注入 | ✅ `conductor.ts:109` の export 列に `CMUX_TEAM_SKIP_SYNC_CHECK=1` を追記 |
| ST8b | `cmdSpawnAgent` exportVars に env 無条件追記 | ✅ `main.ts:2345` で exportVars 配列に追記（Agent は独立 surface なため Conductor env 継承不成立の対応） |
| ST9 | `self-update` は意図的に skip | ✅ impl-report に記載 |
| ST10 | help テキスト更新 | ✅ i18n.ts の ja/en 両方に `--force` / `--skip-fetch` / `CMUX_TEAM_SKIP_SYNC_CHECK=1` 説明追加 |
| ST11 | Master テンプレートのポリシー緩和 | ✅ ja/en 両方で git 読取・fetch・`pull --ff-only` を「やること（追加）」に移動、書き込み系は禁止維持 |
| ST12 | CLAUDE.md 更新 | ✅ デフォルト ON 記述 + 「Ready 昇格時の sync state ガード」新節 + ロギングポリシー更新（Finding 1 あり） |
| ST13 | docs/spec/ 同期 | ✅ `04-templates.md:91-93` Master ワンライナー更新、`05-install-and-infrastructure.md` デフォルト ON 反映 |
| ST14 | CHANGELOG.md | ✅ Unreleased に Breaking 2 件 + Added 1 件 |
| ST15 | 手動検証シナリオ | △ impl-report に部分記載のみ（Finding 2） |

### 2. Dead/Zombie Code

- 旧 `process.env.CMUX_TEAM_FETCH_BEFORE_WORKTREE === "1"` の直書き参照: **0 件**（`config.ts:117` の `env.CMUX_TEAM_FETCH_BEFORE_WORKTREE` は `resolveFetchBeforeWorktree` 内部の正当な env parsing）
- 未使用 import: tsc --noEmit で未検出（T283 touched files に新規警告なし）

### 3. テスト

- `bun test git-sync.test.ts`: **34 pass / 0 fail / 68 expect()**（19ms）
- `bun test` (manager 全体): **836 pass / 0 fail / 2000 expect()**（37.42s）
- 既存テスト（`worktree-base.test.ts` 等）も破壊なし

### 4. 設計原則

- ✅ `runSyncCheckOrExit` による DRY 化（cmdCreateTask / cmdUpdateTask 両方で同ヘルパを呼ぶ、重複ロジック 0 件）
- ✅ `git-sync.ts` の pure function 分離: `decideSyncState` / `classifyVerdict` が純関数、`collectSyncFacts` が async、`checkSyncState` が束ねる一発 API
- ✅ Verdict の exhaustive switch: `git-sync.ts:140-143` で `const _exhaustive: never = state` パターン。state 追加時にコンパイル時に気付ける
- ✅ git コマンドの stub 可能性: `collectSyncFacts` が `opts.git` を受け取る

### 5. 統合

grep 検証結果（全てヒット）:

```
main.ts:2338,2345,2724,2745  — CMUX_TEAM_SKIP_SYNC_CHECK（cmdSpawnAgent exportVars + runSyncCheckOrExit env 判定）
conductor.ts:106,109          — CMUX_TEAM_SKIP_SYNC_CHECK（launchConductor shell export）
main.ts:56,513               — resolveFetchBeforeWorktree（import + cmdStart emit）
conductor.ts:17,354           — resolveFetchBeforeWorktree（import + doFetch 解決）
config.ts:114                 — resolveFetchBeforeWorktree（関数定義）
main.ts:2730,2763,2764,2809,2926  — checkSyncState / runSyncCheckOrExit
main.ts:515                   — fetch_before_worktree（ログ emit）
main.ts:2740,2747,2757,2771,2779  — ready_force_bypass / ready_sync_skipped (×2) / ready_rejected / ready_warning（全 4 イベント）
```

### 6. 型エラーゼロ化 — touched files

**T283 後**（`bunx tsc --noEmit` 実行）:

```
conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3720,9): error TS2322: Type '"new_session"' is not assignable to ...
daemon.ts(1538,22): error TS2352: Conversion of type 'string | undefined' ...
```

**T283 前**（`git stash push -u` → tsc 実行 → `git stash pop`）:

```
conductor.ts(197,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3720,9): error TS2322: Type '"new_session"' is not assignable to ...
daemon.ts(1538,22): error TS2352: Conversion of type 'string | undefined' ...
```

- `conductor.ts:197` → `conductor.ts:201` へ 4 行ずれ（T283 で `resolveFetchBeforeWorktree` import 追加による）。同一の `TS1016: A required parameter cannot follow an optional parameter` エラーで **pre-existing 確定**
- `daemon.test.ts:3720` / `daemon.ts:1538` も前後で行番号一致、pre-existing 確定

**新規型エラー: 0 件**（T283 touched files に新規警告なし）

### 7. 手動検証シナリオ

impl-report 記載分:
- ✅ **シナリオ 5 相当 (uncommitted ライブ reject)**: main repo の実状態（on-main + dirty）で `verdict=reject state=uncommitted`、メッセージに `uncommitted` + Bypass hint が含まれることを確認
- ✅ **シナリオ 7 `runSyncCheckOrExit` の全経路ソース確認**: 5 経路（非 ready / forceFlag / env skip / no_main_branch skip / checkSyncState 実施）
- ✅ **`resolveFetchBeforeWorktree` の live**: default/off_env/on_env/bogus_throws すべて想定通り

impl-report 未記載分（Finding 2）:
- ❌ behind-ff / ahead / diverged / detached / no-remote のライブ実行
- ❌ `--force` / env bypass の CLI live
- ❌ シナリオ 10 (Agent 経路) の実 CLI 実行

**Inspector 追加検証**:
- `cmdSpawnAgent` の exportVars 配列 (main.ts:2339-2346) に `CMUX_TEAM_SKIP_SYNC_CHECK=1` が**無条件で**追加されていることを Read で確認。これにより Agent surface は常に env を持ち、シナリオ 10 の「Agent からの起票で main が uncommitted でも skip される」が**コード上は確定**
- 34 テストで全 state の decide/classify 分岐が網羅されており、CLI 統合は `runSyncCheckOrExit` のコードレビューで確認済み

### 8. ドキュメント更新

- ✅ CLAUDE.md 「Ready 昇格時の sync state ガード（T283）」節あり（L629-676）
- ✅ CLAUDE.md `CMUX_TEAM_FETCH_BEFORE_WORKTREE` 記述がデフォルト ON 前提（L775-778）
- ✅ ロギングポリシー「必ずログすべきイベント」に #5 として T283 の 4 ログイベント追加（L345）
- ✅ Master テンプレート（ja/en）のポリシー緩和済み（ja L13-34 で「やること（追加）」「やらないこと（基本方針）」構造化、git 書き込み系のみ禁止）
- ✅ CHANGELOG.md Unreleased に Breaking 2 件 + Added 1 件
- ✅ docs/spec/04-templates.md L91-93 で Master ワンライナー更新
- ✅ docs/spec/05-install-and-infrastructure.md で「デフォルト OFF」記述 0 件
- △ CLAUDE.md のログイベントテーブル detail 列が実装と乖離（Finding 1）

---

**総合判定**: Critical 0 + Major 0 + Minor 2 → **GO**

本 T283 はコード品質・テスト・設計原則の観点で期待を満たしている。Finding 1（CLAUDE.md のログ detail 列の実装との乖離）と Finding 2（impl-report の live run 記載不足）は minor で、マージ後の小規模 follow-up で吸収可能。
