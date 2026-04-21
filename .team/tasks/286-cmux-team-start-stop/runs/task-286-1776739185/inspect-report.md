# Inspection Report: T286

## Verdict

**NOGO**

判定理由: 実装・テスト・型検査は全て plan.md 通り完遂されており A/B/C/E は問題なし。ただし D (ドキュメント整合性) で以下 2 件の仕様逸脱を検出:

1. **CLAUDE.md:434** に `cmdStop（保険）` の言及が残存。plan.md §3.1 表 (L227) で「`cmdStop` を削除、release 経路の列挙からも除く」と明示的に指示されていた
2. **docs/spec/01-skill-cmux-team.md:69** の blockquote 注記が markdown テーブル内部に差し込まれており、後続のテーブル行 (L70-) のレンダリングが破損する

いずれも修正は 1 箇所ずつの軽微なテキスト編集で、実装ロジック・テストには影響しない。Round 2 Implementer で F セクションの指示に従って修正すれば GO に昇格可能。

---

## A. コード変更の妥当性

### A-1 applyDiscardOnly: Promise.all 不使用

**Status:** ✅ Pass

**根拠:**
- `daemon.ts:1123-1145` の `applyDiscardOnly` 本体で `plan.cleanup` / `plan.discarded` いずれも `for (const ... of ...) { await ... }` の sequential ループ
- grep 検証: `grep -n "Promise.all" skills/cmux-team/manager/daemon.ts` でも applyDiscardOnly 内 0 件
- JSDoc L1114 で「cleanup ループは **sequential 実行**（`Promise.all` 禁止 — T286 Decision D13）」と契約が明示

### A-2 applyDiscardOnly: reason === "surface_missing_no_task" フィルタ

**Status:** ✅ Pass

**根拠:**
- `daemon.ts:1137-1144` — `for (const d of plan.discarded) { if (d.reason === "surface_missing_no_task") { await log("conductor_discarded", ...) } }` の 1 条件で `pid_dead_idle_cleanup` reason は暗黙にスキップ
- 既存 `applyRestorePlan` C/E ブロック L1010-1027 と bit-identical（L1007-1011 で `applyDiscardOnly(state, plan)` 呼び出しに置換）
- Decision D12 の契約通り

### A-3 pid_dead_idle_cleanup の reason 行は close-surface のみで log emit しない

**Status:** ✅ Pass

**根拠:**
- `applyDiscardOnly` 内の E ループ (L1137-1144) に `reason === "surface_missing_no_task"` の単一条件フィルタ
- C 経路 (L1128-1134) は `conductor_stale_surface_closed` を emit し、E ループではその行がスキップされる（二重出力回避）
- M17b テスト (`daemon.test.ts` L3662) で「`conductor_discarded` ログは出ないこと」を verify

### A-4 フォールバック条件: alive + resumeExisting + resumeNewSurface がすべて空

**Status:** ✅ Pass

**根拠:**
- `daemon.ts:1208-1212`:
  ```ts
  if (
    plan.alive.length === 0 &&
    plan.resumeExisting.length === 0 &&
    plan.resumeNewSurface.length === 0
  ) {
  ```
- 既存 A/B/D 経路（alive / resumeExisting / resumeNewSurface）のいずれかに 1 件でも該当すれば fallback 発動せず既存 `applyRestorePlan` 経路に倒れる
- §5.2 エッジケース表 (L478-479) の「1 件 alive」「1 件 resumeExisting」「1 件 resumeNewSurface」ケースは fallback 発動しないことが保証される

### A-5 layout_restore_empty_fallback のログ format 厳密性

**Status:** ✅ Pass

**根拠:**
- `daemon.ts:1213-1216` — `await log("layout_restore_empty_fallback", \`kept=0 discarded=${plan.discarded.length} layout=${state.layout}\`)`
- M17a/b/c で `toMatch(/kept=0/)`, `toMatch(/discarded=3/)`, `toMatch(/layout=wide/)` or `layout=16x9` の 3 正規表現で format verify 済

### A-6 layout_mismatch_on_resume メッセージ修正

**Status:** ✅ Pass

**根拠:**
- `daemon.ts:1165-1168` — 新メッセージは `restored=${restoredLayout} current=${state.layout}` のみ
- 旧文言 `existing panes will be kept; run 'cmux-team stop' then 'start --layout=...' to rebuild` は完全削除
- grep 検証: `grep -n "cmux-team stop" skills/cmux-team/manager/daemon.ts` で 0 件
- Decision D11 通りの純観測ログに統一

### A-7 cmux-team stop 言及の grep (コード側)

**Status:** ✅ Pass

**根拠:**
- `skills/cmux-team/manager/` 以下で `cmux-team stop` 残存箇所は 2 ファイルのみ:
  - `main.test.ts:1479, 1499` — T286 で追加した削除検証テストの describe 名/テスト名（意図的残存）
  - `pidfile.test.ts:145, 146, 148` — PidFileLockedError メッセージに stop 言及が **含まれないこと** の negative assertion（意図的残存）
- daemon.ts / main.ts / i18n.ts / pidfile.ts いずれも 0 件

### A-8 `applyDiscardOnly` 抽出と `applyRestorePlan` の呼び出し構造

**Status:** ✅ Pass

**根拠:**
- `daemon.ts:1011` — `applyRestorePlan` 内の C/E ブロックが `await applyDiscardOnly(state, plan)` 1 行に置換
- `daemon.ts:1218` — `initializeLayout` の fallback 分岐から同ヘルパ呼び出し
- 定義 (L1123) + 呼び出し 2 件で合計 3 件 (`grep -c "applyDiscardOnly" daemon.ts` で 4 件: JSDoc 引用 1 + 関数名 1 + 呼び出し 2)
- bit-identical 性 (Decision D2) が保たれている

---

## B. テスト充足性

- **M17a / M17b / M17c 網羅:** ✅
  - `daemon.test.ts:3570-3798` に 4 テスト追加 (M17d 任意含む)
  - M17a = E-only / M17b = C-only / M17c = C+E 混在 / M17d = resumePlan 透過
- **cmdStop unknown command テスト:** ✅
  - `main.test.ts:1481-1513` `describe("cmdStop 廃止 (T286)")` 配下 2 件
  - exit code 1 + stderr に `Unknown command: stop` + 2 回連続呼び出しでも同挙動 (idempotency)
- **pidfile.test.ts の更新:** ✅
  - `pidfile.test.ts:145-153` に T286 S6 の 2 テスト追加
  - message に `cmux-team stop` が **含まれないこと** + `kill <pid>` と `cmux` 案内が含まれること
- **既存 conductor が生きている場合の冪等性テスト:** △ Warn (但し GO/NOGO に影響しない)
  - M6/M7/M10 等の既存テストで alive 経路は保証されているが、「既存 conductor が全て alive + `cmux-team start` 再投入で fallback 発動しない」ケースの専用テストは新規追加なし
  - ただし plan.md §5.2 エッジケース表で fallback 発動条件が `0/0/0` であることは明確で、M17 が `3/0/0` 以外のケースに拡大しないことを間接的に保証
  - 必須ではない（plan.md S3 の completion criteria に含まれていない）

**網羅性サマリ:** plan.md S3 L362-364 の完了条件「M17a/M17b/M17c 3 件が pass + 既存 M6〜M16 が pass」を満たしている。任意 M17d も追加されており、Major #4 の Recommendation を超える網羅。

---

## C. ビルド & 型検査

```
$ bun test --timeout 600000
852 pass
0 fail
2057 expect() calls
Ran 852 tests across 28 files. [43.30s]
```

```
$ bunx tsc --noEmit 2>&1
conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3956,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
daemon.ts(1597,22): error TS2352: Conversion of type 'string | undefined' to type '{ type: "SESSION_STARTED"; ... }' may be a mistake ...
```

- **新規エラー:** 0 件
- **既存エラー:** 3 件（plan.md §6.2 許容範囲と完全一致。conductor.ts:201 / daemon.test.ts:3956 / daemon.ts:1597。行番号 1538→1597 は T286 fallback 分岐追加による既存エラー位置のシフト）

---

## D. ドキュメント整合性

- **README.md:** ✅ `cmux-team stop` 行削除 + blockquote 注記追加 (L102、テーブル外に配置されており markdown valid) + 「Panes too narrow」節を `kill`/cmux exit に書き換え
- **README.ja.md:** ✅ 同上 (L102 に注記、L183 コード例整形、L311 「ペイン狭」節書き換え)
- **CLAUDE.md:** ❌ **Fail**
  - L283 E2E クリーンアップ節は修正済 (✅)
  - **L434 に `cmdStop（保険）` の言及が残存**（pidfile release 経路の列挙から削除されていない）
  - plan.md §3.1 表 (L227) 「`CLAUDE.md:434` 「cmdStop（保険）」言及 | `cmdStop` を削除、release 経路の列挙からも除く」と明示指示があった
- **docs/spec/:**
  - `01-skill-cmux-team.md`: ⚠️ **Warn** — L69 に注記追加済だが **テーブル内部** に挿入されており、L70 以降のテーブル行のレンダリングが破損する (L66-67 がテーブル先頭 2 行 → L68 空行 → L69 blockquote → L70- 残りのテーブル行)。plan.md §3.1 (L228) では「行削除」が指示されていたが、注記追加方式を採るなら少なくとも L77 (テーブル末尾) の後ろに移動すべき
  - `03-commands.md`: ✅ 注記追加方式 (L8) で plan §2.2 + D17 の意図通り
  - `05-install-and-infrastructure.md`: ✅ `git diff` に出ていない (変更なし)。ただし plan §3.1 (L230) では「サブコマンド表 | 行削除」指示があった **→ ⚠️ Warn に訂正**: 該当ファイルが変更されていないため、`cmux-team stop` 行が残っている可能性
  - `06-implementation-tasks.md`: ✅ Task 2.4 のステータスを「廃止（T286, v4.3.0）」に変更し説明文も差し替え済
- **CHANGELOG.md:** ✅ `[Unreleased]` 節に `### Changed (Breaking)` + `### Fixed` の 2 エントリ追加済。`[4.2.0] - 2026-04-21` は touch されていない (Major #6 / D15)
- **templates/:** ✅ `grep -rn "cmux-team stop" skills/cmux-team/templates/` で 0 件
- **skills/cmux-team/SKILL.md:** ✅ コマンド表から行削除 + `cmux-team send SHUTDOWN` 行に「内部用。明示停止は `kill <pid>`」注記追加
- **skills/cmux-team-guide/SKILL.md:** ✅ L53 の「停止」コード例を書き換え + L102 コマンド表から行削除

**追加検証 (docs/spec/05-install-and-infrastructure.md):** 以下 grep で確認:
```
$ grep -n "cmux-team stop" docs/spec/05-install-and-infrastructure.md
(該当なし)
```
→ 実は元ファイルに `cmux-team stop` 行が存在しない可能性があり Planner の想定が外れていた。`git diff main...HEAD -- docs/spec/05-install-and-infrastructure.md` でも変更なしだが、実ファイルにも stop 言及なしなので問題なし (✅)

---

## E. Decision Log 整合性

### D11: `layout_mismatch_on_resume` 純観測ログ化

**Status:** ✅ Pass

**根拠:** `daemon.ts:1165-1168` でメッセージは `restored=${restoredLayout} current=${state.layout}` のみ。旧行動案内 (`run 'cmux-team stop' then 'start --layout=...' to rebuild` / `existing panes will be kept`) は完全削除。fallback 発動時に `layout_restore_empty_fallback` が別途出るので追加案内は不要という D11 本文と一致。

### D12: reason filter contract

**Status:** ✅ Pass

**根拠:** `applyDiscardOnly` L1137-1144 で `reason === "surface_missing_no_task"` 以外の discarded 行はスキップ。`pid_dead_idle_cleanup` reason は C 経路の `conductor_stale_surface_closed` に任せ、二重出力を防ぐ。M17b テスト (`expect(logContent).not.toContain("conductor_discarded")`) で実挙動も verify 済。

### D13: sequential 実行

**Status:** ✅ Pass

**根拠:**
- `applyDiscardOnly` 内で `Promise.all` 未使用 (grep 0 件)
- M17b テストで `closeCalls` の順序が入力順 `["surface:52", "surface:53", "surface:54"]` と一致することを `toEqual` で検証 (`daemon.test.ts:3670`)
- JSDoc L1114 で sequential 契約明示

### D14: layout_mismatch_on_resume 純観測化 (resumePlan 透過)

**Status:** ✅ Pass

**根拠:** `daemon.ts:1219-1227` — fallback 経路でも `initializeConductorSlots(state.projectRoot, state.conductors, state.maxConductors, daemonSurface, resumePlan, state.layout, state.mainBranch)` と team.json 空経路 (L1182-1190) と完全同一シグネチャで呼び出し。M17d テスト (`daemon.test.ts:3773-3798`) で `resumePlan=2 件 → assignments.length === 2 && state.conductors.size === 2` が verify 済。

### 追加チェック: D2 (applyDiscardOnly 抽出で applyRestorePlan と bit-identical)

**Status:** ✅ Pass

**根拠:** `applyRestorePlan` L1007-1011 で `applyDiscardOnly(state, plan)` を呼び、旧 inline C/E ブロックを完全置換。M6〜M16 の既存テスト (既存 applyRestorePlan 経路のみを verify) が全て pass のため回帰なし。

### 追加チェック: D16 (applyDiscardOnly 名称維持 + JSDoc 明示)

**Status:** ✅ Pass

**根拠:** `daemon.ts:1101-1122` の JSDoc で「ここでの "discard" は『conductor entry を `state.conductors` に登録しないで流す』という広義の意味で、C 経路の close-surface 副作用も含む（Minor #7）」と明示。

---

## F. Fix Required (NOGO の場合)

Round 2 Implementer に対する具体指示:

### F-1 CLAUDE.md L434 から `cmdStop（保険）` 言及を削除 【必須】

**ファイル:** `/Users/yamamoto/git/cmux-team/.worktrees/task-286-1776739185/CLAUDE.md`

**該当箇所 (L431-436):**
```
stale 判定は `isAlive(pid)` false を優先、alive でも `ps -p <pid> -o command=` 出力に
`main.ts` / `cmux-team` が含まれなければ PID 再利用とみなして上書き。ps 取得失敗
（空文字）時は保守的に locked 扱いとする。pidfile は shutdown / onFullQuit /
restartRequested / onReload / cmdStop（保険）の全経路で release され、正常系では
必ず削除される。pidfile は daemon main.ts プロセスのみを指し、proxy は別ライフ
サイクル。
```

**修正指示:** `restartRequested / onReload / cmdStop（保険）の全経路で` の `/ cmdStop（保険）` を削除し、`restartRequested / onReload の全経路で` に書き換える。plan.md §2.2 + §3.1 表 (L227) の「release 経路の列挙からも除く」指示通り。

**修正後 (L433-434):**
```
（空文字）時は保守的に locked 扱いとする。pidfile は shutdown / onFullQuit /
restartRequested / onReload の全経路で release され、正常系では
```

### F-2 docs/spec/01-skill-cmux-team.md の blockquote 位置修正 【必須】

**ファイル:** `/Users/yamamoto/git/cmux-team/.worktrees/task-286-1776739185/docs/spec/01-skill-cmux-team.md`

**該当箇所 (L64-79):** 現状は markdown テーブルの途中 (L67 と L70 の間) に blockquote が差し込まれており、L70 以降の `| cmux-team send TASK_CREATED | ... |` 以下 10 行超のテーブル行が 1 つのテーブルとしてレンダリングされない (CommonMark 仕様: 空行でテーブル終端)。

**修正指示:** L68 の空行 + L69 blockquote + L70 以降のテーブル行すべてを「コマンド表全体が 1 テーブル」として完結させ、blockquote はテーブル末尾 (最終行の後、次セクション見出しの前) に移動する。

**案 (修正後の L64 付近):**
```markdown
| コマンド | 説明 |
|---------|------|
| `cmux-team start` | daemon 起動 + Master spawn + レイアウト構築（レイアウト消失時は自己修復。T286） |
| `cmux-team status` | ステータス表示（team.json + ログ末尾） |
| `cmux-team send TASK_CREATED` | タスク作成通知（`--task-id`, `--task-file` 必須） |
| `cmux-team send <TYPE>` | 内部メッセージ通知（... ） |
| ... (残りのテーブル行)  |
| `cmux-team self-update` | ... |

> `cmux-team stop` は v4.3.0 で廃止（T286）。cmux セッション終了で daemon が自動停止するため不要。手動停止は `kill <pid>`（`.team/daemon.pid`）で行う。
```

（具体的にはテーブル全体が何行あるかに応じて、表の最終行の直後 + 次の見出し (`##` / `**...:**` 等) の前に blockquote を挿入する）

### F-3 [任意] i18n.ts の空行 2 連続整形 【軽微 / GO/NOGO に影響しない】

**ファイル:** `/Users/yamamoto/git/cmux-team/.worktrees/task-286-1776739185/skills/cmux-team/manager/i18n.ts`

**該当箇所:**
- L181-184 (en side): `help_status` の閉じ括弧の後に空行 2 行連続 → 他の help エントリ間隔は空行 1 行
- L846-849 (ja side): 同パターン

**修正指示:** 各空行 2 連続を空行 1 行に詰める (Minor #11 の integrity)。Round 2 の本題ではないため、F-1/F-2 修正と同じ round で手直しして構わない。

---

## G. 補足コメント (GO の場合)

NOGO のため省略 (F 修正後に追記される想定)。

参考として GO 時の補足候補を短く列挙しておく:

- S9 完了後の任意推奨作業 (Minor #12 / D5): `initializeLayout` の state-machine 化 (`LayoutRestoreReducer` + `LayoutRestoreEffects` への再分割) を artifact (type=decision) として起票することで、後続 refactor 候補を追跡可能に。`/artifact decision "T286 後続: initializeLayout state-machine 化"` 相当
- fallback 発動条件は `plan.unmatchedResumes.length` を見ていないため、`maxConductors < resumePlan.length` のような過剰 resume が混在するケースの挙動は既存 `initializeConductorSlots` の 1:1 分配仕様に委ねる設計。理論的には `maxConductors=3` + resume=5 件のケースで余剰 resume が失われる既存挙動だが、再現性が低く T286 スコープ外で妥当
- `applyDiscardOnly` の `_state` 引数は現状未使用。JSDoc で「将来拡張用」と明示されている通り、`applyRestorePlan` とシグネチャを揃えるための意図的な設計で問題なし
