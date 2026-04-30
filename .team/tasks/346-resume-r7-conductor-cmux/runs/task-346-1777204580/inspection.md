# Inspection Report: T346

## 判定: GO

## 検証結果

### 1. plan.md 遵守確認

| 変更項目 | 結果 | 備考 |
|---|---|---|
| 変更 1: fallback 条件から `resumeNewSurface.length === 0` を削除 | OK | daemon.ts L1273: `if (plan.alive.length === 0 && plan.resumeExisting.length === 0) {` に修正。元の三条件 AND は二条件 AND に縮約されている |
| 変更 2: fallback 内で D 経路 resume を `initializeConductorSlots` の `resumePlan` に透過 | OK | daemon.ts L1283-L1290 で `allResumePlanMap` を組み立て taskId 一意化、L1299 で `allResumePlan` を渡している。plan.md の単純結合より構造的に強い実装（自己判断 1 と整合） |
| 変更 3: `applyRestorePlan` 後に `deficit > 0` で `initializeConductorSlots(deficit, undefined)` 補充 | OK | daemon.ts L1326-L1342。引数 `count=deficit, resumePlan=undefined` で plan.md 通り。assignments に push して return |
| 変更 4: D 経路コメント (R7 廃止に整合) 更新 | OK | daemon.ts L1135-L1141 で R7 言及を削除し、partial restore 経路 (ready 戻し → topup 補充 → 次 tick 割当) と fallback 経路 (resumePlan 透過) を分けて明示 |
| 変更 5: M18a/M18b/M18c 追加 + `layout_kept_partial` テスト修正 | OK | daemon.test.ts +254/-13 行。既存 `layout_kept_partial` (L3636-3678) は `layout_conductors_topup` + `have=1 max=3 adding=2` + `newSplit` 2 回 + alive 1 件維持を追加検証。M18a/b/c は L3957 以降で追加 |
| ログキー名 `layout_conductors_topup` (snake_case + 英数字) | OK | daemon.ts L1330 で正しい命名。plan.md の指摘 (本文の `layout_conductor_補充` は規約違反) を解消済み |

### 2. 自己判断 3 点のレビュー

| # | 自己判断 | レビュー |
|---|---|---|
| 1 | D 経路と外部 resumePlan の重複を **Map で taskId 一意化** | **妥当**。plan.md の「単純結合 + 後段で Map 一意化」より構造的に強い実装。`initializeConductorSlots` が `panes` の i 番目に `resumePlan?.[i]` を 1:1 で割当てるため、配列上重複があると同一 taskId が 2 つの pane に launch される潜在バグがある。Map 一意化は防御として正しい |
| 2 | M18a でのみ `CONDUCTOR_REGISTERED` を simulate して最終 size 検証 | **妥当**。`initializeConductorSlots` は非 resume slot を pre-populate しない (T228 で削除) ため、`initializeLayout` 完了直後の `state.conductors.size` は alive + B + D の resume 対象のみ。M18b/c では同期時点の size + `newSplit` 呼び出し回数で「pane 数 (newSplit + 既存 alive) === maxConductors」を代替検証している。事後条件の intent と整合 |
| 3 | `stubCmuxIO` に `newSplit` のデフォルトモックを追加 + 全 finally で mockRestore | **妥当**。partial restore 系の既存テスト (M7/M10/M11/M14/M16/conductor_resume_noop) で T346 の topup が動くようになり、stub が無いと実 cmux に対して `newSplit` が呼ばれて pane が大量に作成される。ヘルパ側で対応するのが最小修正で副作用境界も守れている |

### 3. コードレビュー所見

#### Critical

なし。

#### Minor

- **M-1** (本タスク範囲): daemon.ts L1019 の `applyRestorePlan` docstring に「(pane 新規分割しない方針 R7)」が残存。ロジック自体 (D 経路を ready 戻し) は維持されるが、R7 という名称は T346 で廃止されたため、`partial restore 経路では D を ready 戻し → 後段の topup で補充` のような書き方に直すと誤解防止になる。検品観点では severity minor (実装本体のコメントは L1135-L1141 で更新済みのため、docstring 側の取りこぼし)
- **M-2** (本タスク範囲外、後続タスク提案): main.ts L866 の Full Quit コメント「team.json から読んで全件 discard し、R7 方針で pane を新規作成しないため Conductor ゼロ台で着地する」は T346 で誤りになった。次回起動時 `initializeLayout` の fallback 条件 (alive=0 && resumeExisting=0) が match → topup → maxConductors 個の pane が作成される。実装挙動は Full Quit の意図 (全部終了して次回はゼロから) と矛盾しないが、コメントが古い

#### 引数順序チェック

- daemon.ts L1296-L1305 (fallback): `projectRoot, conductors, maxConductors, daemonSurface, allResumePlan, layout, mainBranch, backend` → conductor.ts L204-213 のシグネチャと一致 OK
- daemon.ts L1334-L1342 (topup): `projectRoot, conductors, deficit, daemonSurface, undefined, layout, mainBranch, backend` → 一致 OK

#### 重複登録・無限ループ

- `state.conductors` は `applyRestorePlan` 内 L1027 で `clear()` 後に再構築。topup の deficit 計算は applyRestorePlan 完了後の値を 1 回のみ評価。`initializeConductorSlots` 内部での failure 時に再帰しない。無限ループのリスクなし
- A+B の合計は `maxConductors` 以下になる前提 (planLayoutRestore 側の保証)。`if (deficit > 0)` ガードで負値も安全に弾かれる

#### TypeScript 型安全性

- `bunx tsc --noEmit` エラー 0 件
- `(r): r is ResumePlanItem => !!r` のフィルタ predicate は既存パターンと整合

#### M18c のシナリオ妥当性

- 「全 surface 消滅 + assigned task」を `__setIsAliveImpl(() => false)` + `__setTreeImpl(async () => "")` で表現
- team.json に `taskId="700"` を持つ entry を 1 件、`taskId` なし entry を 2 件混入させ、`planLayoutRestore` が 1 件を D 経路 + 2 件を E 経路に振り分ける構造を作っている
- 期待結果: fallback 発動 + assignments 1 件 (D の resume 透過) + `newSplit` 3 回 (1 resume + 2 非 resume) + state.conductors.size === 1 (D の resume pre-populated)
- 「変更前は fallback が発動せず applyRestorePlan で ready 戻し → state.conductors.size === 0」というバグを正確にモデル化している。**M18c は本タスクが解こうとしたバグの本質を捉えた回帰テスト**として十分

### 4. 検証コマンド再実行結果

```
$ bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json
(エラー 0 件)

$ cd skills/cmux-team/manager && bun test --timeout 30000 layout-restore.test.ts
 10 pass / 0 fail / 53 expect() calls

$ bun test --timeout 30000 daemon.test.ts
 173 pass / 0 fail / 620 expect() calls  [28.25s]

$ bun test --timeout 30000 daemon.test.ts -t "M18"
 3 pass / 0 fail / 20 expect() calls

$ bun test --timeout 30000 conductor.test.ts
 38 pass / 0 fail / 144 expect() calls (across 2 files)
```

impl-report.md の数値と完全一致。

### 5. 副作用確認

```
$ git diff --stat
 skills/cmux-team/manager/daemon.test.ts | 267 +++++++++++++++++++++++++++++++-
 skills/cmux-team/manager/daemon.ts      |  53 +++++--
 2 files changed, 304 insertions(+), 16 deletions(-)

$ git status
On branch task-346-1777204580/task
Changes not staged for commit:
  modified:   skills/cmux-team/manager/daemon.test.ts
  modified:   skills/cmux-team/manager/daemon.ts
no changes added to commit
```

- 想定 2 ファイル (daemon.ts + daemon.test.ts) のみ変更。**追加・想定外ファイルなし**
- untracked file なし
- `stubCmuxIO` ヘルパへの `newSplit` モック追加が他 12 テストの finally ブロックに `stubs.newSplit.mockRestore()` 追加を要求しているが、すべてのテスト pass。副作用なし

### 6. CLAUDE.md / 仕様書整合

- ログキー命名 (`layout_conductors_topup`): snake_case + 英数字のみ → CLAUDE.md 規約遵守 OK
- `task-state` 直接書き込みなし: 補充は `initializeConductorSlots` 経由で `state.conductors` を扱うのみ、`taskState[...] =` / `saveTaskState(` の直接呼び出しなし → OK
- `bus.emit` / `bus.on` 直接呼び出しなし → OK
- `cmux tree` (`tree(workspace)` / `validateSurface(surface, workspace)`): 本タスクで `tree` 直接呼び出しなし、ヘルパ越し → OK
- `applyTaskEvent` / `updateTaskSessionId` 経由不要 (本タスクは task-state を変更しない) → OK
- 外部コマンド失敗時の log detail: 本タスクで新規外部コマンドなし → 該当せず
- `bun test` 全体実行禁忌: 1 ファイルずつ実行されている → OK

### 7. R7 廃止の波及（本タスク範囲外だが要記載）

`grep -rn "R7" docs/spec/` および `grep -rn "R7\|pane 補充\|kept_partial" docs/` → **0 件**。docs/spec/ への波及なし、docs-sync は不要。

ただし、コードコメント側に古い R7 言及が 2 箇所残存:

1. **`skills/cmux-team/manager/daemon.ts:1019`** — `applyRestorePlan` docstring の「(pane 新規分割しない方針 R7)」
2. **`skills/cmux-team/manager/main.ts:866`** — Full Quit 処理コメントの「R7 方針で pane を新規作成しないため Conductor ゼロ台で着地する」

(`daemon.test.ts:5513` の R7 と `token-cli.test.ts` の R7 は別文脈の R7 で本タスクと無関係)

#### 後続タスク提案

- **T347 (仮)**: T346 R7 廃止に伴う古い R7 言及のコメント整理。daemon.ts L1019 docstring と main.ts L866 のコメントを T346 後の挙動に整合させる。実装挙動は変えない (コメントのみ)。本タスクのスコープ外なので別タスクとして起票推奨

## Critical findings (NOGO の場合)

なし。

## Minor findings (GO でも残課題)

1. (M-1) daemon.ts L1019 docstring の R7 言及が古い → 上記 T347 (仮) で対応
2. (M-2) main.ts L866 Full Quit コメントの R7 言及が古い → 上記 T347 (仮) で対応

両方ともコメントのみで実装挙動には影響しないため GO 判定。

## Fix Required (NOGO の場合のみ)

なし。
