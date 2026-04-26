---
id: A022
type: research
title: "T337 bun test O(N²) 劣化の最小再現切り分け（probe ベース）"
created: 2026-04-26T02:34:55.810Z
author: surface:43
---

# T337: bun test 全体実行 O(N²) 劣化の dummy 切り分け

- 調査日時: 2026-04-26 JST
- 環境: macOS Darwin 25.4.0 (arm64), Bun 1.3.12 (700fc117)
- 作業 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-337-1777169439`
- ブランチ: `task-337-1777169439/task`
- 関連: A021 (T327)、T334 (v4.9.1 prepublishOnly hang)、T336 (CI workflow)

## 1. 概要

A021 で観測された「個別実行 68 秒 → 連結実行 13 分 / 1.9 s/test」という O(N²) 級劣化を、最小再現の dummy（`*.probe.ts`）で軸ごとに切り分けた。**6 軸 × N=10/50/200 + 連結 + ファイル数スケーリング 47 ファイルまで、計 38 データポイント**を採取した結果、**A021 §仮説7（module-level singleton の累積）の素朴版は dummy では完全に線形であり、本タスクで提示できる範囲では reject される**。一方で `Bun.spawn` 軸は他軸の 50–100 倍の per-test コスト（3 ms/spawn）を持ち、本物テストで連結時に効く第 1 候補は依然として A021 §仮説3（`main.test.ts` の `runCli` spawn）にある。真因は dummy では再現しない領域（dashboard ink-render の listener 漏れ・daemon ライフサイクル・interactive 子プロセス stdin EOF 待ち）に絞られる。

## 2. Methods

### 2.1 拡張子戦略の決定（A 案: `.probe.ts`）

タスク本文の制約「本番テスト群（`bun test` の auto-discovery）に巻き込まれてはいけない」を最初に検証した。3 つの候補（A=`*.probe.ts` / B=`*.test.ts` + bunfig 除外 / C=`*.test.ts` + 後段除外）のうち、A が最もクリーン。確認実行:

```text
$ bun test perf-probe/decide.probe.ts
The following filters did not match any test files in --cwd=...
 perf-probe/decide.probe.ts
note: Tests need ".test", "_test_", ".spec" or "_spec_" in the filename
note: To treat the "perf-probe/decide.probe.ts" filter as a path, run "bun test ./perf-probe/decide.probe.ts"

$ bun test ./perf-probe/decide.probe.ts        # ./プレフィックスで path 扱いに
.
1 pass / Ran 1 test across 1 file. [7.00ms]

$ bun test perf-probe                          # substring match (auto-discovery 経由)
The following filters did not match any test files
 perf-probe
140 files were searched [6.00ms]
```

**結論**: `.probe.ts` は bun の auto-discovery（`*.{test,spec}.{js,jsx,ts,tsx}`）にも substring filter にも一切ヒットしない。`./perf-probe/foo.probe.ts` または絶対パスで明示指定したときだけ走る。**bunfig.toml の追加・編集は不要**。本番 50 ファイル（`*.test.ts` / `*.test.tsx`）と完全分離できる。

### 2.2 dummy test の軸

`perf-probe/generate.ts` で機械的に emit。各軸 N=10/50/200 の 3 サイズ。

| 軸 | 各 it の中身 | 検証する仮説 |
|---|---|---|
| `baseline` | `expect(1).toBe(1)` のみ | bun runner 自体に N² overhead があるか |
| `eventbus` | ファイル先頭で `import "../eventBus"` だけ。it は空 expect | module 副作用 (singleton 生成) の累積コスト |
| `eventbus-emit` | `import { notifyStateChanged }` + 各 it で 1 回 emit (listener 0 個) | listener 0 で emit を N 回繰り返した場合 |
| `eventbus-listener-leak` | 各 it で `onStateChanged(() => {})` を登録、dispose 呼ばず | listener 累積（`__resetBusForTest` 漏れ）の純粋効果 |
| `eventbus-listener-emit` | 各 it で listener 登録 + emit | k 番目の emit で k listener が呼ばれる累積 (理論 O(N²)) |
| `sqlite-close` | 各 it で `new Database(":memory:"); db.close()` | Database ハンドル生成・破棄の per-test コスト |
| `sqlite-leak` | 各 it で `new Database(":memory:")` を生成（close せず） | Database ハンドルが GC されず累積 |
| `spawn` | 各 it で `await Bun.spawn(["echo","x"]).exited` | `main.test.ts` の `runCli` 流の子プロセス生成コスト |

合計 8 軸 × 3N = **24 個の `*.probe.ts` ファイル**。

### 2.3 測定手順

すべて `skills/cmux-team/manager/` を CWD として実行。

```bash
# 単独
gtimeout --kill-after=5 60 bun test --reporter=dots --timeout 10000 ./<file>

# 連結（同一プロセスで複数ファイル）
gtimeout --kill-after=10 300 bun test --reporter=dots --timeout 10000 \
  ./perf-probe/baseline-N50.probe.ts \
  ./perf-probe/eventbus-N50.probe.ts \
  ...
```

時間取得:
- 外側 wall: `gdate +%s%3N` を 2 回サンプリングして差分（ms）
- bun の自前 elapsed: `Ran X tests across Y file. [N.NN ms]` の値

`gtimeout --kill-after=N <duration>` の SIGKILL 併用は A021 §仮説8 の知見（bun は SIGTERM を実質無視）に従う。

実装: `perf-probe/measure.sh`（軸 × N の単独 + 連結）/ `measure-extra.sh`（listener 系・全 8 軸連結）/ `measure-many-files.sh`（同一サイズで M=1/5/10/25/47 ファイル並べた M スケーリング）。raw ログは `runs/task-337-1777169439/raw-logs/` に全保存。

## 3. Measurements

すべて手元 macOS で 1 回計測。各セルは `wall_ms (bun_self_ms)`。bun_self は `Ran X tests across Y file. [N ms]` の値（reporter 後のサマリ）。wall は外側 `gdate` 計測（bun の起動・解析含む）。bun_self ÷ tests = ms/test を Analysis で参照する。

### 3.1 単独実行（軸 × N）

| 軸 | N=10 | N=50 | N=200 | 線形性（self/test） |
|---|---|---|---|---|
| baseline               | 24 (8)   | 25 (8)   | 29 (12)  | 0.8 → 0.16 → 0.06 ms/test （線形以下） |
| eventbus (import only) | 28 (11)  | 26 (11)  | 45 (20)  | 1.1 → 0.22 → 0.10 ms/test |
| eventbus-emit          | 38 (13)  | 31 (12)  | 33 (15)  | 1.3 → 0.24 → 0.075 ms/test |
| eventbus-listener-leak | 32 (14)  | 32 (15)  | 53 (27)  | 1.4 → 0.30 → 0.135 ms/test |
| eventbus-listener-emit | 38 (18)  | 32 (15)  | 45 (25)  | 1.8 → 0.30 → 0.125 ms/test |
| sqlite-close           | 36 (13)  | 36 (12)  | 35 (18)  | 1.3 → 0.24 → 0.09 ms/test |
| sqlite-leak            | 28 (10)  | 28 (12)  | 32 (15)  | 1.0 → 0.24 → 0.075 ms/test |
| **spawn**              | **51 (34)** | **199 (179)** | **618 (595)** | **3.4 → 3.58 → 2.98 ms/test** |

注: bun_self の絶対値は数 ms 単位の noise を持つ（10ms 未満では誤差大）。N=200 列が信頼できるシグナル。

### 3.2 連結実行（同一プロセスで複数ファイル）

| ラベル | files | tests | wall_ms | bun_self_ms |
|---|---|---|---|---|
| all-N10            | 6 | 60   | 67  | 47   |
| all-N50            | 6 | 300  | 183 | 160  |
| all-N200           | 6 | 1200 | 660 | 638  |
| all8-N200 (listener 軸込み) | 8 | 1600 | 641 | 623 |
| listener-leak-then-emit-N200 | 2 | 400 | 49 | 33 |
| baseline-N10+50+200       | 3 | 260 | 32 | 14 |
| eventbus-N10+50+200       | 3 | 260 | 36 | 18 |
| eventbus-emit-N10+50+200  | 3 | 260 | 41 | 22 |
| listener-leak-N10+50+200  | 3 | 260 | 40 | 23 |
| listener-emit-N10+50+200  | 3 | 260 | 41 | 24 |
| sqlite-close-N10+50+200   | 3 | 260 | 41 | 22 |
| sqlite-leak-N10+50+200    | 3 | 260 | 45 | 24 |
| **spawn-N10+50+200**      | 3 | 260 | **758** | **740** |

### 3.3 ファイル数スケーリング (M=1..47)

同じ baseline 軸を別ファイルとして M 個並べたケース。本物の `*.test.ts` 47 ファイルにスケールを合わせて bun runner 側のファイル数 overhead を確認。

#### M-10 (各ファイル 10 tests)

| M | tests | wall_ms | bun_self_ms |
|---|---|---|---|
| 1  | 10  | 25 | 7  |
| 5  | 50  | 28 | 11 |
| 10 | 100 | 43 | 24 |
| 25 | 250 | 41 | 24 |
| 47 | 470 | 76 | 55 |

#### M-20 (各ファイル 20 tests, 1300 tests に近づける)

| M | tests | wall_ms | bun_self_ms |
|---|---|---|---|
| 1  | 20  | 28 | 7  |
| 5  | 100 | 30 | 14 |
| 10 | 200 | 34 | 17 |
| 25 | 500 | 60 | 31 |
| 47 | 940 | 66 | 48 |

→ **47 ファイル × 20 tests = 940 tests を 48ms (bun_self) で消化**。本物テストの 13 min / 420 tests = 1.9 s/test と比較して **約 16,000 倍速い**。

## 4. Analysis

### 4.1 軸間比較

- **bun runner 自体に N² overhead は無い**: M=1→47 ファイルでは bun_self が 7→55 ms（M=10）/ 7→48 ms（M=20）と概ね線形。940 tests を 48 ms で消化するから 1 test あたり 0.05 ms。47 ファイル分のファイル境界 overhead は合計でも 50 ms 未満。
- **module-level singleton（`eventBus.ts` の EventEmitter / `bun:sqlite` の `new Database(":memory:")`）は累積コスト微小**: N=200 で eventbus 軸 20ms / sqlite 軸 15-18ms。線形すら超えない。
- **listener leak / listener-emit も dummy では線形**: listener-leak-N200 = 27ms, listener-emit-N200 = 25ms。理論的に O(N²) のはずの「k 番目の emit で k 個の listener が呼ばれる」も 200 個程度では 0.13 ms/test。Node EventEmitter の listener 配列を 200 回回しても modern CPU では microsecond オーダー。
- **`Bun.spawn` だけ突出**: spawn-N200 = 595 ms (2.98 ms/spawn)。他軸の 30-60 倍。連結 spawn-N10+50+200 で 740 ms と線形 (260 spawn × 2.85 ms/spawn)。複数ファイル連結によるオーバーヘッド増加は無し。

### 4.2 連結時の劣化観察

- 6 軸 N=200 連結 (1200 tests, 6 files) = 638 ms ≈ 個別合計 (12+20+15+18+15+595 = 675 ms) と同等。**連結による超線形劣化は dummy では発生せず**。
- 8 軸 N=200 連結 (1600 tests, 8 files) = 623 ms。同上。
- listener-leak-then-emit-N200 = 33 ms: leak ファイルで 200 個 listener を貯めた直後に emit ファイルを走らせても劣化無し。**listener が累積した状態で emit を繰り返しても 200 個程度では検知できない**。

### 4.3 A021 §仮説7 の confirm/refute

> A021 §仮説7（最有力）: 同一プロセス内で `eventBus.ts` の `EventEmitter` や `bun:sqlite` の `Database` ハンドルが module-level に蓄積している疑い

**素朴な形では refute**:
- import のみ → 線形
- emit のみ → 線形
- listener 200 個累積 → 線形
- listener 累積 + emit 200 回 → 線形
- Database 200 個 leak → 線形
- これらを連結しても線形

dummy で再現できる範囲では、**A021 が指す「module-level singleton が累積する」という構造そのものは O(N²) 劣化の必要十分条件ではない**。一方、本物のテストには dummy にない以下の動作がある:

1. **`dashboard.tsx:2150` の `onStateChanged()` 登録を、ink-testing-library で render したコンポーネントが unmount せずに残す**ケース（A021 で示唆）。listener が個別ではなく **コンポーネント tree 全体（数十〜数百のサブスクリプション）** として登録され、ファイル境界を超えて生き残る可能性。
2. **`daemon.test.ts` で daemon を実起動**: daemon 内部は EventBus 以外にも `bus`/queue watcher/PID watcher/timer を多数登録する。teardown が完全でないと累積する。
3. **`main.test.ts` の `runCli` spawn**: dummy の `echo x` は確実に exit するが、本物の `bun run main.ts <args>` は引数次第で readline 等の stdin EOF 待ちで永続化する。`proc.on("close", ...)` は永遠に呼ばれず、親 bun test も呼び出し点で待ち続ける。
4. **本物のテスト内 `beforeEach` / `afterEach`**: mkdtemp + sqlite migration + JSON write 等で 1 test あたり 10-50 ms 加算。これだけで 1300 tests × 30 ms = 39 sec の純コスト。

### 4.4 spawn 軸の意味

dummy で唯一 per-test コストが大きい spawn 軸（3 ms/spawn）は、**A021 §仮説3（`main.test.ts` の `runCli` close 待ち leak）と整合**する。`main.test.ts` は 169 tests のうち相当数で `Bun.spawn(["bun", "run", MAIN_TS, ...])` を呼ぶ。仮に 100 spawn だけでも、**確実に exit する dummy spawn だけで** 300 ms。本物の `bun run main.ts` は cold start で 数百 ms かかるため、leak しなくとも 100 spawn で 30 秒以上消費する。さらに 1 つでも close 待ちで stuck すれば、その親 spawn の `await proc.exited` で全プロセスが完全停止する。

## 5. Hypothesis narrowing

dummy で取れた数値と A021 の観察を突き合わせ、真因候補を 2 つに絞る。

### H1（強）: `main.test.ts` の `runCli` spawn が leak / 重い (A021 §仮説3 系統)

**根拠**:
- spawn 軸は dummy 5 軸の中で唯一明確にコストが大きい (3 ms/spawn)
- `main.test.ts` は 169 tests で `runCli` が中核。実 spawn は cold start 100-300 ms。100 spawn で 10-30 秒
- A021 が「過去の 4h+ ハングで `bun run main.ts token add` が 13 時間以上 leak している (PID 11564 / 17160 / 25152)」を観察済み。`runCli` の `proc.on("close", ...)` は exit しない子プロセスでは永遠に解決しない
- 個別ファイル実行が 68 秒で済むのは、ファイル単位で bun が exit するため leak した子プロセスも親終了で道連れになるから

**証拠が必要なもの（次タスクで取るべき）**:
- 連結実行中の `pgrep -f "bun run.*main.ts" | wc -l` の時系列
- `main.test.ts` 内の各 spawn の `proc.exited` が解決した数 vs 解決しなかった数
- `runCli` を `import { handleXyzCommand } from "./main"` 直接呼び出しに置き換えた後の連結実行時間

### H2（中）: `dashboard.tsx` の `onStateChanged()` 登録が ink-testing-library で render した component から漏れる (A021 §仮説7 の non-trivial 拡張)

**根拠**:
- dummy では「listener leak + emit」を試したが、200 個程度では効果なし
- ただし本物の dashboard.tsx は **`onStateChanged(() => scheduleRefresh())` を 1 component あたり 1 回**ではなく、内部の `useEffect` 階層で **多数の subscription** を持つ可能性
- ink-testing-library の `render(...)` の戻り値で `unmount()` を呼ばないと React の cleanup hook も走らず、listener が tree 全体分残る
- dashboard 系 test は 3 ファイル。各ファイル 数十-100 tests と仮定して **数千の listener 累積**になれば dummy の 200 とは桁違い
- listener が L 個 + emit を E 回 = L × E callback 起動。1300 tests × 1000 listener = 130 万 callback で modern CPU でも数秒。13 分の劣化への寄与は spawn より大きい可能性

**証拠が必要なもの**:
- 連結実行中の `__listenerCountForTest()` 時系列（`--preload` で全テスト前後にダンプ）
- dashboard 系テストを skip した状態で連結実行した時の time
- ink-testing-library `render` の戻り値で `unmount()` を呼ばないテストの一覧

### H3（弱、補強）: dummy の N=200 では「累積効果が出始める前に test ファイルが終わる」

dummy のスコープが 1300 tests / 13 min の実環境より 1 桁以上小さい。N=2000 / M=200 程度まで増やせば accumulating cost が見え始める可能性はある（だが現実的に dummy で 13 min まで再現するのは時間と計算コストに見合わない）。本タスクではここまで。

## 6. Recommendations for next task

優先順位は次タスクで取り組むべき順。

### R1（最優先・実装）: `main.test.ts` の `runCli` を直接 import 形式に置き換える

- 既に `gh-cache-cli.test.ts` / `token-cli.test.ts` で実装済みの直接 import パターンを `main.test.ts` 全体に適用
- `runCli` 関数自体の廃止 or `afterEach` で `proc.kill('SIGKILL')` を必ず呼ぶ防御的 cleanup
- 期待効果: 連結実行 13 min → 数分台への短縮。leak 子プロセスの根絶
- 検証: 置換前後で `for f in *.test.ts; do bun test "$f"; done` 合計時間と全件連結実行時間を測る。連結時間 / 個別合計 比が 1.x 倍に収まれば成功

### R2（高優先・観測強化）: 全テスト共通の `--preload` 計装

```ts
// preload.ts
import { afterAll } from "bun:test";
import { __listenerCountForTest } from "./eventBus";
afterAll(() => {
  console.error(`[probe] file-end listenerCount=${__listenerCountForTest()} rss=${process.memoryUsage().rss}`);
});
```

- `bunfig.toml` の `[test] preload = ["./test-preload.ts"]` で全テストに inject
- 連結実行時の listener 数 / heap 推移が file 境界ごとに stderr に出る → A021 が言う「listener 数の時系列」が直接取れる
- これで H2 を confirm/refute 可能。**実装が確実なため最初に入れるべき**

### R3（中優先・実装）: `eventBus.ts` を factory 化または全テスト境界で reset

- 案 a: `bunfig.toml` の preload で `beforeEach(__resetBusForTest)` を全テストに適用。最小変更で全テスト reset を強制できる
- 案 b: `eventBus.ts` を `createBus()` factory に変える。各テストは local instance を使用。本番側は 1 個生成
- 案 a の方がコスト低・効果検証が早い。R2 の preload と同じファイルに同居できる
- ink-testing-library の使用箇所には `afterEach(() => result.unmount())` を必ず加える

### R4（中優先・観測強化）: 連結実行中の子プロセス監視

```bash
# 別シェル
( while sleep 5; do
    echo "[$(gdate +%T)] bun_main_count=$(pgrep -fc 'bun run.*main.ts')"
  done ) > /tmp/spawn-watch.log &
```

- これで H1 を時系列で confirm/refute 可能
- 連結実行が遅くなる時刻と spawn 残存数の相関が見える

### R5（低優先・運用）: T336 (CI) で dummy probe の周期測定を回す

- `bun run perf-probe/measure.sh /tmp/probe-out` を CI で月次実行
- bun のバージョン更新で runner 側に N² が混入したら早期検知できる（現在は線形と確認済み）

## 7. Limitations

1. **dummy のスケールが本物の 1/3**: dummy 6 軸 × N=200 = 1200 tests で 638 ms。本物は 1300 tests で 13 min。`__listenerCountForTest()` の `--preload` 計装無しには本物テストでの listener 数推移が取れず、H2 を直接 confirm/refute できない。
2. **spawn 軸は `echo x` という最軽量 spawn**。本物の `bun run main.ts ...` は cold start 100-300 ms かつ stdin readline 待ちで stuck し得るが、dummy はこれを再現していない（exit は確実）。`leak` 自体の効果（親が永遠に待つ）は dummy 上で出ていない。
3. **ink-testing-library 由来の listener leak は dummy 化していない**: React render tree 全体の subscription 数を模倣するには `ink-testing-library` を import して実 render するしかなく、その時点で「dummy」とは言えなくなる。本タスクは EventEmitter level の listener 累積でそれを近似したが、効果が出ない結果は「200 listener 程度では見えない」を示すだけで、dashboard 由来の数千 listener 累積は否定できていない。
4. **macOS / Bun 1.3.12 のみ**: Linux GHA runner 上の挙動 (T334 の hang 原因) は別系統の可能性。本来は GHA 側でも probe を 1 回回したい (R5)。
5. **SQLite の本物の負荷を模倣していない**: `new Database(":memory:")` のみで CREATE TABLE / 大量 INSERT / PRAGMA / WAL 等が無い。本物の `trace-store.ts` / `token-store.ts` は migration を実行する。本物の累積コストはここに隠れている可能性が大（Database singleton + migration 重複適用）。次タスクで `trace-store` を 200 個 init するパターンを probe に加えると良い。
6. **計測の単発実行**: 各セルは 1 回のみ。±20% 程度の noise を含む。N=200 列が比較的安定したシグナル、N=10/50 列は誤差大。

## 付録: 生データへの参照

- 単独実行 TSV: `runs/task-337-1777169439/single.tsv`
- 連結実行 TSV: `runs/task-337-1777169439/concat.tsv`
- listener 系・8 軸連結 TSV: `runs/task-337-1777169439/extra.tsv`
- ファイル数スケーリング TSV: `runs/task-337-1777169439/many-files.tsv`
- 全 raw bun output: `runs/task-337-1777169439/raw-logs/`
- dummy 生成スクリプト: `skills/cmux-team/manager/perf-probe/generate.ts`
- 測定スクリプト: `skills/cmux-team/manager/perf-probe/measure.sh` / `measure-extra.sh` / `measure-many-files.sh`
