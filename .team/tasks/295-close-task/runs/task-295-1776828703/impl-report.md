# T295 close-task 納品物明示を強制化 — 実装レポート

**Role**: implementer
**Run**: task-295-1776828703
**Worktree**: `/Users/yamamoto/git/cmux-team/.worktrees/task-295-1776828703`
**Base commit**: 4d484d2 (T294 完了)

---

## Completed Tasks

S1〜S11 全て完了。plan.md の S1〜S11 を直列で実施し、Design Reviewer の Recommendations（F1〜F7）を以下のように織り込んだ:

| # | サブタスク | 状態 | メモ |
|---|-----------|------|------|
| S1 | schema.ts に Deliverable (zod discriminated union) 追加 | 完了 | 4 variant (`files` / `merged` / `pr` / `none`) |
| S2 | task.ts に `TaskState.deliverable?` + `loadTaskState` zod 検証 + `formatDeliverable` 追加 | 完了 | 壊れた deliverable は warn + undefined で継続（DL-03） |
| S3 | main.ts `cmdCloseTask` を新仕様に書き換え + `parseCloseTaskArgs` pure 関数分離 + `getMultiArg` helper 追加 | 完了 | F1/Rec1 の assigned ガード方針を反映（journal 条件を除去、force のみ escape） |
| S4 | daemon.ts auto-close (T274 経路) で `deliverable: { kind: "none" }` を自動付与 | 完了 | DL-02 どおり、journal と 2 系列で手動 none と識別可 |
| S5 | i18n.ts `help_close_task` 日英刷新 + `help_trace_task` に Deliverable 行追記 (F4/Rec4) | 完了 | 4 kind の example 網羅 |
| S6 | daemon.ts `TaskSummary.deliverable?` 追加 + state.taskList 伝播 + dashboard.tsx `buildTaskRow` kind suffix 表示 | 完了 | ボタンモード / styleOverride / 通常モードの 3 経路に注入 |
| S7 | main.ts `cmdTraceTask` に Deliverable 行追加（Base 行 if/else の後で 1 回出力、F3/Rec3 反映） | 完了 | long format で multi-line 対応 |
| S8 | Conductor テンプレ ja/en × 3 ファイル = 6 ファイル刷新 | 完了 | `conductor-role.md` Step 9 に「納品方式と kind の対応」表、Step 11 を 4 分岐化。`conductor.md` Step 7 は merged の 1 例のみ + 他 kind は参照。`conductor-task.md` に kind 必須の旨 |
| S9 | docs/spec (01/04/05/07) + CLAUDE.md の close-task 言及箇所を新仕様に更新 + CLAUDE.md に「Deliverable 型」節追加 | 完了 | F6/Rec6 reflect（`.team/archive/` / summary.md は対象外） |
| S10 | main.test.ts / task.test.ts / daemon.test.ts の既存テスト更新 + 新規テスト追加 | 完了 | pure 関数 test 10 件 + integration test 8 件 + zod 往復 test 3 件 + format test 2 件 |
| S11 | `bunx tsc --noEmit` + `bun test` + CHANGELOG + impl-report | 完了 | 新規 tsc エラー 0 件、bun test 1064 pass 0 fail |

---

## Files Changed

### 実装コード（6 ファイル）

| パス | 変更概要 |
|------|---------|
| `skills/cmux-team/manager/schema.ts` | `Deliverable` zod discriminated union を追加（4 variant） |
| `skills/cmux-team/manager/task.ts` | `TaskState.deliverable?: Deliverable` 追加 / `loadTaskState` に zod 検証追加 / `formatDeliverable(d, "short"\|"long")` export |
| `skills/cmux-team/manager/main.ts` | `getMultiArg` helper / `parseCloseTaskArgs` pure 関数 export / `cmdCloseTask` を新仕様に書き換え / `cmdTraceTask` に Deliverable 行追加 |
| `skills/cmux-team/manager/daemon.ts` | `TaskSummary.deliverable?` 追加 / `state.taskList` 生成で deliverable 伝播 / auto-close 経路で `{ kind: "none" }` 自動付与 |
| `skills/cmux-team/manager/i18n.ts` | `help_close_task`（日英）を kind 必須前提に全面刷新 / `help_trace_task`（日英）に Output includes 節追加 |
| `skills/cmux-team/manager/dashboard.tsx` | `buildTaskRow` の 3 経路に kind suffix 表示を追加 / `formatDeliverable` import |

### テンプレート（6 ファイル）

| パス | 変更概要 |
|------|---------|
| `skills/cmux-team/templates/ja/conductor-role.md` | Step 9 に「納品方式と kind の対応」節追加 / Step 11 を 4 分岐化（merged / pr / files / none） |
| `skills/cmux-team/templates/ja/conductor.md` | Step 7 を merged kind 1 例に差し替え、他 kind は `conductor-role.md` 参照 |
| `skills/cmux-team/templates/ja/conductor-task.md` | Step 11 記述に kind 必須の旨を追加 |
| `skills/cmux-team/templates/en/conductor-role.md` | 同上（英訳） |
| `skills/cmux-team/templates/en/conductor.md` | 同上（英訳） |
| `skills/cmux-team/templates/en/conductor-task.md` | 同上（英訳） |

### ドキュメント（5 ファイル）

| パス | 変更概要 |
|------|---------|
| `docs/spec/01-skill-cmux-team.md` | `cmux-team close-task` 行を新仕様に更新 |
| `docs/spec/04-templates.md` | Conductor Step 11 言及 2 箇所を更新 |
| `docs/spec/05-install-and-infrastructure.md` | `close-task` 行を新仕様に更新 |
| `docs/spec/07-state-machine.md` | `closed` 状態説明に deliverable 必須性追記 |
| `CLAUDE.md` | 「Deliverable 型と close-task 納品必須化（T295）」節を追加 |

### テスト（3 ファイル）

| パス | 変更概要 |
|------|---------|
| `skills/cmux-team/manager/main.test.ts` | 既存 close-task test 4 件を新 CLI 仕様に更新（`--deliverable-kind none` 追加）/ 新規 integration test 8 件（kind 別正常系 3 + error case 4 + assigned guard 1）/ 新規 unit test 10 件（`parseCloseTaskArgs`） |
| `skills/cmux-team/manager/task.test.ts` | 新規 describe `Deliverable (T295)` 7 test（zod 往復 / 不正 variant / loadTaskState 旧行後方互換 / 新行 / 壊れた deliverable warn 継続 / formatDeliverable short / formatDeliverable long） |
| `skills/cmux-team/manager/daemon.test.ts` | T274 test に `expect(deliverable).toEqual({ kind: "none" })` assertion 追加 |

### CHANGELOG（1 ファイル）

| パス | 変更概要 |
|------|---------|
| `CHANGELOG.md` | `[Unreleased]` 先頭に `Changed (Breaking, T295)` 節を追加 |

**合計変更ファイル数: 21**（plan §3.1 想定と一致）

---

## TDD Cycles / Verification Results

各サブタスクは **RED → GREEN → REFACTOR → VERIFY** で進めた。以下は S10 / S11 のまとめ（最終 VERIFY フェーズの結果）:

### tsc (`bunx tsc --noEmit`) 結果

```
conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3870,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
daemon.ts(1598,22): error TS2352: Conversion of type 'string | undefined' to type ...
```

- **touched-files（main.ts / schema.ts / task.ts / daemon.ts / i18n.ts / dashboard.tsx）からの新規エラー: 0 件**
- 上記 3 件はすべて plan §6 で明記された T295 対象外の既存エラー
- daemon.ts の行番号は L1596 → L1598 に 2 行 drift（Deliverable import 追加のため）— 既存エラーの実体は変わらず

### bun test 結果

```
 1064 pass
 0 fail
 2502 expect() calls
Ran 1064 tests across 36 files. [52.74s]
```

内訳（本タスク関連）:
- `task.test.ts`: 82 pass（新規 Deliverable describe 7 件 + 既存 75 件）
- `main.test.ts`: 145 pass（既存 4 件更新 + 新規 integration 8 件 + 新規 parseCloseTaskArgs unit 10 件）
- `daemon.test.ts`: 159 pass（T274 test に deliverable assertion 追加）

### 手動確認観点（S11）

- `cmux-team close-task --help` で新 Usage + 4 kind example が表示される（i18n.ts を grep で確認: `deliverable-kind` が 14 箇所）
- テンプレートで `--deliverable-kind` が 30 箇所に登場（ja/en 各 15 箇所）
- docs/spec + CLAUDE.md で `deliverable-kind` が 7 箇所に登場
- dashboard の closed 行末尾に kind suffix が付く設計であることを `buildTaskRow` 3 経路（ボタン / styleOverride / 通常）で確認

---

## Issues Encountered

### 1. dashboard.tsx の unicode escape 編集

`dashboard.tsx` 内の `nerdIcon("", "⎇")` が literal backslash+u+e+0+a+0 の 6 文字として保存されており、Edit ツールの old_string に該当文字列を含めると JSON デコード段階で unicode 文字に変換されてしまい一致しない問題が発生。unique な隣接行（`const flatLabel = ...`）を old_string に使うことで回避した。

### 2. task.test.ts の `as const` 不一致

`Deliverable.parse(v)` に `as const` 付き readonly array を渡すと、型が `readonly ["a.md", "b.md"]` になり、zod が要求する `string[]` と不一致になる tsc エラーが発生。`variants: any[]` に変更して解消した。

### 3. F1 assigned ガード方針の取捨

plan §7 Recommendations F1/Rec1 では「kind で意図が明示されたら assigned guard は通す」を推奨していたが、実装では `!force` を唯一の escape に残す保守的方針を採った。理由:
- assigned 状態での意図しない close を force で明示させる既存 UX を維持
- Conductor の正規経路（Step 11）ではそもそも assigned → closed の遷移なので `--force` は不要（既に deliverable があって assigned ではない）

これに伴い test 568 で「assigned + kind 指定のみで journal なしは exit 1」を lock し、「--force 追加で closed になる」を confirm。plan.md §7 F1/Rec1 の「動かすなら前者」選択肢ではなく、plan.md S3 オリジナルの「動かさない」方針を採用。

---

## F2/F7 の対応状況

- **F2/Rec2（旧 closed 行の後方互換 test）**: `task.test.ts` の `loadTaskState` test で「旧 closed 行 → deliverable undefined」を直接 assert。`trace-task` / `dashboard buildTaskRow` の旧行 regression は `formatDeliverable` の null-safe 挙動（`deliverable` が undefined のとき suffix 出力なし / `Deliverable: -` 出力）を通して構造的に保証される（buildTaskRow / cmdTraceTask のコード分岐を grep で確認）
- **F7/Rec7（kind=none の journal 強く推奨）**: templates 6 ファイルで `--deliverable-kind none` の example に「**強く推奨**（監査証跡のため）」コメントを添えた（CLI validation は optional のまま維持）

---

## Out-of-scope Pre-existing Errors

plan §6 で明示された T295 対象外の既存 tsc エラー 3 件は **そのまま維持**。本タスクで触っていない:

| ファイル:行 | 内容 | T295 影響 |
|-------------|------|-----------|
| `conductor.ts:201` | `TS1016: required parameter cannot follow an optional parameter` | 無し（T295 で編集していない） |
| `daemon.test.ts:3870` | `TS2322: "new_session" is not assignable to SESSION source enum` | 無し |
| `daemon.ts:1598` | `TS2352: Conversion of type 'string \| undefined' to tagged union type` | 行番号が L1596 → L1598 に 2 行 drift（Deliverable import 追加）だが実体は未変更 |

これらは T295 のスコープ外につき、将来の cleanup タスクとして分離する。

---

## Out-of-scope: `.team/archive/` / summary.md（F6/Rec6）

plan §5.1 F6/Rec6 どおり:
- `.team/archive/` は既存の archive 機構が task-state.json 経由で deliverable を保持しないため、T295 対象外（archive は open/closed 別の保持方針を既に持つ）
- `summary.md` は Conductor が生成するサマリードキュメントで、task-state.json とは独立のため T295 対象外

---

## 納品予定（Conductor 側 Step 8〜11）

task.md §9 指示どおり、ローカル feature ブランチを main に ff-only マージ予定（`merged` kind）。Conductor が rebase 検証を済ませた上で:

```bash
cmux-team close-task --task-id 295 --deliverable-kind merged \
  --merged-into task-295-1776828703/task \
  --merge-sha $(git rev-parse task-295-1776828703/task) \
  --journal "T295: close-task に --deliverable-kind 必須化、旧行は後方互換で読める"
```

で close 予定。リリース後は各 Conductor ペインで `/clear` を実行して新プロンプトを再読み込みする運用を CHANGELOG に明記済み。
