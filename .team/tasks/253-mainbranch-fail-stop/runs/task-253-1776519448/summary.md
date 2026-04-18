# T253 実装サマリ — mainBranch 暗黙フォールバック削除 + fail-stop

## 1. 作業概要

`resolveMainBranch` の検出失敗時にサイレントで `"main"` を返す挙動を撤廃し、`cmux-team start` レベルで `process.exit(1)` に倒す破壊的変更を実装した。併せて下流（`cmdConductor` / `cmdSpawnConductor` / `DaemonState.mainBranch` 初期値 / `launchConductor` / `initializeConductorSlots` / `assignTask` / `generateConductorTaskPrompt` / `generateConductorRolePrompt`）の `"main"` リテラルフォールバックを一括撤去し、空文字受領で throw する防御ガードに統一（上流 throw + 下流 guard の double defense）。

## 2. 変更ファイル一覧（14 ファイル、+293 / -53 行）

### 実装コード（TypeScript）

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/schema.ts` | `MainBranchSource` enum から `"fallback"` を削除 |
| `skills/cmux-team/manager/main-branch.ts` | `MainBranchResolutionError` class を新規追加。`resolveMainBranch` の最終 fallback を `throw new MainBranchResolutionError(...)` に置換。JSDoc 更新 |
| `skills/cmux-team/manager/main.ts` | `cmdStart` で `resolveMainBranch` を try/catch し、`MainBranchResolutionError` を 3 つの解決手段ガイダンス（env / config / `--main-branch`）付きで `console.error` → `process.exit(1)`。`cmdConductor` / `cmdSpawnConductor` の `\|\| "main"` 撤去・空文字 fail-stop 追加 |
| `skills/cmux-team/manager/daemon.ts` | `createDaemon` の `mainBranch: "main"` → `""`。JSDoc 更新 |
| `skills/cmux-team/manager/conductor.ts` | `launchConductor`: `opts?` → 必須 `opts`、`mainBranch` required。`initializeConductorSlots` / `assignTask`: `mainBranch: string = "main"` デフォルト撤去・空文字 throw ガード追加（N2 統一パターン） |
| `skills/cmux-team/manager/template.ts` | `generateConductorTaskPrompt`: `mainBranch?: string` → `mainBranch: string`（N4）、`?? "main"` 撤去。`generateConductorRolePrompt` にも空文字 throw ガード追加（二重防御） |

### テスト

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/main-branch.test.ts` | 旧「両方失敗で source=fallback」テストを削除。throw 検証 + stderr 保持 + エッジケース 3 件（garbage prefix / 空 config / 空白のみ config）を追加、計 14 テスト |
| `skills/cmux-team/manager/conductor.test.ts` | 既存 `assignTask` 呼び出し 3 箇所に `, "main"` 引数追加。新 describe `mainBranch required 化 (T253)` に 4 テスト追加（`assignTask` / `launchConductor` × `""` / `"  \n"`）|
| `skills/cmux-team/manager/daemon.test.ts` | `generateConductorTaskPrompt` 呼び出しに `undefined, undefined, "main"` 追加。`scanTasks: assignTask エラー分離` と `depends_on cascade (T241)` の git 失敗テスト 2 件で `state.mainBranch = "main"` を明示セット（従来の createDaemon 既定値 `"main"` 依存から空文字 `""` に変わったため、意図通り git 段階で `AssignTaskError("task")` が出るよう補正）|

### ドキュメント

| ファイル | 変更内容 |
|---------|---------|
| `CLAUDE.md` | `mainBranch` 優先順位から「`"main"` フォールバック」行を削除し、fail-stop 記述 + T253 破壊的変更注記を追加 |
| `docs/spec/05-install-and-infrastructure.md` | `mainBranch` 解決順位の説明から `fallback "main"` を削除、fail-stop 挙動に更新 |
| `docs/spec/04-templates.md` | `{{BASE_BRANCH}}` / `{{MAIN_BRANCH}}` の説明から `"main"` リテラルフォールバック記述を削除、防御 throw 挙動を追記 |
| `CHANGELOG.md` | `[Unreleased]` に `### Changed` として T253 破壊的変更を追記（影響範囲・回避方法を明記）|

## 3. テスト結果

`bun test` を `skills/cmux-team/manager/` で実行:

```
530 pass
 0 fail
 1194 expect() calls
Ran 530 tests across 23 files. [20.04s]
```

全 530 テスト緑。テスト追加内訳: main-branch.test.ts +5 テスト（throw / stderr / エッジ 3）、conductor.test.ts +4 テスト（assignTask / launchConductor × 空文字 / 空白）。計 +9 テスト増。

## 4. grep 検証

`plan.md §7` の通り、本体コード（manager/ 配下）から `"main"` リテラルフォールバックが残存しないことを確認:

| パターン | 結果 |
|---------|------|
| `\|\| "main"` | 0 件 |
| `?? "main"` | 0 件 |
| `= "main"` | 2 件（いずれも `daemon.test.ts` でテスト目的に意図セットした `state.mainBranch = "main"`）|

本体コードのフォールバック残存はゼロ。

## 5. N1–N4 minor improvements 適用状況

| 項目 | 内容 | 状態 |
|------|------|------|
| N1 | `launchConductor` の `opts` を optional → required に変更 | ✅ 適用 |
| N2 | 空文字検出ガードを `if (!mainBranch.trim())` で統一（`assignTask` / `initializeConductorSlots` / `launchConductor` / `generateConductorRolePrompt` / `generateConductorTaskPrompt`、計 5 箇所）| ✅ 適用 |
| N3 | `conductor.test.ts` の新規テストは TDD 順序（test-first）で追加する | ⚠️ 計画から逸脱（test-after-implementation で追加）。理由: 本 TDD の本体は `main-branch.test.ts` の throw 挙動検証であり、そちらは test-first で実施済み。`conductor.test.ts` の空文字入力テストは「N2 で追加するガード」の回帰防止であり、実装完了後に追加した |
| N4 | `generateConductorTaskPrompt` のシグネチャを `mainBranch?: string` → `mainBranch: string` に変更 | ✅ 適用 |

## 6. 想定外の課題と対処

- **`cmdSpawnConductor` の launchConductor 呼び出し**: N1 で `launchConductor` の opts を required 化した際、plan.md §2 には記載されていなかった `cmdSpawnConductor`（`main.ts:1908` 付近）が `launchConductor(PROJECT_ROOT, surface)` と opts 無しで呼んでおり、そのままだと型エラーで build 不能になった。`cmdConductor` と同じ env → config 解決 + 空文字 fail-stop ロジックを移植して対処。
- **`daemon.test.ts` の既存 git 失敗テスト 2 件が fail**: `createDaemon` の `mainBranch` 初期値を `""` に変更したことで、テストが `assignTask` を呼ぶと git 到達前に「mainBranch must be a non-empty string」で throw → 非 `AssignTaskError` 経路に落ち Conductor が `disconnected` になるため、従来の期待値（`idle` のまま / 親タスク aborted）に合わなくなった。本番では `cmdStart` が必ず `state.mainBranch` を解決してから `scanTasks` が走るため、テストでも `state.mainBranch = "main"` を明示セットする方式で修正（コメントで意図を明記）。
- **`main-branch.ts` の JSDoc 括弧記号**: 初回 Edit が半角 `()` を指定したが実ファイルは全角 `（）` を使用していたため Edit が fail。Read で正確な文字を確認してから再 Edit で対応。

## 7. 残作業

- 本作業は **worktree 内のみ** で完結しており、commit / merge / push は行っていない（プロンプト指示準拠）。
- user 側で PR 化・merge を判断する前提。
