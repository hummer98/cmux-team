# T253 検品レポート

## 判定: GO

plan.md / design-review (Approved + N1-N4 minor) / summary.md の指示は本質的に全て反映され、`bun test` 530 pass / 0 fail、grep 検査（`|| "main"` / `?? "main"` / `= "main"`）も本体コードで 0 件。破壊的変更（`MainBranchSource` から `"fallback"` 削除、`resolveMainBranch` の throw 化、`cmdStart` / `cmdConductor` / `cmdSpawnConductor` の fail-stop、下流 5 箇所の throw ガード統一）が整合的に揃っている。下記「Minor Suggestions」に 2 点（ドキュメント文言のズレ / シグネチャ書式の軽微な不整合）を挙げるが、いずれもブロッカーではない。

## 検査観点ごとの結果

### A. 要件適合性

- ✅ **A1. `resolveMainBranch` が失敗で `MainBranchResolutionError` を throw** — `main-branch.ts:96` で実装。`originHeadStderr` / `headStderr` を保持するカスタムエラークラス (`main-branch.ts:27-39`) が JSDoc 通りに整備されている。
- ✅ **A2. `MainBranchSource` enum から `"fallback"` 削除** — `schema.ts:309` で `z.enum(["config", "detected"])` に縮減。型レベルで fallback 参照がコンパイル不能になる。
- ⚠️ **A3. `cmdStart` catch + `process.exit(1)` + 3 つの解決手段案内** — `main.ts:319-358` で `MainBranchResolutionError` を捕捉し、console.error → `main_branch_resolve_exit` ログ → `process.exit(1)`。`instanceof` チェック外のエラーは `throw e` で再送出される構造。catch は try の直後に位置し、`process.exit(1)` が想定外エラーで呼ばれることはない。**ただし案内されているのは (A) `.team/config.json` の `mainBranch` / (B) env `CMUX_TEAM_MAIN_BRANCH` の **2 案のみ**で、inspection 観点が要求する `--main-branch` CLI フラグは案内されていない（後述 F1 参照）。これは plan.md §3.2 のエラーメッセージ文面そのままで、plan との整合性は取れている。**ドキュメント側（CLAUDE.md / CHANGELOG / docs/spec）が「3 つの解決手段」と書いている点との乖離のみ Minor。
- ✅ **A4. `cmdConductor` が env 空文字で fail-stop** — `main.ts:1693-1704` で `envMainBranch \|\| conductorConfig.mainBranch?.trim() \|\| ""` → `!mainBranch` なら `console.error` + `conductor_main_branch_missing` ログ + `process.exit(1)`。同じロジックが `cmdSpawnConductor`（`main.ts:1908-1924`、`spawn_conductor_main_branch_missing` ログ）にも移植されており、plan.md §2 に無かった経路への横展開も整合的。
- ✅ **A5. 下流 `\|\| "main"` / `?? "main"` 全撤去** — `conductor.ts` の `launchConductor` / `initializeConductorSlots` / `assignTask`、`template.ts` の `generateConductorTaskPrompt` / `generateConductorRolePrompt` の計 5 箇所で `if (!mainBranch.trim()) throw new Error(...)` パターンに統一（N2 適用済み）。`|| "main"` / `?? "main"` は本体コードから 0 件。

### B. TDD 品質

- ✅ **B1. throw 検証テスト存在** — `main-branch.test.ts:105-117`（`MainBranchResolutionError` を rejects.toThrow で検証）、`main-branch.test.ts:119-138`（stderr フィールド保持検証）。
- ✅ **B2. 旧 `source=fallback` テスト削除** — grep で `source=fallback` / `source.*fallback.*branch.*main` の残留 0 件。旧挙動の検証コードは消えている。
- ✅ **B3. エッジケーステスト** — `main-branch.test.ts:140-176` に garbage prefix（origin/HEAD 異常フォーマット + HEAD 失敗）/ 空 configMainBranch + 両 git 失敗 / 空白のみ configMainBranch + 両 git 失敗 の 3 ケースが追加されている。
- ✅ **B4. `bun test` 全緑** — 自分で `cd skills/cmux-team/manager && bun test` を実行し、**530 pass / 0 fail / 1194 expect() calls (20.04s)** を確認。summary.md の記載と完全一致。

### C. grep 検証

plan.md §7 の 3 コマンドを `.worktrees/task-253-1776519448` で実行した結果:

```bash
$ rg '\|\| "main"' skills/cmux-team/manager/ --type ts
# → 0 件 ✅

$ rg '\?\? "main"' skills/cmux-team/manager/ --type ts
# → 0 件 ✅

$ rg '= "main"' skills/cmux-team/manager/ --type ts
# → 2 件（いずれも daemon.test.ts 内の state.mainBranch = "main" 明示セット）✅
#   daemon.test.ts:367  (scanTasks: assignTask エラー分離)
#   daemon.test.ts:2711 (depends_on cascade T241)
# T253 コメント付きで、意図的な補正セットであることが明示されている
```

補助で行った `rg 'mainBranch.*string\s*=\s*"main"'` / `rg 'source=fallback|main_branch_fallback'` / `rg '"--main-branch"'` 系も全て 0 件（本体コード）。本体コードの暗黙フォールバックはゼロ。

### D. ドキュメント更新

- ✅ **D1. `CLAUDE.md`** — L628-643 で `mainBranch` 優先順位が 2 段（env / config）に縮減、第 3 段に「両方失敗なら fail-stop (`process.exit(1)`)」を追記、T253 破壊的変更の回避方法（env / config の明示指定）を L643 に記載。
- ✅ **D2. `docs/spec/05-install-and-infrastructure.md`** — L424 で `mainBranch` 説明が「fallback `"main"`」削除 → 「**T253 破壊的変更:** 全て失敗した場合は `cmux-team start` が `MainBranchResolutionError` を throw → console.error に解決手段… `process.exit(1)` する」に差し替え。`main_branch_resolved` の source 列挙も `<config|detected>` の 2 値に縮退済み。
- ✅ **D3. `docs/spec/04-templates.md`** — L444 の `{{BASE_BRANCH}}` 説明から `"main"` フォールバック削除、L445 の `{{MAIN_BRANCH}}` 説明に「**T253**: `cmdStart` レベルで解決失敗は fail-stop。`generateConductorRolePrompt` / `generateConductorTaskPrompt` は空文字を受け取ったら防御的に throw する」を追記。
- ✅ **D4. `CHANGELOG.md`** — L3-7 に `[Unreleased] ### Changed` エントリを追加。旧挙動・新挙動・撤去対象（`cmdConductor` / `cmdSpawnConductor` / `DaemonState` 初期値 / `launchConductor` / `initializeConductorSlots` / `assignTask` / `generateConductorTaskPrompt` / `generateConductorRolePrompt`）・影響範囲（既存 config 永続化済みは影響なし / 新規 repo push 前は要対応）・救済手段を網羅。`**BREAKING:**` は明記していないが「**(T253、破壊的変更)**」で同等の告知効果あり（minor bump + 強告知の T242/T250/T229 パターンに準拠）。

### E. 副作用・回帰

- ✅ **E1. `createDaemon` で `mainBranch: ""`** — `daemon.ts:235` で空文字初期化。JSDoc (`daemon.ts:93-97`) に「初期値は空文字。T253 で下流にも空文字ガードを置いて二重防御」の意図が記述されている。
- ✅ **E2. `daemon.test.ts` 補正** — `daemon.test.ts:367` と `:2711` で `state.mainBranch = "main"` を明示セットし、T253 コメントで意図（「git 失敗の分類テストなので assignTask が mainBranch empty で早期 throw しないよう」）を記述。現行 2 箇所のみで plan.md §2 の想定通り。
- ✅ **E3. `launchConductor` の `opts` required 化（N1）** — `conductor.ts:85-88` で `opts: { resumeTaskId?: string; mainBranch: string }` に変更（optional `?` なし）。呼び出し元の `initializeConductorSlots` と `cmdSpawnConductor` も明示渡しで追従。
- ✅ **E4. `generateConductorTaskPrompt` の `mainBranch` required（N4）** — `template.ts:150-167` で `mainBranch: string`（`?` なし）。空文字 throw ガードも冒頭で検査。`generateConductorRolePrompt` (`template.ts:65-75`) も同様の変更・ガードが適用されている。
- ✅ **E5. `!mainBranch.trim()` パターン統一（N2）** — 5 箇所（`launchConductor` / `initializeConductorSlots` / `assignTask` / `generateConductorTaskPrompt` / `generateConductorRolePrompt`）全てで `if (!mainBranch.trim())` 形式に統一。`!mainBranch || !mainBranch.trim()` のような冗長な二重チェックは残っていない。

### F. 見落とし探し

- ⚠️ **F1. ドキュメント内の「`--main-branch` CLI フラグ」は実在しない** — `CLAUDE.md:639`、`CHANGELOG.md:7`、`docs/spec/05-install-and-infrastructure.md:424`、`summary.md:15` が「3 つの解決手段（`--main-branch <name>` / env / config）」と記述しているが、`main.ts` に `--main-branch` フラグの `getArg`/`requireArg` 実装は無い（`rg '"--main-branch"|main-branch' skills/cmux-team/manager/main.ts` → 0 件で確認）。実エラーメッセージ（`main.ts:325-350`）は (A) `.team/config.json` / (B) env `CMUX_TEAM_MAIN_BRANCH` の 2 案のみ提示しており、plan.md §3.2 の文面とは一致している（plan も 2 案のみ）。**ドキュメント側の記述 3 箇所を 2 案に統一するか、`--main-branch` CLI フラグを実装するかのどちらかで整合を取るのが望ましい**。Minor — 実動作には影響しないため GO 判定を変更しない。
- ✅ **F2. 古いコメント残留の探索** — `rg '"main" フォールバック|main フォールバック|default main' CLAUDE.md docs/spec/ README.md README.ja.md` で残留 0 件。`main_branch_fallback` のログイベントも manager コードから消えている。
- ✅ **F3. `"main"` ハードコード残留** — テスト以外では 0 件。`docs/spec/05-install-and-infrastructure.md:417` の config 例 JSON に `"mainBranch": "main"` があるが、これは汎用サンプル値（フォールバック記述ではない）なので問題なし。
- ✅ **F4. `process.exit(1)` 位置確認** — `main.ts:357` の `process.exit(1)` は catch ブロック内 + `if (e instanceof MainBranchResolutionError)` ガード下に配置され、他例外は `throw e`（L359）で再送出。catch の外に漏れる経路はなく、想定外エラーで exit してしまう問題は存在しない。エラーメッセージは日本語＋英語混在で、救済手段 / 原因候補 / 診断情報（stderr）を段組で提示しており、plan.md §3.2 の要求 UX を満たす。
- ⚠️ **F5. `initializeConductorSlots` のシグネチャで required 引数が optional の後ろにある（軽微）** — `conductor.ts:190-198` は `(projectRoot, conductors, count = 3, daemonSurface?, resumePlan?, layout = "wide", mainBranch: string)` と、required `mainBranch` が optional/default 群の後ろに位置する。TypeScript はこれをエラーにしないが、呼び出し側で部分省略ができなくなるため書式としては推奨されない。現状の唯一の呼び出し元（`daemon.ts:897` で全引数明示渡し）に実害なし。Minor — plan.md が既存シグネチャに従って「デフォルト削除のみ」を指示していた経緯を踏まえれば意図通り。

## Fix Required（NOGO の場合のみ）

NOGO ではないため該当なし。

## Minor Suggestions（非ブロッカー）

1. **ドキュメント文面の整合: `--main-branch` 記載の処理**（F1）
   対象箇所: `CLAUDE.md:639` / `CHANGELOG.md:7` / `docs/spec/05-install-and-infrastructure.md:424` / 本作業の `summary.md:15`。
   案 1: 実装に合わせてドキュメントを「2 つの解決手段（env `CMUX_TEAM_MAIN_BRANCH` / `.team/config.json` の `mainBranch`）」に修正する（実装変更なし、ドキュメントのみ 3 ファイル短い差分）。
   案 2: `--main-branch <name>` CLI フラグを `cmdStart` に追加し、`getArg("main-branch")` を `startConfig.mainBranch` より上位に挿入する。plan.md §2 には無い新規実装のため、別タスク化が望ましい。
   **推奨: 案 1**。plan.md §3.2 が明確に 2 案ベースで書かれており、ドキュメント側の後付け記述が先行した誤記と考えられる。

2. **`initializeConductorSlots` シグネチャの引数並び替え（任意の refactor）**（F5）
   `mainBranch` を先頭寄り（`projectRoot, conductors, mainBranch, count = 3, ...`）に移動すると required-first の TS 慣習に沿う。現状で動作は正しく回帰もないため、別タスクの cleanup 候補とするのが自然。

3. **エッジケース手動 E2E（plan.md §7 case 4 / 5）の自動スクリプト化**（設計レビュー追加提案相当）
   `.team/tasks/253-mainbranch-fail-stop/runs/task-253-1776519448/e2e.sh` 等に `CMUX_TEAM_MAIN_BRANCH=`（空文字）/ 壊れた config `mainBranch: ""` の再現コマンドを残すと、後続の同種破壊的変更でリグレッション検知に使える。今回の TDD は unit test で十分担保されているため必須ではない。
