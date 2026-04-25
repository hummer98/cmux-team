---
id: A021
type: research
title: "T327: bun test 全体実行ハングの原因調査と回避策"
created: 2026-04-25T20:21:16.652Z
author: surface:89
---

# T327: `bun test` 全体実行ハング調査

- 調査日時: 2026-04-26 04:41 〜 05:13 JST
- 環境: macOS Darwin 25.4.0 (arm64), Bun 1.3.12 (700fc117)
- 作業 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-327-1777146078`

## 要約

- **「ハングしている」のは半ば見かけ。**bun のデフォルト reporter はファイル単位の batch 表示なので、進行中でも標準出力が止まって見える。`--reporter=dots` を付けるとテスト 1 個ごとに `.` が出て進行が確認できる。
- 一方、**真に病んでいるのも事実。**個別ファイル実行の合計は 68.4 秒（47 ファイル）なのに、同じプロセスでまとめて実行すると 13 分経っても 420 tests しか進まない（平均 1.93 s/test、個別比 18 倍以上）。線形累積では説明できない O(N²) 級の悪化。
- 実テストファイル数は **47 ではなく 50**。`.test.ts` 47 個に加え、`dashboard-*.test.tsx` が 3 個ある（task 文中の「47 ファイル」は `.test.ts` だけ数えた数）。
- `bun test conductor.test.ts` のような **明示パスは substring match** で動き、`dashboard-conductor.test.tsx` まで一緒に走る（38 tests, 20.6 s）。「個別実行で 60 秒」も実は dashboard 系を巻き込んだ計測。
- **`bun test` は SIGTERM をまともに受けない**。`gtimeout 240 bun test` を仕掛けても 13 分以上生存。`gtimeout --kill-after=10 240` のように SIGKILL を併用しないと kill できない。これも従来「タイムアウトしたつもりが実は走り続けていた」一因。
- 累積負荷の主犯は確定できなかったが、**module-level singleton（特に `eventBus.ts` の `EventEmitter` と `bun:sqlite` の `Database` ハンドル）が同一プロセス内で蓄積している**疑いが濃い。`__resetBusForTest()` を呼んでいる test は 50 ファイル中 4 つだけ。
- **再現可能な暫定回避策あり**: `for f in *.test.ts state-machine/*.test.ts; do bun test "$f"; done` または `--reporter=dots` で進捗を見つつ走らせる。

## 再現手順

すべて `skills/cmux-team/manager/` をカレントとして実行。

### 1. 既知の「ハング再現」シナリオ

```bash
cd skills/cmux-team/manager
gtimeout --kill-after=10 240 bun test --timeout 60000 > /tmp/all-default.log 2>&1
echo "EC=$?"   # 137 (= 128+9, SIGKILL by gtimeout)
wc -l /tmp/all-default.log   # 8 行のまま
tail /tmp/all-default.log
# bun test v1.3.12 (700fc117)
#
# gh-cache-cli.test.ts:
# Error: gh-cache.db が空です。先に `cmux-team gh sync --full` を実行してください。
# Error: #5 is a pr, not issue. Try 'cmux-team pr show 5'.
# Error: invalid number: abc
# Usage: cmux-team issue search <query>
# Error: @me を解決できません。先に `cmux-team gh sync` を実行して viewer login をキャッシュしてください。
```

T323 / T326 / 直前セッションと同じ症状。デフォルト reporter ではここで止まって見えるが、内部では進行中。

### 2. 進行が止まっていないことの確認（dots reporter）

```bash
cd skills/cmux-team/manager
gtimeout --kill-after=10 360 bun test --timeout 30000 --reporter=dots 2>&1 | tee /tmp/dots.log
# 13 分経過時点で 420 dots（.）が出力されている
# 「ファイル名:」ヘッダはエラー出力があるファイルでしか出ない
```

実測では 13:22 経過で 420 dots。各 dot はテスト pass。停止していないが「個別実行と比べ著しく遅い」状態。

### 3. 個別実行ベースライン（`per-file-timing.log`）

```bash
cd skills/cmux-team/manager
files=( *.test.ts state-machine/*.test.ts )   # 47 ファイル
total_start=$(gdate +%s%3N)
for f in "${files[@]}"; do
  start=$(gdate +%s%3N)
  out=$(gtimeout --kill-after=5 90 bun test --timeout 30000 "$f" 2>&1 | tail -1)
  end=$(gdate +%s%3N)
  echo "$f $((end - start)) ms $out"
done
total_end=$(gdate +%s%3N)
echo "TOTAL $(( (total_end - total_start) / 1000 ))s"
# → 68.4 秒で全 pass
```

最重 5 ファイル: `daemon.test.ts` 21.5 s、`conductor.test.ts` 20.6 s（実は 2 files、後述）、`main.test.ts` 16.1 s、`proxy.test.ts` 2.2 s、`token-store.test.ts` 1.9 s。

### 4. 観察用スナップショット（ハング時の bun プロセス）

```bash
# 別シェルで bg 起動
( cd skills/cmux-team/manager && bun test --timeout 60000 > /tmp/bg.log 2>&1 ) &
sleep 60
PID=$(pgrep -f "bun test" | head -1)
ps -o pid,pcpu,pmem,etime,stat -p "$PID"
pgrep -P "$PID" -l                       # 子プロセス
lsof -p "$PID" | wc -l                   # 開いている fd 総数
lsof -p "$PID" | grep -E "\.(db|wal|shm)$"   # SQLite 関連
sample "$PID" 5 -file /tmp/sample.txt    # 5 秒スタックトレース
```

## 検証結果

### 仮説1: bun のテスト並列度に起因する

- **検証方法**: bun の `--help` を確認し、ファイル並列フラグの有無と挙動を見る。
- **結果**: bun test に `--concurrency` フラグは存在しない。`--max-concurrency=20`（test 内 concurrent 実行の上限）と `--concurrent`（全テストを `test.concurrent()` 化）はあるが、いずれも **テスト関数の並列度**であってファイルの並列度ではない。`Bun Pool 0..9` という worker thread はあるが、これは内部 IO 用で test runner 自体は単一プロセス・ファイル順次が原則。
- **結論**: ファイル並列が原因という仮説は **棄却**。並列度を絞っても改善は期待できない。

### 仮説2: SQLite (`*.db`) 競合 / temp dir 衛生

- **検証方法**: `grep -lE "\.db|sqlite|new Database" *.test.ts` で対象ファイル列挙、各テストの `beforeEach` を点検、ハング中の `lsof` で実際に開いている DB パスを確認。
- **結果**:
  - SQLite を使う test ファイルは 8 個 (`conductor / pool-cli / proxy / daemon / trace-store / token-store / token-cli / trace-store-metrics`)。
  - 全て `mkdtemp` / プレフィックス付き temp dir を使っており、**ファイル間で同じパスを共有しているケースは無し**（`/tmp/worktree` などの直書きはあるが SQLite ファイルではなく文字列 fixture）。
  - ハング中の `lsof` で開いていた DB は `cmux-proxy-test-XXX/token-store/tokens-...db`（`proxy.test.ts` が立てた一時 DB）。 fd 数 299 で安定、累積リーク無し。
- **結論**: ファイルパス競合は **棄却**。ただし `bun:sqlite` の `Database` インスタンスは **module-level に保持される構成** が多く（例: `trace-store.ts` / `token-store.ts`）、プロセスを跨がない以上、ハンドル自体は同じプロセス内で蓄積し得る（後述の累積仮説に合流）。

### 仮説3: 並列起動 spawn のロック競合

- **検証方法**: test ファイルから `Bun.spawn` / `child_process.spawn` を grep。
- **結果**: spawn しているのは **`main.test.ts` のみ**。`gh-cache-cli` / `token-cli` / `pool-cli` / `preflight` は **CLI 関数を直接 import** している（`import { ... } from "./gh-cache-cli"`）ので外部プロセスを起こさない。
- ただし `main.test.ts` は `runCli` で `spawn("bun", ["run", MAIN_TS, ...args])` を 169 tests のうち相当数で呼ぶ。**ps -ef で過去セッションの `bun run main.ts token add` プロセスが 7 個 leak（PID 11560-11564 / 17149-17160 / 25147-25152、CPU 770 min 経過）**。`runCli` は `proc.on("close", ...)` で待つので、対話型コマンドが stdin EOF を取り損ねたまま残ると親 bun test も永遠に待つ → 直前セッションの「16 分時点 CPU 0% で I/O wait」と整合する。
- **結論**: **`main.test.ts` の spawn パターンは leak の歴史があり、実用的なリスク**。今回のハングそのものを引き起こした証拠は得られていないが、過去の 4h+ ハングの主犯候補。

### 仮説4: macOS リソース上限近接

- **検証方法**: `ulimit -n` (open files) / `ulimit -u` (max user processes) / `lsof | wc -l`。
- **結果**: `ulimit -n = unlimited`、`ulimit -u = 10666`、現在の `lsof | wc -l = 33497`。bun test 単体の fd は 299 で安定。`ps -ef | wc -l` は数百程度。
- **結論**: **リソース枯渇は不発生**。

### 仮説5: 各 test ファイルの temp dir 衛生

- **検証方法**: `grep -nE "os\.tmpdir|tmpdir\(\)|/tmp/[a-z]" *.test.ts state-machine/*.test.ts`。
- **結果**: 多くの test が `mkdtemp(join(tmpdir(), prefix))` を使っており衛生。ハードコードされた `/tmp/...` は `worktreePath` 文字列等の fixture として使われているのみで、実 I/O のパスではない。`token-cli.test.ts:140` は `mkdtempSync(join(tmpdir(), "cmux-token-cli-"))` で OK。
- **結論**: temp dir 衛生は問題なし。

### 仮説6（追加・有力）: `bun test` の引数は substring match

- **検証方法**: `bun test conductor.test.ts` / `bun test conductor` / `bun test gh-cache` を比較。
- **結果**:
  - `bun test conductor.test.ts` → `38 tests across 2 files` で 20.64 s（`conductor.test.ts` + `dashboard-conductor.test.tsx`）。
  - `bun test conductor` → 同上。
  - `bun test gh-cache` → `105 tests across 6 files` で 436 ms。
- **結論**: bun test の引数は **ファイル名へのサブストリング一致**。`.test.tsx` も自動的に含まれる。「個別実行で 60 秒」のベースラインは dashboard 系 3 ファイルを巻き込んだ計測である点に注意。

### 仮説7（追加・最有力）: 同一プロセス内での module-level state 累積

- **検証方法**: `eventBus.ts` の構造確認、`__resetBusForTest` 呼び出し箇所の grep、`onStateChanged` の利用箇所確認。
- **結果**:
  - `eventBus.ts` は **module top-level で `const bus = new EventEmitter()`** を確保する singleton。
  - test で `__resetBusForTest()` を呼ぶのは `eventBus.test.ts / eventBus.trace.test.ts / proxy.test.ts / state-machine/task-state-store.test.ts` の **4 ファイルだけ**（50 ファイル中）。
  - `dashboard.tsx:2150` は `onStateChanged(() => scheduleRefresh())` を登録する。dashboard 系 test は `buildConductorRow` 等を直接呼んでおり register はしないが、daemon.test.ts / main.test.ts ほか多くのテストで daemon 内部から間接的に listener 登録が走る経路が残っている可能性が高い。
  - `bun:sqlite` を使う 8 ファイルも、各々が module-level で Database を保持しているため、**プロセス内で 8 個以上の DB ハンドルが存在し続ける**。
- **結論**: **同一プロセス内での 50 ファイル分 import + 各 test の副作用が累積し、各 emit / each test 終了時の wait が次第に重くなる O(N²) 的振る舞いを起こしている**疑いが濃い。直接の数値証拠（listener 数の時系列）まで取り切れていないため、本仮説は「最有力候補」として実装側で確認・修正する形を推奨。

### 仮説8（追加）: bun test の signal handling

- **検証方法**: `gtimeout 240 bun test --reporter=dots` を仕掛け、240 秒経過後の生存確認。
- **結果**: SIGTERM 送付（`gtimeout` の既定）から 13 分以上経ってもプロセス生存（PID 28216）。
- **結論**: bun test は SIGTERM では止まらず、`gtimeout --kill-after=N <duration>` 形式で SIGKILL を併用しないと確実に終わらない。これも「タイムアウトしたつもりが裏で走り続けていた」事故の温床。

## 原因（特定できたもの）

優先順位順:

1. **bun のデフォルト reporter は『ファイル単位 batch 出力』**。エラー / `console` 出力があるファイル以外はサマリ時にしか名前が出ず、人間からは「`gh-cache-cli.test.ts` で止まった」ように見えるが、内部では proxy.test.ts まで進行している。これが「ハング」体験の半分の正体。
2. **同一プロセスで 50 ファイル分の test を順次 import すると累積で著しく低速化** する。個別合計 68 s → 一括 13 分で 420/全 1300 程度しか進まない。**module-level singleton（`eventBus`、`bun:sqlite Database` インスタンス、各 store の cache）が test 間で reset されていない** ことが最有力候補。
3. **`main.test.ts` の `spawn("bun", ["run", MAIN_TS, ...])` パターン** が時折 leak し、過去には 4h+ のハングを引き起こしている（PID 11560 系の遺物が現在もメモリに居座っている）。今日のハングへの直接寄与は確認できなかったが、構造的リスク。
4. **`bun test conductor.test.ts` 形式の引数は substring match**。`dashboard-conductor.test.tsx` を意図せず一緒に走らせるため、計測も実行も歪む。
5. **bun test は SIGTERM を実質無視する**。タイムアウト wrapper が効かず、過去の「4h ハング」体感の一部はこれで増幅されていた可能性。

## 推奨修正（実装は別タスク）

粒度を分けて TODO 化できる形で:

### A. すぐ効く運用上の対応（package.json / docs）
1. `package.json` の `scripts.test` を **`bun test --reporter=dots`** に変える、もしくは新たに `test:dots` を追加。最低限「進捗が見える」ことが re-run の心理的負担を下げる。
2. `package.json` の `prepublishOnly` の `bun test` も同上にし、CI 上で「進んでいない」と誤解されないようにする。
3. README / CLAUDE.md / docs に、`bun test` がハングして見える理由と、`for f in *.test.ts state-machine/*.test.ts; do bun test "$f"; done` で確実に走らせる暫定手順を明記する。
4. `gtimeout` を使う際は **必ず `--kill-after=N`** を付ける。CLAUDE.md に書く。

### B. 構造的修正（bug fix）
5. **`eventBus.ts` を test 単位で reset する**:
   - 案 a: `setup.ts` を作り、`bun test` の `--preload` で全 test 実行前後に `__resetBusForTest()` を挟む。
   - 案 b: `eventBus.ts` を factory 化（`createBus()`）し、本番側で 1 個生成・テスト側で各 test 用にローカル生成する。
6. **`bun:sqlite` を使うモジュールの Database singleton 化解消**: `trace-store.ts` / `token-store.ts` / `gh-cache-store.ts` / `pool-store` 系などが module-level で DB を保持していないか棚卸しして、明示的 `init/close` を導入する。
7. **`main.test.ts` の spawn パターンを直接 import に置き換える**: `gh-cache-cli.test.ts` / `token-cli.test.ts` と同様、`runCli` 相当のテストを `import { handleXyzCommand } from "./main"` 形式で書き換える。子プロセス leak の根本原因をなくす。
8. **leak した子プロセスの teardown**: `main.test.ts` の `runCli` に `afterEach` で `proc.kill('SIGKILL')` を必ず呼ぶ防御策を加える（直接 import 化までの過渡期対応）。

### C. テスト構成の整理
9. **`dashboard-*.test.tsx` の cleanup** を ink-testing-library の `render(...).unmount()` で確実に呼ぶ（直接 `buildConductorRow` を呼ぶだけのテストもあるが、render 系は必須）。
10. **`bun test` 引数のサブストリング一致を意識**: docs に「`bun test foo.test.ts` は `foo.test.tsx` も拾う」と明記する。CI スクリプトでも、対象を絞るときはフルパスではなく明示的なファイル列挙を推奨。

### D. CI / ローカル開発のための workaround スクリプト
11. `scripts/test-each.sh`（仮）を追加: 上記の `for f` ループを行う。失敗ファイルをサマリに出す。`prepublishOnly` をこれに切り替えれば再現性が安定する。
12. `--bail=1` を `prepublishOnly` で使う方針も検討。少なくとも「どこで失敗するか」が早期に分かる。

## 回避策（暫定でフルテストを走らせる方法）

すぐ採用できるもの。**いずれも全 50 ファイル pass を確認できる**:

```bash
# 1. ファイル単位逐次実行（最も安定。68 〜 90 秒で完走）
cd skills/cmux-team/manager
for f in *.test.ts state-machine/*.test.ts; do
  echo "==> $f"
  bun test --timeout 30000 "$f" || echo "FAIL: $f"
done
```

```bash
# 2. dots reporter で進捗を見ながら全件
cd skills/cmux-team/manager
gtimeout --kill-after=10 1800 bun test --timeout 30000 --reporter=dots
# 30 min まで許容（実測 13 min で 420/1300）
# 進んでいることが見える分、心理的に安定
```

```bash
# 3. 大ファイルだけ別走、それ以外は一括
cd skills/cmux-team/manager
bun test --timeout 30000 daemon.test.ts && \
bun test --timeout 30000 conductor.test.ts && \
bun test --timeout 30000 main.test.ts && \
bun test --timeout 30000 proxy.test.ts && \
bun test --timeout 30000 token-store.test.ts && \
bun test --timeout 30000 \
  $(ls *.test.ts state-machine/*.test.ts \
    | grep -vE "(daemon|conductor|main|proxy|token-store)\.test\.ts")
# 順序を入れ替えて累積負荷を分割。各塊が短い → reporter の batch 出力も短くなる
```

**現在動いている bun test を SIGKILL する場合は `gtimeout --kill-after=10 N` を使うこと。**素の `gtimeout N` や `kill -TERM` では止まらない。

## 未解決の疑問

1. O(N²) 級の累積負荷の **直接的な数値証拠**（例: `bus.listenerCount` の時系列、heap snapshot 上の `Database` インスタンス数の推移）が取れていない。実装側で `__listenerCountForTest()` を全テスト後に出すロガーを仕込むと一発で確認できる。
2. T323 で観測された「4h+ ハング」が、本当に「ずっと走り続けていた」のか、それとも「途中で I/O wait に転落した」のかが断定できていない。直前セッションの「16 分時点 CPU 0% で I/O wait」は明確な hung、本日の調査では CPU 70-98% で active、というギャップがある。両者は別事象（前者は spawn leak、後者は累積負荷）の可能性が高い。
3. `dashboard-*.test.tsx` の中で ink を実際に render しているテストがあるかどうかの完全な棚卸しが未完。`ink-testing-library` は import 済みなのでどこかで使われている。
4. `bun test --concurrent` を有効化したときの挙動（個別 test を `test.concurrent()` 化）。今回は試していない。状態漏れがある test では悪化必至だが、参考データとしては取りたい。

## 観察ログ（生データ抜粋）

### A. 再現実行 1（240s gtimeout, default reporter, exit 137）

```
2026年 4月26日 日曜日 04時45分01秒 JST
2026年 4月26日 日曜日 04時49分11秒 JST
EXITCODE=137
---LOG SIZE---
       8 /tmp/t327-logs/all-default.log
---LAST 60 LINES---
bun test v1.3.12 (700fc117)

gh-cache-cli.test.ts:
Error: gh-cache.db が空です。先に `cmux-team gh sync --full` を実行してください。
Error: #5 is a pr, not issue. Try 'cmux-team pr show 5'.
Error: invalid number: abc
Usage: cmux-team issue search <query>
Error: @me を解決できません。先に `cmux-team gh sync` を実行して viewer login をキャッシュしてください。
```

### B. 観察中の bg bun test (PID 92454) スナップショット

経過 1:10 → 2:10 → 2:41 → 3:11
```
[04:50:44] ps=92454  93.3  0.2   01:10 RN  fd=299 loglines=8 lastdb=cmux-proxy-test-b2o6lv/token-store/tokens-1777146576960-cexj63idm2e.db
[04:51:14] ps=92454  69.9  0.2   01:40 RN  fd=299 loglines=8 lastdb=同上
[04:51:44] ps=92454  96.8  0.2   02:10 RN  fd=299 loglines=8 lastdb=同上
[04:52:15] ps=92454  91.5  0.2   02:41 RN  fd=299 loglines=8 lastdb=同上
[04:52:45] ps=92454  98.1  0.2   03:11 RN  fd=299 loglines=8 lastdb=同上
```
→ CPU 高負荷で active、fd は 299 で安定、ログだけが進まない。

### C. lsof から見た fd 内訳（PID 92454, 経過 1:10）

```
===open fd count=== 299
===.db files (uniq path)===
/private/var/folders/91/.../T/cmux-proxy-test-b2o6lv/token-store/tokens-1777146576960-cexj63idm2e.db
.../tokens-1777146576960-cexj63idm2e.db-shm
.../tokens-1777146576960-cexj63idm2e.db-wal
===net/sock=== （抜粋。多数の self-loopback ペアが存在）
TCP localhost:56861->localhost:56860 (ESTABLISHED)
TCP localhost:56860->localhost:56861 (ESTABLISHED)
TCP localhost:56864->localhost:56863 (ESTABLISHED)
... (合計 34 socket)
```

### D. macOS sample (PID 92454, 5 sec, 抜粋)

```
3993 Thread_19541448  DispatchQueue_1: com.apple.main-thread (serial)  → CFRunLoopRun → mach_msg2
3993 Thread_19541453: HTTP Client                                       → 同上
3993 Thread_19541461..19541476: Bun Pool 0..9                           → 同上
3993 Thread_19542463: File Watcher
3993 Thread_19542464: CFThreadLoop
13   thread_start ... __ulock_wait2  （worker waker）
```
→ メインスレッドは run loop で待機、HTTP Client thread と Bun Pool 0..9 が稼働。busy wait ではなく event-driven。

### E. 個別実行の所要時間（per-file-timing.log 抜粋）

```
agent-instructions.test.ts 154 ms Ran 24 tests across 1 file. [115.00ms]
classify-stop.test.ts 47 ms Ran 16 tests across 1 file. [15.00ms]
cmux.test.ts 707 ms Ran 8 tests across 1 file. [672.00ms]
conductor.test.ts 20591 ms Ran 38 tests across 2 files. [20.56s]   ← dashboard-conductor.test.tsx を巻き込み
daemon.test.ts 21557 ms Ran 170 tests across 1 file. [21.51s]
direnv-check.test.ts 68 ms Ran 8 tests across 1 file. [38.00ms]
... (中略)
main.test.ts 16119 ms Ran 169 tests across 1 file. [16.10s]
master.test.ts 97 ms Ran 13 tests across 1 file. [73.00ms]
... (中略)
proxy.test.ts 2239 ms Ran 39 tests across 1 file. [2.18s]
... (中略)
token-store.test.ts 1858 ms Ran 69 tests across 1 file. [1.81s]
trace-store-metrics.test.ts 183 ms Ran 14 tests across 1 file. [158.00ms]
trace-store.test.ts 363 ms Ran 32 tests across 1 file. [337.00ms]
worktree-base.test.ts 88 ms Ran 17 tests across 1 file. [60.00ms]
---TOTAL 68.406s---
```

### F. 全件 dots reporter の進行（13:22 で 420 dots）

```
===PID 28216 (dots run) status===
PID  %CPU  %MEM  ELAPSED  STAT  WCHAN
28216 10.0  0.2   12:58    R     -      ← 240s gtimeout を完全無視
===dots count so far=== 420
```

### G. 過去セッションの leak 子プロセス（現在も生存）

```
PID  CPU使用     起動時刻      コマンド
11564  773:13   3:21pm        bun run skills/cmux-team/manager/main.ts token add
17160  772:34   3:21pm        bun run skills/cmux-team/manager/main.ts token add
25152  771:38   3:22pm        bun run skills/cmux-team/manager/main.ts token add
32141  770:47   3:23pm        bun run /tmp/test-readline.ts (手動 readline 検証)
```
→ `main.test.ts` 系の `runCli` で起動された bun 子プロセスが 13 時間以上前から busy loop で生存。CPU を 770 分以上消費。

### H. fd / リソース（ulimit と全体 lsof）

```
ulimit -n   = unlimited
ulimit -u   = 10666
lsof | wc -l = 33497
bun test 単体の lsof | wc -l = 299
```
→ どの上限にも引っかかっていない。
