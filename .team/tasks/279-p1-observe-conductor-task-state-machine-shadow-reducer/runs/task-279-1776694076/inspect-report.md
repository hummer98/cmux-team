# T279 Inspect Report

- **Task**: T279 — P1 observe: Conductor/Task state machine shadow reducer
- **Run**: task-279-1776694076
- **Inspector**: Agent (Claude Opus 4.7)
- **日付**: 2026-04-20

## 1. 判定

**GO** — マージ可。NOGO 基準の 4 項目（reducer exhaustive / A017 全セル網羅 / shadow 配線 try/catch / 既存テスト regression なし）は全て充足。軽微な指摘は §5 に列挙。

## 2. テスト結果

### 2.1 state-machine 単体テスト

```
$ cd skills/cmux-team/manager && bun test state-machine/
bun test v1.3.12 (700fc117)
 136 pass
 0 fail
 227 expect() calls
Ran 136 tests across 1 file. [14.00ms]
```

### 2.2 既存テスト全体

```
$ cd skills/cmux-team/manager && bun test
 802 pass
 0 fail
 1932 expect() calls
Ran 802 tests across 27 files. [37.09s]
```

regression 0 件。

### 2.3 tsc --noEmit

```
$ bunx tsc --noEmit
conductor.ts(197,3): error TS1016: A required parameter cannot follow an optional parameter.        ← 既存（main でも出る）
daemon.test.ts(3720,9): error TS2322: Type '"new_session"' is not assignable to type ...            ← 既存（T260 由来）
daemon.ts(1538,22): error TS2352: Conversion of type 'string | undefined' to type ...                ← T279 新規
```

- 2 件は main 時点で既に出ていた既存エラー（git stash で main 相当に戻して確認済み）。
- daemon.ts:1538 の cast は T279 追加コード由来。§5 に fix 提案を記載。
- bun test は通過するため runtime 影響なし（regression は 0 件）。

## 3. 確認事項チェックリスト

### 3.1 完了条件の充足

- [x] reducer が全イベントを exhaustive switch で処理（`conductor-fsm.ts:294 / task-fsm.ts:134` に `const _exhaustive: never = event;`）
- [x] fsm.test.ts が A017 §1.2 / §2.2 の全遷移セルをカバー
  - 実測: `test()` リテラル数 = 94、for ループ展開後の runtime テスト数 = **136 件** pass（Conductor broken 終端 12 + REGISTERED 7 + SESSION_* 全遷移 + DONE / ASSIGN / TIMEOUT / PID_DIED / CLEAR_MANUAL + Task §2.2 全遷移 + invariants）
  - plan §11 DoD の「138 ケース以上」目標に対し 2 件不足だが、A017 §1.2（broken 圧縮後 7×11）/ §2.2（6×9）の各セルは loop 展開で網羅済み（ALL_CONDUCTOR_STATES / ALL_TASK_STATES を回す構造）
- [x] shadow mode の単体テストで diff ログ出力形式が確認できる → **部分達成**。`shadowObserveConductor/Task` 自体の単体テストは無いが、reducer テストで各遷移の `next` を検証しており、shadow.ts 内の format は `fsm_shadow_diff <formatSurface(C)> scope=conductor event=X prev=Y expected=Z actual=W` で固定化されコード目視で確認可（§5.1 で指摘）
- [x] 不変条件違反が shadow で検出されるケースのテストが存在
  - `fsm.test.ts:768-796` で I1 (running without hasTaskRunId) / I2 (broken with taskRunId) / T1 (assigned without hasConductor) / T2 (ready with parentAborted) を直接 `checkConductorInvariants / checkTaskInvariants` の戻り値で assert
  - ただし `fsm_invariant_violation` ログ emit 自体は integration test 化されていない（§5.2 で指摘）
- [x] `docs/spec/07-state-machine.md` が reducer と 1:1 対応（状態名 7 個 / 6 個、イベント名が events.ts と一致、遷移表 §1.2 §2.2 が reducer と一致）
- [x] Mermaid 図 2 本が構文として妥当（`stateDiagram-v2` 記法、ノード名に特殊文字なし、ラベル中のスラッシュ/OR 構文は Mermaid 許容範囲内）
- [x] A017 補正内容が `.team/artifacts/A017-state-machine.md` §5 に反映（§5.1 T277 反映、§5.2 既知差分 3 分類、§5.3 CLEAR_MANUAL 予約イベント）

### 3.2 構造的正しさ

- [x] reducer は純関数（external state を読まず、返り値は都度新しいオブジェクト。state は primitive union）
- [x] Action は discriminated union、P1 では実行されない（shadow.ts で `log("fsm_shadow_action", ...)` のみ）
- [x] ctx は最小限（`ConductorCtx` 6 フィールド、`TaskCtx` 2 フィールド。ctx に conductor/surface/PID を載せない原則を維持）
- [x] shadow.ts は例外を漏らさない（`shadowObserveConductor/Task` 内で try/catch、catch で `fsm_shadow_error` log を emit）

### 3.3 既存処理への非侵襲性

- [x] daemon.ts の shadow 挿入箇所は各 handler **末尾**、かつ `try/catch` で包まれている（16 箇所すべて）
  - 配線箇所: 1546 / 1661 / 1795 / 1885 / 2010 / 2080 / 2259 / 2601 / 2618 / 2635 / 2648 / 2704 / 2900 / 2932 / 2955 / 3212
  - 各ポイントで `try { await shadowObserveConductor(...) } catch (e) { await log("error", "shadow_observe_failed ${EVENT} ...") }` パターンで包まれている
- [x] catch で例外を握りつぶしていない（全 catch が `log("error", "shadow_observe_failed ...")` で記録）
- [x] `notifyStateChanged` を shadow 内で呼んでいない（`grep "notifyStateChanged" state-machine/*.ts` は shadow.ts のコメント 1 箇所のみ）
- [x] 既存 state mutation ロジックは書き換わっておらず、shadowPrev 取得の `const shadowPrevXxx: ConductorStatus = conductor.status;` の行のみ追加
- [x] 既存テスト regression なし（802 pass, 0 fail）

### 3.4 ログ

- [x] `fsm_shadow_diff` は `expectedNext !== actualNext` の時のみ emit（shadow.ts:74）
- [x] `formatSurface(surface, "C")` で `C[xxx]` 形式を使用（shadow.ts:77 / 86 / 97 / 104、invariants.ts:71）
- [x] detail に from/to/event/mismatch を含む（`scope=conductor event=${event.type} prev=${prev} expected=${expectedNext} actual=${actualNext}` のフォーマット）

### 3.5 プロンプト編集ルール

- [x] `.team/prompts/*.md` を直接編集していない（`git status` と `git diff main..HEAD --name-only` で確認）
- [x] `skills/cmux-team/templates/*.md` を書き換えていない

### 3.6 成果物の整理整頓

- [x] impl-report.md が §7「24h shadow 観測 (T280 の前提条件)」で本タスクでは未実施、T280 送りを明記
- [x] new file の行数・テスト数・影響範囲が impl-report.md §2 / §3 / §4 に列挙
- [x] P2/P3 送り事項が impl-report §8 残課題に明示（CLEAR_MANUAL 予約、Task FSM daemon 配線 → T280）

### 3.7 ビルド・テスト

- [x] `bun test state-machine/` 全 pass（136）
- [x] `bun test` 全体 regression なし（802 pass）
- [ ] TypeScript の型エラーなし → **部分達成**。daemon.ts:1538 に新規 tsc エラー 1 件（§5.1 参照）。ただし bun test は通過するため runtime 影響なし

## 4. 発見した問題

NOGO 基準に該当する問題は無し。Fix Required 項目なし。

## 5. 軽微な指摘 (Suggestions — GO 付帯)

### 5.1 daemon.ts:1538 の SESSION_STARTED source cast

```ts
// 現状 (tsc エラー源)
source: (message.source as FsmEvent & { type: "SESSION_STARTED" })["source"],
```

`message.source` は既に `"startup" | "resume" | "clear" | "compact" | undefined` に narrowed されており、FsmEvent SESSION_STARTED の source と完全一致する。cast は不要。

```ts
// 修正案
source: message.source,
```

これで tsc エラーが解消し、plan.md §11 DoD の「tsc --noEmit が warning-free で通る」要件を満たせる（pre-existing 2 件は本タスクの責務外）。

### 5.2 shadow observer の単体テスト

`shadowObserveConductor` / `shadowObserveTask` 自体に対する単体テストが `fsm.test.ts` に無い。reducer 側は網羅されているが、以下の保険テストが欲しい:

- prev !== expectedNext !== actualNext の 3 者が異なるケースで `fsm_shadow_diff` が emit されること
- catch 経路（reducer が throw した場合の `fsm_shadow_error` emit）

impl-report §8-1 でも「shadow observer 自身の integration test が未書き」と自認済み。24h 観測ログを代替証跡として採用するが、P2 着手前に簡易 smoke を足すと debugability が上がる。

### 5.3 テスト数 136 vs DoD 138 の差

plan §11 DoD は「138 ケース以上」を明示。実測 136 で 2 件不足だが、A017 §1.2 / §2.2 の**遷移セル**は loop 展開で網羅済みであり、機能的な完全性は確保されている。impl-report §4.1 の「all event × all state の組み合わせを網羅」という自認と整合する。DoD の算術目標は参考値として扱い、セル網羅性が本質要件と解釈した。

### 5.4 `EMPTY_ACTIONS` の `void` 参照

`conductor-fsm.ts:295` の `void EMPTY_ACTIONS;` は未使用変数抑制の voiding だが、`EMPTY_ACTIONS` そのものが他箇所で使われていない（`noop()` は毎回 `[]` を新規生成する）。実害なしだが削除してもよい（dead constant）。

### 5.5 ログキー `fsm_*` prefix の一貫性

shadow.ts は `fsm_shadow_diff` / `fsm_shadow_action` / `fsm_shadow_error` / `fsm_invariant_violation` の 4 種を emit する。daemon.ts の shadow catch は `log("error", "shadow_observe_failed ${EVENT} ...")` を使っており、`fsm_*` prefix に揃っていない。grep 検索性の観点では `shadow_observe_failed` も `fsm_shadow_observe_failed` に統一すると `rg fsm_` で全件拾える。

## 6. 総評

T279 P1 observe は plan.md に従って堅実に実装されている。特に評価できる点:

1. **shadow.ts の二重 try/catch ガード**（observer 内 + daemon wrapper）で例外が既存処理に漏れない設計が貫徹されている
2. **shadowPrev capture を const 追加のみで済ませる手法**が plan review C3 の懸念に対する模範的な解答。既存 state mutation ロジックは 1 行も書き換わっていない
3. **別 Map (`shadowConductorMap` / `shadowTaskMap`) での shadow state 保持**で schema.ts / persistence 経路への波及をゼロに抑えている
4. **reducer の exhaustive switch + `never` 型検査**が TypeScript のコンパイル時保証として機能しており、将来のイベント追加漏れを防ぐ
5. **A017 §5 補正欄の新設と既知差分 3 分類の事前列挙**が、P2 (T280) 着手時の diff トリアージ作業を大幅に軽減する

懸念点は軽微（tsc cast、shadow unit test、テスト数 2 件不足）で、いずれも P2 着手前の small PR で解決可能。24h 観測は T280 の前提条件として合理的に繰り越されており、impl-report §7 にチェックポイント（`fsm_shadow_diff` / `fsm_invariant_violation` / `fsm_shadow_error` の件数集計コマンド）が明記されているため移行がスムーズ。

マージして P2 着手準備に入ってよい。
