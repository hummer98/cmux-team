# Design Review: T292 plan.md

## Verdict

**Approved**

## Summary

plan.md は汚染経路（`logger.ts:67` の cwd fallback）の特定、33 テストの網羅的分類、ヘルパー API 設計、段階的実装ステップ、リスク回避策を十分にカバーしている。Critical な設計欠陥・検証不能な受け入れ条件・実装不可能な順序は見当たらない。いくつかの Recommendations はあるが、いずれも Approved を妨げないレベル。

## Strengths

- **汚染経路の正確な特定**: `logger.ts:67` の `process.env.PROJECT_ROOT || process.cwd()` を主原因として特定し、production 側の 4 箇所の env 設定経路（`main.ts:125 / 2007 / 2100 / 2155`）を押さえている。実ファイル照合でも一致。
- **33 テストの分類精度**: A=10 / B1=4 / B2=7 / B3=1 / C=11 の合計が 33 に一致。`grep` 結果でも Category A の 10 ファイルが `process.env.PROJECT_ROOT` を触っていることを確認済み。B1（task / trace-store / pidfile / preflight）が「mkdtemp するが env を触らない」ことも裏取りできた。
- **二層防御の順序**: Step C（helper 導入で汚染封じ）→ Step B（strict モード）の順序が正しい。逆にすると既存テストが赤化して壊れる、という判断も妥当。
- **process.chdir を不採用とした根拠**: bun 並列実行モデル・async I/O の race・テスト要件への明記、いずれも設計原則と整合。
- **ファイル単位コミット**: C-1 (10)、C-2 (4)、C-3 (7)、C-4 (1) をファイル単位で分けるのは bisect 用に極めて合理的。C-2 優先着手も妥当（task.test.ts が T290 で既に 4454 行混入した実績あり）。
- **dispose の try/finally**: `rm` 失敗でも env を確実に復元する設計は後続テスト汚染を防ぐ。二重 dispose 対策（`disposed` フラグ）も妥当。
- **logger.test.ts の遅延評価テストへの配慮**: `setProjectRootEnv: false` オプションでの迂回経路を用意済み。
- **作業境界の明示**: production 側（`main.ts:findProjectRoot`, `logger.ts` の cwd fallback 削除、`task.ts` / `daemon.ts` の projectRoot 解決）を境界外にしているのは破壊的変更回避として適切。

## Findings

### Critical（Approved を妨げる）

（なし）

### Recommendations（改善提案、必須ではない）

1. **`savedEnv` スナップショットの非再入性** (§2.1 `createDummyProject` 実装スケッチ)
   - 同一プロセスで `createDummyProject` がネスト or 並列で呼ばれた場合、後発の savedEnv が前発の root を拾ってしまい、先に dispose した側が相手の env を復元してしまう事故が起きうる。
   - docstring に「同一プロセス内並行は未対応」と明記する案は plan に記載済みだが、さらに **グローバル depth カウンタ or 一番最初の実 env を `Symbol.for("cmux-team-test-original-env")` で保持** すると防衛的。
   - 優先度: 低（beforeEach/afterEach の sequential 使用では発現しない）

2. **bun test の process model 記述の厳密さ** (§2.2)
   - "bun test はファイル単位で別プロセスの worker として並列実行される" とあるが、bun test は **デフォルトで同一プロセス内で test file を順次読み込む**（Jest と違い worker 分離しない）。env 復元が beforeEach/afterEach で行われるため design 自体は robust なので実害はないが、記述としては「**ファイル内 test は sequential に走り、beforeEach/afterEach で env を復元するため安全**」に書き換えるとより正確。
   - 優先度: 低（design に影響しない）

3. **Step B-3 の test script 追加は "更新" ではなく "新規追加"**
   - 現状 `skills/cmux-team/manager/package.json` に `"test"` script が存在しない（verification で確認: scripts セクション自体なし）。plan の「test script を更新する」を「test script を新規追加する」に直すとより正確。
   - 優先度: 低（実装時に自明）

4. **pseudocode の import 不足** (§2.1)
   - 実装スケッチで `writeFile` を呼んでいるが import 行には含まれていない（`mkdtemp, rm, mkdir` のみ）。
   - 実装時に忘れず追加する旨コメントを入れるか、import 行に `writeFile` を足しておく。
   - 優先度: 低（コンパイラが即座に検出）

5. **Step D スクリプトの false positive リスク** (§3 Step D)
   - `git status --porcelain .team/` は **テスト無関係な untracked ファイル**（例: `.team/logs/proxy.log`, `.team/traces/traces.db` の位置によっては既に gitignore 済みだが、他の開発中ファイル）を拾う可能性がある。
   - 対策案: `git status --porcelain .team/logs/manager.log .team/task-state.json .team/tasks/` のように **汚染対象の特定パスだけ** をチェックする、または `.team/logs/manager.log` の **行数差分** を見る方式に倒す。
   - 優先度: 中（CI ガードの信頼性に直結）

6. **受け入れ条件 #5 の "pre-existing 3 件" マジックナンバー** (§4)
   - `tsc --noEmit` の baseline 件数が 3 と固定されているが、どのエラーかが plan 内に記録されていない。実装者が「4 件になった」ときに「新規 1 件」か「既存 +1 件」の判定がつかない恐れあり。
   - 対策案: Step A 開始前に `bunx tsc --noEmit 2>&1 | tee .team/tasks/.../tsc-baseline.txt` を取って artifact 化する旨を plan に追記。
   - 優先度: 中（受け入れ判定の客観性に関わる）

7. **B2 の "最小介入" パターンの冗長性** (§3 C-3)
   - 「既存 mkdtemp をそのまま残し、project = createDummyProject も追加する」二段構えは、test 1 本あたり **2 つの tmp dir が作られる** ため若干の無駄が発生する。
   - 対策案: 既存 `testDir = mkdtemp(...)` を `testDir = project.root` に置換し、mkdtemp 呼び出しを削除する pattern を優先適用する。既存の subdirs とぶつかる場合のみ最小介入に fallback。
   - 優先度: 低（性能影響は微小、bisect 容易性を優先して現 plan 通りでも可）

8. **grep の件数記述のズレ** (§1.1)
   - plan は "`grep "process.env.PROJECT_ROOT"` で 11 ファイルヒット" と記述しているが、実測では test files 10 本 + source files 3 本（template.ts / main.ts / logger.ts）= 13 件。main.test.ts は `PROJECT_ROOT: testDir`（`process.env.` 接頭辞なし、spawn 時の env オブジェクト key）のため `grep "process.env.PROJECT_ROOT"` には引っかからない。
   - 影響: 分類と対応計画は正しい（Category B3 = main.test.ts = spawn env のみ）ので実害なし。記述を「10 ファイル（+ source 3 ファイル）」に直すとより正確。
   - 優先度: 低

9. **Step B の production 早期 log() 懸念への追加裏取り**
   - plan は `main.ts:125` の env 設定が「大半の log() より前」と記述。確認したところ main.ts 内の最初の `log()` は line 398（`pidfile_acquired`）で、line 125 の env 設定より十分後。他のモジュールの **module-top 副作用で log() が呼ばれる箇所** は grep 上見つからなかった。plan 通りの想定で問題なし（裏取り完了、plan 記述の補強として report）。

10. **logger.test.ts の遅延評価テストの詳細計画**
    - plan は「`setProjectRootEnv: false` で helper を使うか、従来パターンを残す」と選択肢を示すが、実装時にどちらを採るかは未決。logger.test.ts L112-151 の遅延評価テストは **env を意図的に未設定にして fallback 経路を検証** するため、`setProjectRootEnv: false` でも `project.dispose()` 内の env 復元ロジックは動作する（`setEnv === false` なら元々 save しないので）。この場合 `.team/logs/manager.log` は **project.teamDir 配下** に作られるため汚染は発生しない。実装時にこの経路で OK である旨を事前記述しておくとよい。
    - 優先度: 低

## Verification Evidence

以下、実ファイルを読んで裏取りした結果。

### `logger.ts:67` fallback
```
67:  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
68:  const logDir = join(projectRoot, ".team/logs");
```
→ plan 記述通り。

### `template.ts:29` fallback
```
27:export async function findTemplateDir(): Promise<string | null> {
28:  // 1. プロジェクトローカル（dev リポジトリを最優先）
29:  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
```
→ plan 記述通り（read-only 副作用のみ）。

### `main.ts` の env 設定箇所
```
125:process.env.PROJECT_ROOT = PROJECT_ROOT;
2007:  process.env.PROJECT_ROOT = PROJECT_ROOT;
2100:  process.env.PROJECT_ROOT = PROJECT_ROOT;
2155:  process.env.PROJECT_ROOT = PROJECT_ROOT;
```
→ plan 記述の 4 箇所に一致。

### `main.ts:124-126` の module-top 処理
```
124:const PROJECT_ROOT = findProjectRoot();
125:process.env.PROJECT_ROOT = PROJECT_ROOT;
126:process.chdir(PROJECT_ROOT);
```
→ plan は `:125` のみ言及しているが `:126` で **`process.chdir` も実行**されている。production 側では `chdir` 利用中だが、これは plan の「やらないこと § production daemon の破壊的変更」境界内なので影響なし。ただし §2.2 で "chdir を使わない理由" を論じているので「production は chdir を使っているが、テスト helper ではそれを採用しない」旨の対比を §2.2 に 1 行追記するとより親切。

### `main.ts:398` 最初の log() 呼び出し
```
398:  await log("pidfile_acquired", `path=${pidFilePath} pid=${process.pid}`);
```
→ line 125 の env 設定より十分後。Step B の strict モード導入で production daemon が壊れる懸念なし（plan §2.4 の想定通り）。

### `task.ts:514` の `log("task_aborted", ...)`
```
450: *   load → 冪等ガード → journal 組立 → status 代入 → cascade → save → task_aborted emit → child_reverted emit
514:  await log("task_aborted", parts.join(" "));
```
→ plan §1.3 の汚染再現経路（task.test.ts → markTaskAborted → log）の根拠として正しい。

### Test files 総数
```bash
$ ls skills/cmux-team/manager/*.test.ts | wc -l
33
```
→ plan の 33 本と一致。

### Category A の env 設定 10 ファイル
```bash
$ grep -c "process.env.PROJECT_ROOT" skills/cmux-team/manager/*.test.ts | grep -v ":0"
skills/cmux-team/manager/conductor.test.ts:2
skills/cmux-team/manager/daemon.test.ts:2
skills/cmux-team/manager/envrc-prompt.test.ts:4
skills/cmux-team/manager/eventBus.trace.test.ts:4
skills/cmux-team/manager/logger.test.ts:7
skills/cmux-team/manager/main-branch.test.ts:4
skills/cmux-team/manager/master.test.ts:2
skills/cmux-team/manager/proxy.test.ts:4
skills/cmux-team/manager/queue.test.ts:2
skills/cmux-team/manager/rate-limit-persistence.test.ts:4
```
→ 10 ファイル。plan Category A（10 本）と完全一致。

### Category B1 の 4 ファイル（mkdtemp あり / env mutation なし / `.team/` リテラルあり）
```
task.test.ts: mkdtemp + "/proj/.team/tasks/..." リテラル多数
trace-store.test.ts: mkdtemp 複数、SQLite DB 用
pidfile.test.ts: mkdtemp + ".team/daemon.pid" 参照
preflight.test.ts: mkdtemp + ".team/" 存在確認
```
→ いずれも `process.env.PROJECT_ROOT` を設定していないことを `grep -l` で確認済み（出力なし）。plan Category B1 = 4 本と一致。

### Category B3: main.test.ts
```
496:        env: { ...process.env, PROJECT_ROOT: testDir },
635:      env: { ...process.env, PROJECT_ROOT: testDir },
936:        env: { ...process.env, PROJECT_ROOT: testDir },
1493:        env: { ...process.env, PROJECT_ROOT: testDir },
```
→ 親プロセスの `process.env.PROJECT_ROOT` を書き換えずに子プロセス env 経由で渡している。plan の B3 分類と一致。

### `package.json` に test script が存在しないこと
```json
{
  "name": "manager",
  "module": "index.ts",
  ...
  // scripts セクションなし
}
```
→ Step B-3 の記述「test script を更新」は「新規追加」に修正推奨（Recommendation 3）。

### Module-top での log() 直呼びの有無
```bash
# module-top (非 function body 内) の log() は grep で 0 件
```
→ Step B の strict モード導入で production の早期 log が壊れる経路なし。plan §2.4 の想定通り。
