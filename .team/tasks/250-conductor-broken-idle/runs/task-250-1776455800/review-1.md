---
reviewer: design-reviewer
task: T250
plan: .team/tasks/250-conductor-broken-idle/runs/task-250-1776455800/plan.md
artifact_ref: A015
reviewed_at: 2026-04-18
---

## Verdict: Changes Requested

## Summary

A015 の「決定 2 項: エラーステートの保持」の方針、broken 状態導入のスコープ、
サブタスク分割・テスト設計は総じて妥当で、Decision Log にも根拠が整理されている。
ただし **`clear-conductor` → `CONDUCTOR_DONE (reason: "cleared")` → `handleConductorDone` 経由で
broken を idle に戻す**という中核メカニズムが、`daemon.ts:986-992` の既存 guard で
早期 break されて機能しない致命的な欠陥がある。この 1 点が解消されない限り
「明示的ユーザー操作で broken を解除できない = 永久に broken のまま」となり、要件 5
（ユーザー明示クリア CLI）が満たせない。

## Findings

### 1. [critical] clear-conductor の CONDUCTOR_DONE 経路が no_task guard で必ず早期 break する

**場所**: plan.md ST-8、`daemon.ts:975-1019`（CONDUCTOR_DONE ハンドラ）

**事実**:

```ts
// daemon.ts:986-992
if (conductor.status !== "running" && !conductor.taskRunId) {
  await log("conductor_done_ignored",
    `${formatSurface(message.surface, "C")} status=${conductor.status} reason=no_task`);
  break;
}
```

broken Conductor は `forceCloseDisconnectedConductor` 内の `resetConductor` で既に
`taskRunId = undefined` / `taskId = undefined` がクリア済み（ST-2 でも「taskId/taskRunId/
taskTitle/worktreePath/outputDir/agents は全てクリア」と明記）。したがって
`clear-conductor` が送る CONDUCTOR_DONE は:

- `conductor.status !== "running"`（"broken"）→ 真
- `!conductor.taskRunId`（undefined）→ 真
- 両方真 → `conductor_done_ignored reason=no_task` で **`handleConductorDone` に到達しない**

結果として broken Conductor は永久に idle に戻らず、scanTasks で拾われないため、
Conductor スロットが実質的に永久的に失われる。これは A015 の「**ユーザーが明示的に
クリアするまで**残す」の「クリアする手段を用意する」部分が完全に未実装となる状態で、
plan.md 冒頭の目的を満たさない。

なお ST-8 にある「`handleConductorDone` 冒頭で `reason === "cleared"` を識別して
`task_aborted` 重複処理を行わない分岐を入れる」も、そもそも handleConductorDone まで
到達しないため無効。

**必要な修正**（Recommendations 参照）: 新 message 型 `CONDUCTOR_CLEAR` を追加するか、
no_task guard の前に `reason === "cleared"` の bypass を置くか、あるいは CLI が daemon の
queue を介さず `clear-conductor` 専用 RPC / signal 経由で直接 `resetConductor(opts={targetStatus: "idle"})`
を呼ぶ経路に変更する。

### 2. [major] ST-2 の実装方針が 2 つ併記されており決定事項が曖昧

**場所**: plan.md ST-2、ST-7

ST-2 の「内容」項目は:
- (3) `resetConductor` の cleanup 部分を **「直書き」** で forceClose に展開
- (5) 案 A: `targetStatus` オプション追加で resetConductor を共有

と 2 つの案を併記し、最後に「案 A を採用」と書かれている。一方 ST-7 は明確に案 A 前提。
実装者がこの節を 1 回しか読まないと (3) の「直書き」を採用してしまう恐れがある。
**(3) の「直書き」記述を削除し、案 A（ST-7 のシグネチャ拡張）のみが残るように整理すべき**。

### 3. [major] `conductor_broken` ログが 2 箇所から出る（重複ログ）

**場所**: plan.md ST-2 と ST-7

- ST-2（forceClose 側）: `log("conductor_broken", …reason=disconnect_timeout taskRunId=…)`
- ST-7（resetConductor 側）: `log(conductor.status === "broken" ? "conductor_broken" : "conductor_reset", …reason=…)`

両方に `log("conductor_broken", ...)` が入ると、1 回の forceClose で
「conductor_broken」が 2 行出る（disconnect 到達の可視化は嬉しいが情報内容が重複）。
DRY の観点から **どちらか 1 箇所** に集約する必要がある。resetConductor 側のログは
call context（reason=disconnect_timeout / cleared 等）を呼び出し側から渡す設計（opts.reason）
なので、forceClose 側の `log("conductor_broken", ...)` は削除し、resetConductor 側に
集約するのが自然。plan.md ST-2 の (4) 行をこの方針で書き換えるべき。

### 4. [major] broken Conductor の scanTasks 候補除外のテストが弱い

**場所**: plan.md ST-5 / ST-13

ST-5 は「既に `c.status === "idle"` のみを拾う実装なので broken は自動除外される。
追加コードは不要」としているが、不変条件化のテスト（ST-13 の 2 つめ）が必要条件すら
曖昧。broken 以外にも `disconnected` / `starting` / `assigning` / `running` / `asking` の
全 status で idle ではないため除外されるが、**broken はユーザー操作がない限り永続する**
点が他 status と異なる（disconnected は timeout で broken or 復帰、starting は timeout で
disconnected、等）。テストとして「broken Conductor 1 + idle Conductor 0 + ready task 1」
→「1 tick 後: task は ready のまま / broken は broken のまま / `throttled no_idle_conductor`
ログ」だけでなく、「broken 1 + idle 0 の状態で `SESSION_IDLE` / `SESSION_STARTED` を受信」→
「status は broken のまま」も ST-3 の副テストとして明示的に検証すべき。ST-13 の 3 番目で
カバーされているが、受信する SESSION_* イベントの source（startup / resume / clear / compact）
全バリアントで試さないと、新たに条件分岐が追加されたときに穴が空く。

### 5. [minor] broken 状態の team.json 永続化タイミングが不明

**場所**: plan.md ST-6、`daemon.ts:2277-` (`updateTeamJson`)

`forceCloseDisconnectedConductor` の末尾で `notifyStateChanged` を呼ぶが、
`updateTeamJson` は daemon の tick で呼ばれるため、daemon 即時クラッシュ時は
broken が team.json に未反映のまま失われる可能性がある。

現状他の状態遷移（disconnected / running 等）も同じモデルなので、**本タスクで新たに解決する
必要はないが**、ST-6 の完了条件「daemon 再起動後も broken が broken のまま復元される」の
検証としては、「broken 遷移 → `updateTeamJson` を同期呼び出し（またはテスト内で forceCall）
→ 再起動シミュレーション → status 検証」のテストが欲しい。ST-14 がそれを意図していると
読めるが、手動 E2E だけでなく test 内で「updateTeamJson → readFile → restoreConductors」
の round-trip を明示的に書くべき。

### 6. [minor] ST-12 の i18n ヘルプ本文が plan.md 内で生文字列として提示されているが、実装形態（`t()` key）に合わせた形式ではない

**場所**: plan.md ST-12

既存 `i18n.ts` は `help_*` キーのテンプレートリテラルを ja/en それぞれに持つ形式
（L120-165 等）。ST-12 の内容には help 本文だけが書かれ、どのキー（`help_clear_conductor`）
に紐付くか、fallback 動作（`showHelp(t("help_clear_conductor"))` の `t` 解決ロジック）の
整合は書かれていない。**実装時に既存 `help_abort_task` / `help_restart_task` の定義を
コピーして同じ形式で追加する**点を ST-12 に明記するか、対応する key 名を `i18n.ts` の
TypeScript type（`type HelpKey = ...`）にも追加する旨を書くべき。

### 7. [minor] ST-7 の disconnectedAt 処理が resetConductor の責務変更を生む

**場所**: plan.md ST-7、`conductor.ts:541-543`

既存 resetConductor は **無条件に** `disconnectedAt = undefined` にする（Minor 3 として
コメントあり）。ST-7 は「`if (conductor.status === "idle")` のときだけ undefined にする」と
振る舞いを変える。これにより:

- 新 API 呼び出し（opts.targetStatus = "broken"）: `disconnectedAt` を残す
- 既存 3 呼び出し（opts なし / targetStatus = "idle"）: 従来通り undefined

ここまでは plan が意図通りに意図しているが、**今後 broken Conductor が再度 disconnected
扱いになる経路（例: broken → clear-conductor → idle → 次タスク割当 → 再 PID 死亡）**で、
`resetConductor` 呼び出し前の disconnectedAt が残っていると次回の broken 表示に古い値が
混入するリスクがある。`clear-conductor`（= idle 化）側で明示的に `disconnectedAt = undefined`
をクリアする記述が ST-7 の if 条件に含まれているので実害はないが、この非対称（broken 時だけ
残す）はコメントで明示すべき（`// broken の場合のみ UI 用に残す`）。

### 8. [minor] `forceCloseDisconnectedConductor` のフィールド保持/クリア方針に一貫性の説明不足

**場所**: plan.md ST-2 (4)、ST-7

plan.md ST-2 (4) は「`sessionId` は残す（trace 追跡のため）」と明記するが、既存
resetConductor は `sessionId` を触らない（conductor.ts:544 `// sessionId は SessionStart
hook で最新値に追従するため reset では触らない`）。案 A（resetConductor 流用）を採用する
場合、この挙動は既に実装済みで追加作業不要。ST-2 (4) の記述は「既存挙動の確認」として
位置づけられるべき。

### 9. [minor] 依存タスク cascade (T241) との相互作用の記述が未確認

**場所**: plan.md 7. Decision Log 付近（レビュー観点 7）

plan 本文はタスク abort の cascade（daemon.ts:2217-2230）と broken 遷移の相互作用に
触れているが、**cascade 後に生成される `ready` 子タスクが直後の scanTasks で
`idleConductor === undefined`（broken のみ）→ `throttled no_idle_conductor` でブロック**
されるシナリオが明示されていない。T241 は `depends_on` 親が aborted されたら子を draft に
**戻す**ので、子タスクが ready のまま assignTask に流れるケースは通常ない（draft に
戻るため）。この点は plan の記述と整合しているため、レビュー観点 7 の「depends_on cascade
と衝突しない」は OK。ただし plan.md の Decision Log や Risks セクションに「cascade による
子→draft 戻しで broken Conductor への誤 assign は起こらない」との明示的な 1 行があると、
後で読み返したときに迷わない。

## CRITICAL チェック項目の判定

| 項目 | 結果 | コメント |
|------|------|---------|
| サブタスクカバレッジ | PASS | ST-1〜ST-14 で変更対象 8 ファイル全てをカバー |
| 統合テスト/検証 | PARTIAL | ST-13 で unit test 追加ありだが、**最重要の「clear-conductor → broken → idle」E2E が Finding 1 のため実際は pass しない**。ST-14 は手動 E2E の記述のみ |
| 削除タスクの完全性 | PARTIAL | 「旧 Step 3 `await resetConductor(...)` を **削除**」と「案 A（targetStatus オプション）で resetConductor を再利用」が **矛盾**（Finding 2）。実装方針を 1 本化すれば解消 |
| 既存テストへの影響 | PASS | daemon.test.ts L765-808 の期待値変更を明記、`status="idle"` → `"broken"`、`disconnectedAt` 削除の変更も記載済み |

## Recommendations

Changes Requested を解消するために、plan.md に以下の修正を加えて再提出してほしい。

### R1 (Finding 1 対応・必須)

`clear-conductor` の daemon 通知経路を CONDUCTOR_DONE 流用ではなく以下のいずれかに変更する:

**案 R1a（推奨）**: 新 queue message `CONDUCTOR_CLEAR` を導入:
```ts
// schema.ts
export const ConductorClearMessage = z.object({
  type: z.literal("CONDUCTOR_CLEAR"),
  surface: z.string(),
  reason: z.string().optional(),  // "user_clear" 等
  timestamp: z.string().datetime(),
});
```
daemon 側に専用 handler を追加し、`conductor.status === "broken"` を確認した上で
`resetConductor(conductor, ..., { targetStatus: "idle", reason: "cleared" })` を呼ぶ。
broken 以外の状態で CONDUCTOR_CLEAR が来たら `conductor_clear_ignored` でログして break。
utility 関数（clearBrokenConductor 等）に共通化してもよい。

**案 R1b（非推奨）**: 既存 CONDUCTOR_DONE ハンドラ no_task guard の前に
`message.reason === "cleared"` + `conductor.status === "broken"` 組み合わせの bypass を
挿入する。message 型意味の曖昧化を避けるため案 R1a のほうが推奨。

ST-8（cmdClearConductor）と ST-9（dispatch）は R1a に合わせて書き換え、message 型の
バリエーションを schema.ts 側でも追加する ST-1.5 のようなサブタスクを追加する。

### R2 (Finding 2 対応・必須)

ST-2 の「内容」セクションから、`resetConductor` の cleanup を直書き展開する案（現 (3)）を削除し、
案 A（targetStatus オプション追加）一本に整理する。ST-2 (5) を ST-7 に統合して、
ST-2 の責務を「forceClose 側で resetConductor を opts 付きで呼ぶ」のみに絞る。

### R3 (Finding 3 対応・必須)

`log("conductor_broken", ...)` を forceClose 側から削除し、resetConductor 内の
`conductor.status === "broken" ? "conductor_broken" : "conductor_reset"` に一本化する。
reason は opts.reason（"disconnect_timeout" 等）を resetConductor に渡し、ログに含める。

### R4 (Finding 4 対応・推奨)

ST-13 に以下のテストを追加:

- broken Conductor + SESSION_STARTED (source=startup/resume/clear/compact の 4 バリアント)
  で status が変化しないこと
- broken Conductor + SESSION_ACTIVE で status が変化しないこと
- broken Conductor + SESSION_IDLE で status が変化しないこと
- broken Conductor + SESSION_CLEAR で status が変化しないこと

各ハンドラに broken ガードを追加した（ST-3）ことへの回帰テストとして必須。

### R5 (Finding 5 対応・推奨)

ST-14 に「unit test で updateTeamJson → readFile → restoreConductors の round-trip」を
追加する。手動 E2E のみに依存しない形に昇格する。

### R6 (Finding 6 対応・軽微)

ST-12 に「`help_clear_conductor` key を i18n.ts の ja / en 両 dictionary に追加する。
書式は既存 `help_abort_task` / `help_restart_task` に合わせる」の 1 行を追加する。

### R7 (Finding 7, 8, 9 対応・軽微)

- ST-7 のコード例に「broken の場合のみ disconnectedAt を UI 用に残す」の行コメント追加
- ST-2 (4) を「sessionId は既存 resetConductor 挙動の通り触らない（説明のみ）」に書き換え
- Risks / Decision Log に「cascade (T241) で子タスクは draft に戻るため broken Conductor
  への誤 assign 経路は存在しない」の 1 行を追加

---

以上の 7 点（特に R1〜R3）を反映した plan.md の再提出を待つ。R1 が最重要で、R1 の修正
無しに実装に進むと clear-conductor CLI が動作せず Conductor スロットが永久的に失われる
（= 本タスクの目的が達成されない）ため、**実装前に必ず plan.md を更新してほしい**。
