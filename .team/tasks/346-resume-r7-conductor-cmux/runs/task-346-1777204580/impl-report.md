# T346 Implementation Report — resume R7 廃止 + Conductor 事後条件保証

## 要約

R7 (復帰時は pane 新規作成しない方針) を廃止し、`initializeLayout` の return 時点で
`pane 数 (newSplit + 既存 alive) === maxConductors` を満たす事後条件を確立した。
既存の `cmux クラッシュ → cmux-team resume` で Conductor が 0 個のままになる
バグ (open task の永続 throttled) を解消する。

TDD で進め、テストを fail → 実装で pass の順序で検証した。

## 変更ファイル

| ファイル | 変更 |
|---|---|
| `skills/cmux-team/manager/daemon.ts` | +43 / -10 行。fallback 条件拡張 / D 経路 resumePlan 透過 / 事後条件 topup / コメント整合 |
| `skills/cmux-team/manager/daemon.test.ts` | +254 / -13 行。`layout_kept_partial` 修正 / M18a/M18b/M18c 追加 / 既存 partial restore テストに mainBranch 設定 / `stubCmuxIO` に `newSplit` モック追加 |

## daemon.ts diff サマリー

### 1) fallback 条件拡張 (L1274-1278)

`plan.alive.length === 0 && plan.resumeExisting.length === 0 && plan.resumeNewSurface.length === 0`
→ `plan.alive.length === 0 && plan.resumeExisting.length === 0`

D 経路 (`resumeNewSurface`) があっても fallback ルートに倒すよう、条件を緩めた。

### 2) fallback 内での D 経路 resumePlan 透過 (L1284-1294)

`applyDiscardOnly` の後、外部 `resumePlan` と `plan.resumeNewSurface[*].resume` を
**Map で taskId 一意化** して合流させ、`initializeConductorSlots` に透過する。

```ts
const allResumePlanMap = new Map<string, ResumePlanItem>();
for (const r of resumePlan ?? []) allResumePlanMap.set(r.taskId, r);
for (const e of plan.resumeNewSurface) {
  if (e.resume) allResumePlanMap.set(e.resume.taskId, e.resume);
}
const allResumePlan: ResumePlanItem[] = [...allResumePlanMap.values()];
```

> **自己判断 1: 重複防止に Map 一意化を採用**
> plan.md に「実装は単純結合 + 後段で Map 一意化を入れる」と記載があるが、本実装では
> **最初から Map で一意化** した。理由: D 経路の resume は `resumeByTaskId` 経由で外部
> `resumePlan` の同一インスタンスを参照しうる。単純結合だと同一 `taskId` が 2 つの pane
> に launch される可能性 (`initializeConductorSlots` は `resumePlan?.[i]` を `panes` の
> インデックス順に 1:1 で割り当てるため) があり、これは「同一 taskId を 2 つの pane に
> launchConductor する」という壊れた挙動になる。Map 一意化で構造的に防いだ。

### 3) applyRestorePlan 後の事後条件チェック (L1297 以降)

`keptSurfaces.length > 0 && < maxConductors` の partial restore 観測ログを残しつつ、
`deficit = state.maxConductors - state.conductors.size` が正なら
`initializeConductorSlots(deficit, undefined)` で補充する。

ログキー: `layout_conductors_topup have=<size> max=<max> adding=<deficit>`

### 4) applyRestorePlan 内 D 経路コメント更新 (L1137-1144)

R7 の言及を削除し、partial restore 経路では D の resume を ready に戻して後段の
topup 補充スロットに次 tick で再割り当てすること、fallback 経路では transparent
透過すること、を明示。

## 追加・修正テスト

### 修正

- **`layout_kept_partial`**: T346 の事後条件 (`layout_conductors_topup` ログ + `newSplit` 2 回 + alive 1 件維持) を追加検証。文言末尾「— pane 補充は行わない（次起動で再構成可能）」が削除された後の `kept=1 max=3` 部分マッチを維持。
- **既存 partial restore 系 (M7/M10/M11/M14/M16/conductor_resume_noop)**: T346 で topup → `initializeConductorSlots` が動くようになり `mainBranch` (T253 fail-stop) が必須となるため、各テストに `state.mainBranch = "main";` を追加。
- **M16 (B 経路 launchConductor 失敗)**: rollback 後にも topup が発動するため、自前 stub に `newSplitSpy` を追加して実 cmux への副作用を遮断。
- **`stubCmuxIO` ヘルパ**: 自己判断 (下記参照) で `newSplit` のデフォルトモックを追加。

### 新規追加 (M18 系: T346 事後条件保証)

| テスト | シナリオ | 検証 |
|---|---|---|
| **M18a** | partial restore (A=1) + max=3, no resumePlan | `layout_conductors_topup have=1 max=3 adding=2` + `newSplit` 2 回 + `state.conductors` に alive 残る + 後段 self-register 後 size===3 |
| **M18b** | partial restore (A=1, B=1) + max=3, resumePlan で B match | `layout_conductors_topup have=2 max=3 adding=1` + `newSplit` 1 回 + assignments に B 1 件 + state size===2 (A + B pre-populated) |
| **M18c** | 全 discard + D 経路 1 件 + resumePlan で D match | `layout_restore_empty_fallback` + assignments に D resume 1 件 + `newSplit` 3 回 + state size===1 (D resume pre-populated) |

> **自己判断 2: `state.conductors.size === maxConductors` の同期検証は M18a でのみ self-register 経由**
> plan.md は M18a/b で `state.conductors.size === 3` の同期 assertion を記載しているが、
> `initializeConductorSlots` は **非 resume slot を pre-populate しない** (T228 で
> 削除された動作) ため、`initializeLayout` 完了直後の `state.conductors.size` には
> 補充 pane は反映されない。このため:
> - M18a: `handleMessage(CONDUCTOR_REGISTERED)` を 2 回送って self-register を
>   simulate し、最終的な `state.conductors.size === 3` を検証する形にした
> - M18b: 同期時点の `state.conductors.size === 2` (A + B pre-populated) を検証
> - M18c: 同期時点の `state.conductors.size === 1` (D resume pre-populated) を検証
> - `layout_kept_partial`: 同期時点の `state.conductors.has("surface:900")` を検証
>
> 事後条件「pane 数 (newSplit + 既存 alive) === maxConductors」は `newSplit`
> 呼び出し回数 + alive 件数で代替検証している。これは「最終的な事後条件を保証する」
> という intent と整合する。

> **自己判断 3: `stubCmuxIO` に `newSplit` のデフォルトモックを追加**
> セッション中、ユーザーから「やたらと surface が作成されている」との指摘を受けた。
> 原因は T346 で partial restore のどのテストでも topup が発動するようになり、
> `stubCmuxIO` に `newSplit` モックがなかったため bun test 実行中に **実 cmux に対して
> `newSplit` が呼び出されて pane が大量に作成されていた** こと。`stubCmuxIO` ヘルパに
> デフォルトの `newSplit` モック (`surface:stub<N>` を返す) を追加し、各テストの
> finally に `stubs.newSplit.mockRestore();` を追加して副作用を遮断した。

## 検証結果

### tsc

```bash
$ cd /Users/yamamoto/git/cmux-team/.worktrees/task-346-1777204580
$ bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json
(no output → エラー 0 件)
```

### unit test

```bash
$ cd skills/cmux-team/manager
$ bun test --timeout 30000 layout-restore.test.ts
 10 pass / 0 fail / 53 expect() calls

$ bun test --timeout 30000 daemon.test.ts
 173 pass / 0 fail / 620 expect() calls

$ bun test --timeout 30000 conductor.test.ts
 38 pass / 0 fail / 144 expect() calls (across 2 files)
```

### M18 系のみ抽出

```bash
$ bun test --timeout 30000 daemon.test.ts -t "M18"
 3 pass / 0 fail / 20 expect() calls
```

## TDD ログ (fail → pass)

1. **既存 `layout_kept_partial` テストを修正** → fail (`layout_conductors_topup` not found)
2. **M18a/M18b/M18c を追加** → 全て fail (期待ログが存在しない)
3. **daemon.ts 変更 1+2 適用 (fallback 条件拡張 + D resumePlan 透過)** → M18c が pass
4. **daemon.ts 変更 3 適用 (事後条件 topup)** → M18a/M18b/`layout_kept_partial` が pass
5. **daemon.ts 変更 4 適用 (D 経路コメント更新)** — 振る舞い変更なし
6. **既存 partial restore テスト 6 件 fail を発見 (mainBranch 未設定)** → 各テストに
   `state.mainBranch = "main"` 追加 + M16 に `newSplitSpy` 追加 + `stubCmuxIO` に
   `newSplit` モック + 全 finally に `stubs.newSplit.mockRestore()` 追加
7. **daemon.test.ts 全 173 件 pass + layout-restore.test.ts 10 件 pass + conductor.test.ts 38 件 pass + tsc エラー 0 件**

## 自己判断ポイント (まとめ)

| # | ポイント | 判断 |
|---|---|---|
| 1 | D 経路と外部 resumePlan の重複防止 | Map で taskId 一意化 (plan.md は「単純結合 + 後段で Map 一意化」と曖昧だったが、launchConductor の冪等性を仮定するより構造的に防ぐ方が安全) |
| 2 | 事後条件の同期検証方法 | `state.conductors.size === maxConductors` を直接 assert すると非 resume topup が pre-populate されない仕様と矛盾するため、M18a でのみ `CONDUCTOR_REGISTERED` を simulate して最終 size を検証。他は同期時点の size + `newSplit` 呼び出し回数で代替 |
| 3 | テスト副作用の遮断 | `stubCmuxIO` に `newSplit` のデフォルトモックを追加。partial restore テスト全般で topup が発動するため、ヘルパ側で対応するのが最小修正 |

## 制約遵守チェック

- [x] worktree 内のみ作業 (main ブランチ未変更)
- [x] commit していない (Conductor が行う)
- [x] artifact 化していない (コード変更タスクのため)
- [x] ログキーは `layout_conductors_topup` (snake_case + 英数字)
- [x] `bun test` 全体実行は禁止 — `bun test --timeout 30000 <ファイル>` で 1 ファイルずつ実行
- [x] `task-state` 直接書き込みなし (本タスクは task-state に触らない)
- [x] `bus.emit` / `bus.on` 直接呼び出しなし
- [x] 外部コマンド失敗時の log は detail に内容を含める (本タスクで新規外部コマンドなし)
