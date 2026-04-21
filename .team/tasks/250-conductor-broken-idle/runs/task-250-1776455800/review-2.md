---
reviewer: design-reviewer (round 2)
task: T250
plan: .team/tasks/250-conductor-broken-idle/runs/task-250-1776455800/plan.md
artifact_ref: A015
reviewed_at: 2026-04-18
prior_review: review-1.md
---

## Verdict: Approved

（ただし Major 1 件・Minor 3 件を Findings に記載。いずれも実装者が ST 実施時に追加対応すれば解消可能な範囲であり、
plan.md の再改訂は要求しない。最終レビューのため、実装時に本 Findings を必ず吸収すること）

## Summary

Rev1 の Critical (R1) および Major (R2–R4) は **全て plan.md 改訂版 (rev2) に反映済み**。
特に R1（CONDUCTOR_DONE 流用 → CONDUCTOR_CLEAR 新設）は ST-1.5 / ST-8A / ST-8B / D3 の
4 箇所に一貫して展開され、`daemon.ts:986-992` の `no_task` guard 回避も明文化されている。
Minor (R5–R7) も ST-14 unit test 化・ST-12 i18n key 形式明記・ST-7 コメント追加・Risks 5.4 + D13
で解消済み。

新たに 1 件の Major（SESSION_ENDED / SESSION_ASK / SESSION_STOP の broken ガード漏れ）を発見したが、
本 plan.md の D9 の intent（「SESSION_\* ハンドラには broken の早期 return を追加 / 自動復帰の可能性を
完全に塞ぐ」）と矛盾しており、実装者は D9 の intent に従って ST-3 を拡張すれば対応できる。
Critical ではないため Changes Requested には昇格しない。

## Reflection on Previous Findings

| # | Rev1 Finding | 対応する Recommendation | 判定 | 反映箇所 |
|---|--------------|-------------------------|------|----------|
| F1 | [critical] clear-conductor の CONDUCTOR_DONE 経路が no_task guard で早期 break | R1 (Critical) | **Resolved** | ST-1.5 新設（CONDUCTOR_CLEAR schema）/ ST-8A 新設（専用 handler）/ ST-8B 書き換え（postMessage 型変更）/ D3 注記 / ST-13 テスト 4〜6 追加 |
| F2 | [major] ST-2 に 2 案併記（直書き vs 案 A） | R2 (Major) | **Resolved** | ST-2 (3) に「cleanup 直書き展開案は削除（R2 対応: 案 A 一本化のため削除）」と明記。「直書き」の文言は ST-2 から消えた。ST-7 のコード例も `opts.targetStatus` 一本で書かれている |
| F3 | [major] `conductor_broken` ログが forceClose + resetConductor の 2 箇所から出る | R3 (Major) | **Resolved** | ST-2 (3) で `log("conductor_broken")` 直書きを「削除すること」に分類。ST-7 のコード例で `conductor.status === "broken" ? "conductor_broken" : "conductor_reset"` の三項演算を導入。D12 新設。検証コマンドで `rg 'log\("conductor_broken"' ... \| rg -v .test.ts` が **1 件のみ**であることを確認する形に変更 |
| F4 | [major] broken × SESSION_* 全バリアントの回帰テスト不足 | R4 (Major) | **Resolved**（Rev1 スコープ内）| ST-13 テスト 3 を SESSION_STARTED (source=startup/resume/clear/compact の 4 バリアント) + SESSION_ACTIVE + SESSION_IDLE + SESSION_CLEAR に拡充。ただし SESSION_ENDED / SESSION_ASK / SESSION_STOP は未カバー（後述 Findings #1） |
| F5 | [minor] team.json round-trip の単体テスト不在 | R5 (Minor) | **Resolved** | ST-14 を「手動 E2E 記述のみ」から「unit test + 疑似コード」に昇格。`updateTeamJson → readFile → restoreConductors` の往復検証を明示 |
| F6 | [minor] ST-12 の i18n ヘルプ本文と実装形態の乖離 | R6 (Minor) | **Resolved** | ST-12 に「ja/en 両 dict」「既存 `help_abort_task` / `help_restart_task` と完全に同形式」「必要に応じて `type HelpKey` union にも追加」の 3 点を明記。検証コマンドも ja/en 両方ヒット要件に変更 |
| F7 | [minor] disconnectedAt の非対称挙動にコメント欠落 | R7 (Minor) | **Resolved** | ST-7 コード例に「broken の場合のみ disconnectedAt を UI 用に残す」コメント追加。「clear-conductor 経路では if で undefined に落ちるため古い値は混入しない」の注記も入った |
| F8 | [minor] sessionId 保持の記述が実装済み挙動との整合説明不足 | R7 (Minor) | **Resolved** | ST-2 (5) で「既存 resetConductor 挙動通り触らない（`conductor.ts:544` コメント参照）」に書き換え。「本 ST で追加作業なし」と明示 |
| F9 | [minor] T241 cascade との相互作用の記述欠落 | R7 (Minor) | **Resolved** | Risks 5.4 新設 + D13 新設。「cascade は ready 子を draft に戻すため broken への誤 assign 経路は構造的に存在しない」ことを明示 |

### CRITICAL チェック項目

| 項目 | Rev1 | Rev2 | コメント |
|------|------|------|---------|
| サブタスクカバレッジ | PASS | **PASS** | ST-1 / ST-1.5 / ST-2 / ST-3 / ST-4 / ST-5 / ST-6 / ST-7 / ST-8A / ST-8B / ST-9 / ST-10 / ST-11 / ST-12 / ST-13 / ST-14 / ST-15 で 8 ファイル全てをカバー |
| 統合テスト/検証 | PARTIAL | **PASS**（軽微な穴あり）| ST-13 で CONDUCTOR_CLEAR 経路の正常系・異常系（broken 以外 / not_found）unit test 追加。ST-14 で team.json round-trip unit test 追加。Findings #4 で指摘する「非 broken 状態 starting/assigning/asking 未カバー」は minor |
| 削除タスクの完全性 | PARTIAL | **PASS** | ST-2 (3) で `log("conductor_broken")` 直書き / `conductor.status = "broken"` 個別セット / cleanup 直書き展開案の 3 点を「削除すること」として明示。Rev1 の 2 案併記矛盾は消えた |
| 既存テストへの影響 | PASS | **PASS** | ST-13 (1) で既存 test "3. disconnect timeout で forced close" の期待値変更（`status="idle"` → `"broken"`、`disconnectedAt` 削除アサーション削除）を明記 |

## Findings

### 1. [major] SESSION_ENDED / SESSION_ASK / SESSION_STOP ハンドラが ST-3 の broken ガード対象から漏れている

**場所**: plan.md ST-3、`daemon.ts:1320-1398` (SESSION_ENDED) / `daemon.ts:1446-1479` (SESSION_STOP) / `daemon.ts:1582-1641` (SESSION_ASK)

**事実**:

ST-3 は 4 ハンドラ (`SESSION_STARTED` / `SESSION_ACTIVE` / `SESSION_IDLE` / `SESSION_CLEAR`) のみを
ガード対象に列挙しているが、`daemon.ts` の SESSION_\* 系ハンドラは実際には **7 種類** ある:

```
1059:  SESSION_STARTED    ← ST-3 対象
1320:  SESSION_ENDED      ← 未対象
1401:  SESSION_ACTIVE     ← ST-3 対象
1446:  SESSION_STOP       ← 未対象（SESSION_ASK / SESSION_IDLE に synthesize）
1481:  SESSION_IDLE       ← ST-3 対象
1582:  SESSION_ASK        ← 未対象
1643:  SESSION_CLEAR      ← ST-3 対象
```

特に SESSION_ENDED（`daemon.ts:1364-1366`）は:

```ts
conductor.status = "disconnected";
conductor.disconnectedAt = message.timestamp;
conductor.pid = undefined;
```

を **無条件に** 実行する。broken Conductor のペインをユーザーが手動で閉じる or Claude
セッションが何らかの理由で終了イベントを発火すると、broken → disconnected に遷移し、
さらに `disconnectedAt` が現在時刻に上書きされる。これは plan.md D9 の intent
「自動復帰の可能性を完全に塞ぐ」「SESSION_\* ハンドラには broken の早期 return を追加」と矛盾する。

同様に SESSION_ASK（`daemon.ts:1593-1596`）は:

```ts
conductor.askQuestion = message.question;
conductor.status = "asking";
if (message.pid) conductor.pid = message.pid;
conductor.disconnectedAt = undefined;
```

を実行する。broken 状態の Conductor に SESSION_ASK が届くと `status = "asking"` + `disconnectedAt = undefined`
で broken 痕跡が完全消滅する。SESSION_STOP は SESSION_ASK / SESSION_IDLE に synthesize
（`daemon.ts:1463-1477`）するため、SESSION_IDLE 側はガードされても SESSION_ASK 側が未ガードなら
実質的に抜け道が残る。

**影響度**:

- SESSION_ENDED: broken Conductor のペイン手動クローズ、Claude プロセスの異常終了通知などで
  broken → disconnected に戻る。その後 `monitorConductors` の disconnect timeout がまた発火して
  forceClose → broken に戻るという振動状態になる。実害は振動中のログ出力量増加程度だが、
  D9 の「broken 状態の不変性」が成立しない
- SESSION_ASK: broken 遷移時点で pid は undefined 済みのため、通常は発火しない。ただし
  hook 配送の遅延で stale SESSION_STOP → SESSION_ASK が届く可能性はゼロではなく、届けば
  broken が asking に化ける
- SESSION_STOP: 上記 SESSION_ASK 経由の間接リスクのみ

**severity 判断**: Major。D9 intent との矛盾は意図的でないと読める（ST-3 の列挙漏れと思われる）。
Critical には昇格させないのは、broken → disconnected の逆戻り自体はデータ破壊を起こさず、
clear-conductor CLI の基本経路（broken → idle）は機能するため。

**必要な実装対応**（plan.md 改訂は不要、実装者が ST-3 / ST-13 実施時に吸収する）:

1. ST-3 の対象ハンドラに **SESSION_ENDED (`daemon.ts:1320` 付近) / SESSION_ASK (`daemon.ts:1582` 付近)** を追加し、
   同形式の broken 早期 break ガードを入れる:
   ```ts
   if (conductor.status === "broken") {
     await log(
       "session_event_ignored_broken",
       `${formatSurface(conductor.surface, "C")} event=SESSION_ENDED reason=broken_requires_manual_clear`
     );
     break;
   }
   ```
2. SESSION_STOP は直接 conductor を触らない（SESSION_ASK / SESSION_IDLE に synthesize するのみ）ため、
   SESSION_ASK と SESSION_IDLE にガードが入っていれば追加対応不要。ただし broken Conductor が
   SESSION_STOP を受けた場合に classify 実行自体を skip するほうが安全（`session_stop_dropped reason=broken`
   で break するのが理想）
3. ST-13 の回帰テスト 3 に **SESSION_ENDED** / **SESSION_ASK** / **SESSION_STOP** の 3 バリアントも追加し、
   broken Conductor が status 不変（broken のまま）であることを検証する
4. ST-3 の「検証コマンド」`rg 'session_event_ignored_broken' skills/cmux-team/manager/daemon.ts | wc -l`
   を **6 件** に更新（現状 4 件 → SESSION_ENDED/ASK/STOP 追加で 7 件、ただし STOP は `session_stop_dropped`
   のため別 key にするなら 6 件）

### 2. [minor] ST-3 の broken ガード挿入位置が曖昧（SESSION_STARTED / SESSION_ACTIVE の場合、"分岐の前" の解釈で disconnectedAt が wipe されうる）

**場所**: plan.md ST-3、`daemon.ts:1080-1103` (SESSION_STARTED) / `daemon.ts:1422-1425` (SESSION_ACTIVE)

**事実**:

ST-3 は「既存の `disconnected/starting/assigning/asking` 分岐の前 に broken ガードを追加する」と書いているが、
SESSION_STARTED / SESSION_ACTIVE には **if/else-if 分岐の前に "無条件" の状態変更行がある**:

- SESSION_STARTED `daemon.ts:1100-1103`:
  ```ts
  conductor.pid = message.pid;
  conductor.disconnectedAt = undefined;
  notifyStateChanged(...);
  spawnPidWatcher(state, conductor, message.pid);
  ```
  （これらは status ブランチ `daemon.ts:1082-1096` の **後** なので "前" 解釈では影響なし。ただし
  「ハンドラ全体の先頭（`if (conductor) {` 直後）」ではなく「status if/else 連鎖の前」と読むと、1082 行目挿入
  となり、無条件行はその後で実行される。この場合 pid 再設定 + spawnPidWatcher が走るため、broken でも
  PID watcher が再起動してしまう（broken の意味が薄れる）
- SESSION_ACTIVE `daemon.ts:1424-1425`:
  ```ts
  conductor.disconnectedAt = undefined;
  if (message.pid) conductor.pid = message.pid;
  ```
  こちらは **status ブランチの 前** に無条件行がある。"分岐の前" を 1426 行目と解釈すると、
  broken の disconnectedAt が wipe される

**severity 判断**: Minor。実装者がコードを読めばどちらの位置が意味的に正しいか判断できる
（＝ `if (conductor) {` 直後に置くのが唯一整合する）。ただし Rev2 で明示しておけば迷わない。

**必要な実装対応**:

ST-3 の文言を「`if (conductor) {` 直後（ハンドラ内で conductor を取得した直後、
既存の無条件フィールド変更も含めて丸ごとスキップする位置）に broken ガードを追加する」と明記する
（plan.md の改訂はしなくても、実装者がこの review-2 を読んでいれば対処できる）。

### 3. [minor] ST-13 テスト 5 が非 broken 状態の全パターンを網羅していない

**場所**: plan.md ST-13 テスト 5（"CONDUCTOR_CLEAR が broken 以外の Conductor に来たら無視される"）

**事実**: テスト 5 は `idle / running / disconnected` の 3 状態のみを列挙しているが、
`ConductorState.status` の union は 7 種類ある（starting / assigning / idle / running / asking / disconnected / broken）。
broken を除いた **6 状態全て** に対して `conductor_clear_ignored reason=not_broken` が出ることを
検証するほうが網羅的。

ただし ST-8A の handler ロジックは `if (conductor.status !== "broken")` の単純判定なので、
3 状態で動けば残り 3 状態でも確実に動く。ST-1 で status union が拡張されたときの回帰検知を
強化する観点では全 6 状態をループで回すテストが望ましい。

**severity 判断**: Minor。実装者判断で全 6 状態にループ展開して良い。plan.md 改訂は不要。

### 4. [minor] ST-2 が `forceCloseDisconnectedConductor` の既存 Step 2 (pidWatcherInterval clearInterval) の保持を明示していない

**場所**: plan.md ST-2 (4)、`daemon.ts:2243-2247`

**事実**:

現在の `forceCloseDisconnectedConductor` は 3 ステップ構成:

1. task-state.json aborted 書き込み + cascade（daemon.ts:2199-2241）
2. `clearInterval(pidWatcherInterval)` + `pidWatcherInterval = undefined`（daemon.ts:2243-2247）
3. `resetConductor(conductor, projectRoot, workspace)`（daemon.ts:2249-2250）

ST-2 (4)「残すこと」は Step 1 のみを明記し、Step 2 に言及していない。
ST-2 (1) は「関数全体の責務を... resetConductor を broken targetStatus で呼ぶ に縮退」と書いているため、
実装者が Step 2 を削除してしまう恐れがある。Step 2 は pidWatcher のメモリリーク防止のため必須で、
`resetConductor` 内には pidWatcher 停止処理は含まれていない（`conductor.ts:487-551` に該当処理なし）。

**severity 判断**: Minor。ST-2 (1) を素直に実装すれば 2 行の clearInterval が落ちる可能性はあるが、
既存テスト（`daemon.test.ts` の pid watcher 起動を検証するテスト）で検知される想定。

**必要な実装対応**:

ST-2 (4)「残すこと」に「`clearInterval(pidWatcherInterval)` + `pidWatcherInterval = undefined`
（daemon.ts:2243-2247）は **そのまま残す**。resetConductor は pidWatcher 停止処理を持たないため、
forceClose 側で行う必要がある」の 1 行を加える。

## 総評

- **Critical R1 / Major R2-R4 は全て反映済み** — Rev1 で指摘した「CONDUCTOR_DONE no_task guard で
  clear-conductor が機能しない」という致命欠陥は、新 message 型 CONDUCTOR_CLEAR と専用 handler の
  導入で構造的に解決された
- **Minor R5-R7 も全て反映済み** — team.json round-trip unit test 化 / i18n key 形式明記 /
  コメント追加 / cascade 言及が Decision Log + Risks に入った
- **Rev2 で Rev1 に無かった要素**: ST-1.5 新設（schema の message 型追加）、ST-8A / ST-8B の分離、
  D12 / D13 の新設、改訂履歴表の追加 — 全て R1-R7 対応と整合する最小限の追加
- **実装時の追加要件** - 本 review-2 で指摘した Major 1 件 + Minor 3 件:
  1. ST-3 拡張: SESSION_ENDED / SESSION_ASK（および必要に応じて SESSION_STOP）にも broken ガードを追加
  2. ST-3 ガード位置: `if (conductor) {` 直後に配置（無条件フィールド変更より前）
  3. ST-13 テスト 5 を非 broken 全 6 状態ループ化
  4. ST-2 で `clearInterval(pidWatcherInterval)` の保持を明示

この 4 点は **実装者が本 review-2 を参照すれば独力で吸収できる範囲** であり、
plan.md の 3 巡目改訂は要求しない（最終レビュー）。Rev2 plan.md 本文は approved とし、
実装 ST-3 / ST-13 / ST-2 の中で本 Findings を吸収することを条件に着手可。

## Recommendations

該当なし（Verdict: Approved のため）。実装時の追加要件は「総評」末尾の 4 点を参照。
