# T351 ライブ TUI dashboard に pool capacity ヘッダー + per-surface handle/util 表示 — 実装結果

worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-351-1777238188`
branch: `task-351-1777238188/task`

## 1. 変更ファイル一覧

### 新規作成 (3 ファイル)

| ファイル | 概要 |
|---|---|
| `skills/cmux-team/manager/pool-summary.ts` | dashboard / CLI 共有の pool snapshot 純関数。`buildPoolSummary(db)` + `loadPoolSummary(projectRoot)`。 |
| `skills/cmux-team/manager/pool-summary.test.ts` | case A/B/C/D/E + loadPoolSummary OFF を網羅（7 test）。 |
| `skills/cmux-team/manager/dashboard-pool.test.tsx` | dashboard pool 表示 + buildSurfaceRowSuffix の API 契約 test（16 test）。 |

### 修正 (4 ファイル)

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/daemon.ts` | `DaemonState.tokenDb: Database \| null` / `DaemonState.pool: PoolSummary \| null` を追加。`refreshPoolSnapshot(state)` を新設。 |
| `skills/cmux-team/manager/main.ts` | (a) `cmdStart` で `state.tokenDb = initTokenDB()` を boot 時 1 度だけ実行、(b) メインループ末尾に `await refreshPoolSnapshot(state)` を挿入、(c) `cmdStatus` の pool 処理を `loadPoolSummary` 1 行に置き換え（旧 in-line ロジック削除）。 |
| `skills/cmux-team/manager/dashboard.tsx` | `buildPoolHeader(summary)` を新 export（閾値色分け）。`buildMasterSection` に `perHandle` 引数追加。`buildConductorRow` を `buildConductorRowWithPool` のシム化、新 4 引数版を export。Conductor / Agent サブツリーに `buildSurfaceRowSuffix` を末尾 spread。Update バナーと Master セクションの間に pool ヘッダーを挿入。 |
| `skills/cmux-team/manager/pool-surface-row.ts` | `buildSurfaceRowSuffix(input): UiNode[]` を新 export（[surface] を含まない API 案 X）。既存 `formatSurfaceRow` は据え置き。 |

### 削除

なし。

## 2. plan Step → commit ハッシュ対応

| Step | commit | 主な変更 |
|---|---|---|
| Step 1 | `90bb827` | pool-summary.ts + pool-summary.test.ts 新設（共有モジュール切り出し） |
| Step 2 + Step 3 (main.ts 部分) | `935b2a3` | cmdStatus を `loadPoolSummary` 経由に切替（旧 in-line 削除）+ cmdStart に `state.tokenDb` 初期化 + メインループに `refreshPoolSnapshot` 挿入 |
| Step 3 (daemon.ts 部分) | `8696c8b` | DaemonState に tokenDb / pool 追加 + `refreshPoolSnapshot` 関数追加 |
| Step 4 + Step 5 + Step 6 | `8eaea2a` | pool-surface-row.ts に buildSurfaceRowSuffix 追加、dashboard.tsx に buildPoolHeader / buildConductorRowWithPool / Master/Conductor/Agent suffix を組み込み、dashboard-pool.test.tsx 新設 |

> Step 2 の cmdStatus リファクタと Step 3 の main.ts 修正（cmdStart 初期化 + メインループ挿入）を同じ commit (`935b2a3`) に取り込んだ。これは作業順序の都合で main.ts 編集が連続したためであり、機能境界としては Step 2 と Step 3 は独立。レビュー時はファイル単位で見れば責務が明確に分かれている（cmdStatus / cmdStart / メインループ）。

## 3. 検証結果

### tsc --noEmit

```
$ bunx tsc --noEmit
(0 errors)
```

### 単体テスト（個別ファイル単位、CLAUDE.md の禁忌に従う）

```
$ bun test --timeout 30000 pool-summary.test.ts pool-surface-row.test.ts \
    dashboard-conductor.test.tsx dashboard-issues.test.tsx \
    dashboard-metrics.test.tsx dashboard-pool.test.tsx
74 pass / 0 fail / 180 expect() calls (163ms)
```

詳細:

| ファイル | pass / fail |
|---|---|
| `pool-summary.test.ts` | 7 / 0 |
| `pool-surface-row.test.ts` | 8 / 0 (既存 test 全 pass) |
| `dashboard-conductor.test.tsx` | 6 / 0 (既存 test 回帰なし) |
| `dashboard-issues.test.tsx` | 17 / 0 (既存 test 回帰なし) |
| `dashboard-metrics.test.tsx` | 20 / 0 (既存 test 回帰なし) |
| `dashboard-pool.test.tsx` | 16 / 0 (新規) |

### 関連回帰チェック

```
$ bun test --timeout 60000 pool-status-header.test.ts pool-next-reset.test.ts pool-cli.test.ts
18 pass / 0 fail

$ bun test --timeout 90000 main.test.ts token-store.test.ts
282 pass / 1 skip / 0 fail

$ bun test --timeout 60000 daemon.test.ts
173 pass / 0 fail
```

合計 547 pass / 0 fail（個別ファイル実行）。

## 4. 目視確認

worktree 内では `.team/team.json` が無く daemon を起動できないため、CLI / dashboard の生 stdout を取得した `diff before.txt after.txt` は実施していない。代わりに以下の保障で挙動の同等性を担保した:

1. **pool-summary.test.ts case A / B / C / D / E**:
   - 現行 `main.ts:1444-1483` の in-line 実装と等価（plan §5 / design-review §1.1 で照合済み）。
   - case D: `selectable=0` の token は capacity 算出には影響しない（plan_ratio の有無のみ判定軸）。`computeNextReset` は内部で `selectable=true` フィルタを掛ける現行挙動と一致。
   - case E: `perHandle` のキー集合が `listTokens` の全 handle と一致（`plan_ratio=null` token も capPct=null として含まれる）。
2. **dashboard-pool.test.tsx case 6 / 7 / 8**:
   - pool ON (`perHandle != null`) で Conductor 行末尾に `@kddi`、`<5h:..%`、`cap:N%` が append され、surface ラベル `[100]` は出力ツリー全体で **1 度だけ**。
   - pool OFF (`perHandle = null`) で Conductor 行に `@` 文字や `<5h:` が含まれず、surface ラベル `[100]` が 1 度だけ。
   - bind なし agent (tokenHandle=undefined) で `(no token)` がレンダリングされる。
3. **dashboard-pool.test.tsx「既存 buildConductorRow (3 引数) は perHandle=null 経路と完全一致（後方互換シム）」**:
   - `buildConductorRow(c, repoUrl, frame)` の戻り値 JSON が `buildConductorRowWithPool(c, repoUrl, frame, null)` と byte 単位で一致することを確認。
4. **buildPoolHeader 閾値色分け（case 3 / 4 / 5）**:
   - capacity 173% で GREEN (rgb(0,160,0)) / 30% で RED (rgb(180,40,40)) / 60% で YELLOW (rgb(200,160,0)) を assert。

実プロジェクトでの dashboard 起動 + pool ON 目視（plan §6 DoD 上 2 件）は worktree 隔離の都合で本タスクのスコープ内で実施できなかった。マージ後にユーザー側で `cmux-team start` を pool ON プロジェクト・OFF プロジェクト双方で実行して確認することを推奨する（後述「未確認 DoD」参照）。

## 5. 完了条件チェックリスト（plan §6 DoD）

| DoD | 状態 | 備考 |
|---|---|---|
| pool 有効時: dashboard に pool capacity ヘッダー表示 | ✓ (test) | dashboard-pool.test.tsx case 2-5 で文字列・色分けを assert |
| pool 無効時: 表示されない（既存レイアウト維持） | ✓ (test) | case 1 (`buildPoolHeader(null) === []`)、case 7 で行内 `@` 不在を assert |
| Master / Conductor / Agent 行に handle 表示 | ✓ (test) | case 6 (Conductor `@kddi`), case 8 (Agent `(no token)`) |
| 既存 dashboard test (`dashboard-conductor` / `dashboard-issues` / `dashboard-metrics`) pass | ✓ | 6 + 17 + 20 = 43 test 全 pass |
| 新規 test (`pool-summary` / `dashboard-pool`) pass | ✓ | 7 + 16 = 23 test 全 pass |
| `bunx tsc --noEmit` 0 errors | ✓ | エラーなし |
| CLI `cmux-team status` の pool 表示が等価 | △ (test 等価性で代替) | pool-summary.test.ts case D / E で「現行 main.ts:1444-1483 と等価」を test 化。実プロジェクトでの diff 検証は未実施 |
| `bun test` 全体禁忌に従い個別ファイル単位で実行 | ✓ | 全 test を `bun test --timeout 30000 <file>` 形式で実行 |
| daemon は state.tokenDb を起動時 1 度だけ open | ✓ | main.ts cmdStart で `state.tokenDb = initTokenDB()` を boot 時に 1 回だけ実行、refreshPoolSnapshot は state.tokenDb を再利用 |

### 未確認 DoD（マージ後の目視確認推奨）

以下の 2 項目は worktree 内で実プロジェクト dashboard を起動できないため、test レベルでの保障に留めた:

1. `.team/config.json` で `tokenPool.enabled=true` のプロジェクトで Manager dashboard を起動して pool capacity ヘッダーが表示されること（生画面確認）
2. pool 無効プロジェクトでレイアウトが従来通りであること（生画面確認）

純関数レベルでは dashboard-pool.test.tsx で網羅的に検証済み。マージ後にユーザー側で 1〜2 分の目視確認を推奨。

## 6. plan からの逸脱

### 6.1 commit 境界の調整

plan §4 では Step ごとに commit を分けることを示唆していなかったが、実装上は Step 2（cmdStatus リファクタ）と Step 3 の main.ts 修正（cmdStart 初期化 + メインループ挿入）を同じ commit (`935b2a3`) にまとめた。理由は両者が main.ts の編集に閉じており、TDD の green 順序として「pool-summary.ts 完成 → cmdStatus + cmdStart + メインループを同時に切替」が自然だったため。Step 3 の daemon.ts 部分は単独 commit (`8696c8b`)。機能境界としては Step 2 / Step 3 は独立で、レビュー時はファイル単位で読める。

### 6.2 実プロジェクト diff 検証の代替

plan §4 Step 2 #3 にある「`cmux-team status > before.txt; after.txt; diff` で出力差分ゼロを確認」は worktree 内で `.team/team.json` が無く実行不可だったため、pool-summary.test.ts case D / case E で「現行 in-line 実装と等価」を test レベルで代替保障した。design-review.md §残存指摘 1.3 でも「現行 main.ts:1444-1483 の in-line 実装と等価」が確認済みであり、minor 3 として「Implementer が test を書く / Step 2 の diff 検証を通じて自然に検出できる範囲」と判定されている。

### 6.3 minor 指摘 1〜3 の取り込み

design-review.md の minor 1 / 2 / 3 はいずれも反映済み:

- **minor 1**: pool-summary.test.ts case A 本文に `remaining_5h = Math.max(0, 1 - util_5h) = 0.5` の式変形コメントを記載。
- **minor 2**: dashboard-pool.test.tsx の Step 4 #1 テストケース 4 を **「pool ON だが該当 handle の cap/util データなし (capPct:null, util:null)」** と rename。
- **minor 3**: pool-summary.test.ts のファイル冒頭コメントと case A/C/D/E に「現行 main.ts:1444-1483 の in-line 実装と等価」を明記。

## 7. 後続フォローアップ（plan §7.7）

`docs/spec/09-token-pool.md` の auto-discover 節に「dashboard / daemon 側も boot 時 1 回評価で固定する」方針を追記する別タスクが推奨される。本タスクの DoD には含めない（plan §7.7 で follow-up と確認済み）。
