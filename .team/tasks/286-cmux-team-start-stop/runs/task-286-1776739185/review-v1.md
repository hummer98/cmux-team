# Design Review: T286 plan.md (v1)

## Verdict

**Changes Requested**

## Summary

plan.md の方向性（「全 discard fallback を initializeLayout 入口に 1 段分岐で追加する」＋「`cmux-team stop` 廃止で stop 依存ガイダンスを排除する」）は課題分析・根本原因・採用アプローチ共に妥当で、実コードとの行番号突き合わせもほぼ正確に取れる。特に §1.2 の A〜E マトリクス分析、§2.1 の「なぜ applyRestorePlan 外で分岐するか」、D3 の stop 即削除判断は筋が良い。一方で (a) M17 1 件では C-only / C+E 混在の fallback パスが未検証であり、(b) `applyDiscardOnly` 抽出に伴う `conductor_discarded` ログの条件分岐の保存契約が明示されておらず、(c) 書き換え後の `layout_mismatch_on_resume` 文言が fallback 発動ケースでは実挙動と齟齬する。また (d) fallback 経路での `resumePlan` / `plan.unmatchedResumes` の扱いが plan 上で暗黙になっており、エッジケース表にも欠落している。これらは実装前に plan 側で解消しておく方がコスト低。

## Findings

### Critical (これが残ると NOGO 相当)

1. **`applyDiscardOnly` 抽出時に `conductor_discarded` の reason フィルタ契約を失う危険**
   - **問題**: 現行 `applyRestorePlan` L1020-1027 は `plan.discarded` のうち **`reason === "surface_missing_no_task"` の行のみ** `conductor_discarded` をログする（C 経路由来の `reason=pid_dead_idle_cleanup` は除外される — これは C 経路が別途 `conductor_stale_surface_closed` を出すため）。plan §2.1 / S1 step 3 は「C/E ブロックを抽出して両方から呼び出す」と書いているが、この reason フィルタ条件が残ることを plan 本文で明示していない。抽出時に無造作にループを移植すると C 経路の行にも `conductor_discarded` が二重に出てしまい、M6/M7/M11 など既存テスト（`conductor_discarded` の appearance 数を assert していないにしろ、ログ出力仕様としての hidden contract）を破壊する。
   - **根拠**: `skills/cmux-team/manager/daemon.ts:1019-1027`（E 経路ログ）、`skills/cmux-team/manager/layout-restore.ts:117`（C 経路が discarded 配列にも `reason=pid_dead_idle_cleanup` で push されている事実）。
   - **影響**: 抽出後の挙動が壊れると、C 경로の pane が close されたのに「surface_missing_no_task で discard された」と誤ったログが追加で出る。事後解析で「surface は生きてたはずなのに何故 discard された？」の切り分けに混乱が出る。CLAUDE.md「ロギングポリシー」で決めている「判断分岐の可観測性」にも反する。
   - **対応**: plan §2.1 の `applyDiscardOnly` 仕様に「`plan.discarded` のループは `reason === "surface_missing_no_task"` の行のみ `conductor_discarded` を出力する」「C 경로由来 (`reason=pid_dead_idle_cleanup`) は close-surface + `conductor_stale_surface_closed` のみで済ます」を明記する。S1 step 3 の完了条件にも「reason フィルタ条件が `applyRestorePlan` 現行と bit-identical であること」の grep 検証を追加。

2. **`layout_mismatch_on_resume` 新文言が fallback 発動ケースで嘘になる**
   - **問題**: plan S2 は文言を "existing panes will be kept; restart cmux session to rebuild with the requested layout" に書き換える。しかし layout_mismatch ログは `planLayoutRestore` 実行より前の L1130-1137 で emit される（= 実際に kept されるか rebuild されるか未確定の段階）。本タスクの自己修復が走るケース（KDG-SSO 再現条件）では、既存 panes は **全消失 → fallback で新 slot 作成（= requested layout で自動 rebuild）** なので「existing panes will be kept」は事実に反する。
   - **根拠**: `skills/cmux-team/manager/daemon.ts:1130-1137` の emit 位置。plan §2.1 / §5.2 のエッジケース「`team.json` に 3 entry + 全 surface 消失 + 全 idle → fallback 発動」。
   - **影響**: 「自動 rebuild されたのにログでは『kept』と案内される」という矛盾が残る。2026-04-21 と同様の事案を別ユーザーが踏んだ際、manager.log を見た本人が「kept なら何故ペイン位置が変わったんだ？」と困惑する余地がある。また S2 の「既存 M14 assertion 変更不要」は正しいが、文言の**正確性**は別の問題として残る。
   - **対応**: 以下のいずれかに plan を改訂:
     - (a) layout_mismatch_on_resume の文言は「restored=... current=... — existing panes (if any) will be kept, missing ones will be recreated with current layout」のように両ケースを許容する中立文にする。
     - (b) layout_mismatch は「差異があった」事実のみ記録する純粋な観測ログに留め、復旧アクションの案内を書かない。fallback 発動時に `layout_restore_empty_fallback` が別途出るので、案内不要。
   - 推奨は (b)。`layout_mismatch_on_resume` は T255 当時からアクション案内を兼ねていたが、T286 で fallback が入ると事実ベースに戻す方が一貫する。

### Major (実装前に解消すべき)

3. **M17 1 件では fallback の 3 バリアントをカバーできていない**
   - **問題**: S3 で追加予定の M17 は「全 entry が surface 消失 (E のみ)」のみを検証する。しかし plan §5.2 エッジケース表に載っている通り fallback は以下 3 パターンで発動する:
     - (α) E のみ（= M17） — close-surface 副作用なし。KDG-SSO 現物。
     - (β) C のみ（= pid 全死亡 + surface 全実在 + 全 idle） — `applyDiscardOnly` が 3 回 close-surface を呼ぶ副作用あり。
     - (γ) C + E 混在 — 部分的に close-surface しつつ log 出力。
   - (β) と (γ) は fallback 判定条件（`alive + resumeExisting + resumeNewSurface = 0`）を満たすため同じフォールバック経路に入るが、実行する副作用と順序が E-only と異なる。抽出した `applyDiscardOnly` が (β)(γ) で正しく動くかの事前検証が自動テスト上で取れない。
   - **根拠**: plan §5.2 エッジケース表の 3 行目・6 行目で (β)(γ) の期待挙動が言語化されているが、対応する test ケースが S3 にない。
   - **影響**: 「`cmux tree` は live だが Claude プロセスだけ全滅 + idle で終えた」ケース（OS スリープ復帰後などで十分起こりうる）で、fallback の `applyDiscardOnly` の close-surface 順序が壊れていても CI で検出できない。後日同じバグが別のエッジで再発するリスク。
   - **対応**: S3 の test を M17 の 1 ケースから以下 3 ケースに拡張:
     - M17a: E-only fallback（KDG-SSO 再現）
     - M17b: C-only fallback（close-surface 3 回実行後に initializeConductorSlots）
     - M17c: C+E 混在 fallback
   - 最低限 M17a + M17b の 2 件は入れる。ヘルパ `applyDiscardOnly` の副作用がテスト可能な形で抽出されているなら、M17a〜c の共通セットアップで低コスト。

4. **fallback 経路での `resumePlan` / `plan.unmatchedResumes` 扱いが plan で未記述**
   - **問題**: fallback 発動条件は `plan.alive.length === 0 && plan.resumeExisting.length === 0 && plan.resumeNewSurface.length === 0` で、**`plan.unmatchedResumes.length > 0` のケースは排除していない**。team.json 非空 + 全 E + resumePlan に 2 件（unmatched）という混在シナリオでは、fallback が発動し `initializeConductorSlots(resumePlan)` が呼ばれて resumePlan が新 slot に割り当てられる — これは正しい挙動だが plan §2.1 の制御フロー記述では暗黙になっており、§5.2 エッジケース表からも抜けている。
   - **根拠**: `skills/cmux-team/manager/layout-restore.ts:134-140` の unmatchedResumes 集約ロジック、`skills/cmux-team/manager/conductor.ts:224-237` の `initializeConductorSlots` が resumePlan を panes と 1:1 で割り当てる挙動。
   - **影響**: plan が明示していないため、実装者が「fallback 発動時は resumePlan を捨てるべきか？」で迷うリスク。仮に resumePlan を空配列で呼び直してしまうと、assigned タスクが silently ready に戻らず消失する事故が起こる。
   - **対応**: plan §2.1 の制御フロー疑似コードに「`initializeConductorSlots(..., resumePlan, ...)` として既存 resumePlan をそのまま渡す（= `plan.unmatchedResumes` は initializeConductorSlots 側で panes に分配される）」を明記。§5.2 エッジケース表に「`team.json` 全 E + resumePlan 非空 → fallback 発動 + 新 slot に resume 割り当て」の行を追加。可能なら S3 のテストに「M17d: E + resumePlan 非空 の fallback で resume が正しく分配されるか」も足す。

5. **S1 step 2 の「cleanup/discard ログの順序保証」が plan で言語化されていない**
   - **問題**: 現行 `applyRestorePlan` では `state.conductors.clear()` → A ループ → C close → E log → B launch → D/unmatched の順で実行される。fallback 経路は「C close + E log（= applyDiscardOnly）」→「initializeConductorSlots（= pane 新規作成）」の順だが、close-surface と new pane 作成の順序が重要（pane 数が一時的に 6 になる瞬間を避ける）。plan §2.1 では順序を「fallback 前に必ず処理する」と書いているが、具体的に「close 全完了 → initializeConductorSlots」の待ち合わせ（sequential await）を保証する記述がない。
   - **根拠**: `skills/cmux-team/manager/daemon.ts:1010-1017` の C 경로 `await cmux.closeSurface(surface)` が sequential で回っている事実。
   - **影響**: 実装者が `Promise.all(plan.cleanup.map(closeSurface))` と並列化すると cmux 側に一時的な race（close 中に new pane 作成リクエストが入る）が生じうる。cmux 側の挙動は手元で再現が難しく、実運用で間欠的に壊れる恐れ。
   - **対応**: plan §2.1 の `applyDiscardOnly` 仕様に「plan.cleanup ループは `for (const s of plan.cleanup) await cmux.closeSurface(s)` の sequential 実行（既存 applyRestorePlan と同一）」を明記。S1 step 3 の完了条件にも `Promise.all` を使っていないことを grep で検証する 1 行を追加。

6. **CHANGELOG の `[Unreleased]` セクション位置と次リリースの同期**
   - **問題**: 現行 CHANGELOG.md は `[4.2.0] - 2026-04-21` が本日付で既に入り、`[Unreleased]` は空。plan S8 は `[Unreleased]` に 2 エントリ追加と書いているが、T286 のリリースタイミング（release スキル経由で別タスク）で `[Unreleased]` を `[4.3.0]` に昇格する前提になる。この前提が plan にも release タスク前提にも書いていない。
   - **根拠**: `CHANGELOG.md:1-12` の現状。
   - **影響**: リリーサが `[Unreleased]` をどう rename するか迷う・または `[Unreleased]` のままマージされて次リリース時に取りこぼすリスク。
   - **対応**: plan S8 に「`[Unreleased]` 以下に追記。リリース時（別タスク）に `[4.3.0] - <ISO date>` へ rename する」と明記。もしくは「本タスクでは `[Unreleased]` を使わず新バージョン見出しを直接作るのではなく、release スキル側の rename に任せる」を明示。

### Minor (実装後の cleanup 候補)

7. **`applyDiscardOnly` という名前が responsibility をやや狭く表現している**
   - **問題**: 「discard のみ」と書かれているが、実際は (a) C 경로の close-surface 副作用 + `conductor_stale_surface_closed` ログ、(b) E 경로の `conductor_discarded` ログ、の両方を実行する。C は close なので「discard」ではない。
   - **対応**: `applyStaleCleanup` / `applyPaneCleanupAndDiscardLogs` 等に改名を検討。あるいは「discard」はこのコンテキストで「conductor entry を state に登録しないで流す」という意味合いで定義し、コメントで明示。

8. **S7 `docs/spec/03-commands.md:7` の修正方針があいまい**
   - **問題**: §3.1 表に「旧仕様注記から `cmux-team stop` 削除（履歴的記述として整合させる）」とあるが、現行 L7 は「起動・停止・ステータスは CLI サブコマンド（`cmux-team start`, `cmux-team status`, `cmux-team stop`）に移行した」という歴史記述。ここから stop だけ削る（= 「起動・ステータスは...に移行した」）と日本語として「停止」が抜けて文意が崩れる。
   - **対応**: 削除ではなく「起動・ステータスは CLI サブコマンド（`cmux-team start`, `cmux-team status`）に移行した（停止は当初 `cmux-team stop` として実装されたが T286 で廃止）」のような注記追加に変更する。

9. **S7 `README.ja.md:182` のコードブロック整合**
   - **問題**: L178-183 は `cmux-team start` / `cmux-team send` / `cmux-team status` / `cmux-team stop` の 4 行コード例。plan は「1 行削除のみ」と書いているが、コメント `# graceful shutdown` も同時に残すと末尾が宙ぶらりんになる。
   - **対応**: 1 行削除後の 3 行コード例が自然に見える（他コマンドのコメント粒度と整合）か実装者が目視確認することを完了条件に追記。

10. **`pidfile.ts` 新文言の workspace 参照**
    - **問題**: plan S6 の新メッセージ "kill ${existingPid} first (or close the cmux session)." は workspace を含まない。現行は `at workspace=${workspace}` の後に続く文脈なので意味は通るが、「どの workspace の daemon か」は前半部分で既に明示されているので OK。`pidfile.test.ts:127-128` は `toContain("54321")` と `toContain(testDir)` のみなので assertion 更新は不要（既に workspace は前半部分に含まれる）。plan §5.1 の「test 影響 catch する」は実質不要だが、明示しても害はない。
    - **対応**: S6 完了条件に「pidfile.test.ts の assertion 修正は不要（前半部分に workspace 残存）」を追記。

11. **S4 で main.ts 冒頭コメント L11 の削除**
    - **問題**: plan S4 step 3 は該当行を削除と正しく記述。ただし L11 周辺は `./main.ts send SHUTDOWN` など関連行と並んでいるため、削除後のコメントブロックの読みやすさ（stop の位置だけ抜けて空行が残らないか）を目視確認する必要がある。
    - **対応**: S4 完了条件に「冒頭 JSDoc コメントブロックの空行整形を確認」を追加。

12. **D5「state-machine 化の後続タスク」の具体性**
    - **問題**: Decision D5 で「`LayoutRestoreReducer` + `LayoutRestoreEffects` に再分割する余地」が後続タスク候補として残されている。artifact 化（A00X）して後追いできるようにしておくと後続運用が楽。
    - **対応**: task 完了時に artifact 起票を推奨する一文を plan に追加（強制ではない）。

## Recommendations

Finding ごとの具体的な plan 改訂案:

1. (Critical#1) §2.1 の `applyDiscardOnly` 仕様に次を追記:
   > **ログ出力契約（applyRestorePlan 現行と bit-identical を保つ）:**
   > - `plan.cleanup` の各 surface に対して `await cmux.closeSurface(s)` → `log("conductor_stale_surface_closed", ...)` を sequential で実行
   > - `plan.discarded` のうち **`reason === "surface_missing_no_task"` の行のみ** `log("conductor_discarded", ...)` を出力。`reason === "pid_dead_idle_cleanup"` の行（C 経路由来）は既に `conductor_stale_surface_closed` で記録済みのためスキップ

   S1 step 3 の検証コマンドに追加:
   ```bash
   # reason フィルタ条件が bit-identical であることを確認
   grep -A 3 "reason === \"surface_missing_no_task\"" skills/cmux-team/manager/daemon.ts | grep conductor_discarded
   ```

2. (Critical#2) S2 の文言書き換えを以下に変更:
   > 新: `restored=${restoredLayout} current=${state.layout} — surviving panes will be kept; missing ones are recreated under the current layout`
   >
   > あるいは行動案内を全削除して純観測ログに:
   > 新: `restored=${restoredLayout} current=${state.layout}`

3. (Major#3) S3 の test を以下に拡張:
   - **M17a**: E-only fallback（現 M17 相当）
   - **M17b**: C-only fallback（pid 全死亡 + surface 全実在 + idle → close-surface 3 回 + initializeConductorSlots）
   - **M17c**: C+E 混在 fallback

4. (Major#4) §2.1 疑似コードを以下に更新:
   ```
   if (plan.alive.length === 0
       && plan.resumeExisting.length === 0
       && plan.resumeNewSurface.length === 0) {
     log("layout_restore_empty_fallback",
         `kept=0 discarded=${plan.discarded.length} layout=${state.layout}`)
     await applyDiscardOnly(state, plan)
     // resumePlan はそのまま透過する（plan.unmatchedResumes は
     // initializeConductorSlots が panes と 1:1 で分配する）
     return await initializeConductorSlots(
       state.projectRoot,
       state.conductors,
       state.maxConductors,
       daemonSurface,
       resumePlan,   // ← team.json 空経路と同じシグネチャ
       state.layout,
       state.mainBranch,
     )
   }
   ```
   §5.2 エッジケース表に追加:
   | `team.json` 3 entry 全 E + resumePlan 2 件 | fallback 発動 + 新 slot 2 件に resume 分配（残 1 slot は通常 spawn） |

5. (Major#5) §2.1 の `applyDiscardOnly` 仕様に sequential 順序を明記（Recommendation #1 の記述で吸収可能）。

6. (Major#6) S8 冒頭に追記:
   > `[Unreleased]` セクション以下に追記する。次回 release スキル実行時（別タスク）に release スキルが `[Unreleased]` を `[4.3.0] - <date>` にリネームする前提で、本タスクではバージョン見出しを新設しない。

7-12. (Minor) 該当 finding 記載の通り。

## 参照

- plan: `/Users/yamamoto/git/cmux-team/.team/tasks/286-cmux-team-start-stop/runs/task-286-1776739185/plan.md`
- `skills/cmux-team/manager/daemon.ts:1117-1193` (initializeLayout)
- `skills/cmux-team/manager/daemon.ts:970-1114` (applyRestorePlan) — C/E loop の reason フィルタ
- `skills/cmux-team/manager/layout-restore.ts:63-150` (planLayoutRestore) — 5 経路分類 + unmatchedResumes
- `skills/cmux-team/manager/conductor.ts:194-270` (initializeConductorSlots) — resumePlan 1:1 分配
- `skills/cmux-team/manager/main.ts:2160-2182` (cmdStop) / `main.ts:4368-4370` (case "stop")
- `skills/cmux-team/manager/pidfile.ts:26-37` (PidFileLockedError)
- `skills/cmux-team/manager/i18n.ts:183-194` / L675 / L861-872 / L1355 (help_stop / help_main)
- `skills/cmux-team/manager/daemon.test.ts:3137-3534` (T255 M6〜M16 + layout_kept_partial)
- `skills/cmux-team/manager/pidfile.test.ts:112-130` (PidFileLockedError assertion — toContain only)
- `CLAUDE.md:283` (E2E 手順) / L433-434 (cmdStop 保険言及)
- `README.md:100, 238` / `README.ja.md:100, 182, 311`
- `docs/spec/01-skill-cmux-team.md:68` / `03-commands.md:7` / `05-install-and-infrastructure.md:119` / `06-implementation-tasks.md:56-58`
- `skills/cmux-team/SKILL.md:83` / `skills/cmux-team-guide/SKILL.md:54, 108`
- `CHANGELOG.md:1-12` ([Unreleased] セクション状態)
- CLAUDE.md「ロギングポリシー」節 — event_name key=value 形式の遵守確認
