# perf-probe

`bun test` 全体実行が O(N²) 級に劣化する真因を切り分けるための合成テスト集。

## 経緯

- A021 (T327) で「個別実行 68 秒なのに連結実行 13 分で 420 tests しか進まない」現象を観測
- T334 リリース時には GHA `prepublishOnly` で hang
- T336 で症状緩和 (個別ループ実行) を CI に投入
- 本ディレクトリ (T337) は **根治のための原因究明用 spike コード**

## 本番テスト群との分離

`*.probe.ts` 拡張子で書いている。これは bun の auto-discovery (`*.{test,spec}.{js,jsx,ts,tsx}`) にマッチしないため、`bun test` を引数なしで実行しても拾われない。明示的に `./perf-probe/<file>.probe.ts` または絶対パスで指定したときだけ走る。

確認:

```bash
$ bun test perf-probe                # substring match → 0 件
The following filters did not match any test files
 perf-probe
140 files were searched

$ bun test ./perf-probe/baseline-N10.probe.ts   # ./ プレフィックスで path 扱い
.... → 走る
```

bunfig.toml の追加・編集は **不要**。

## 構成

| ファイル | 役割 |
|---|---|
| `generate.ts` | 8 軸 × N=10/50/200 の dummy ファイルを emit するスクリプト |
| `measure.sh` | 全軸単独 + 連結実行を計測 (TSV 出力) |
| `measure-extra.sh` | listener 系軸 + 8 軸連結を追加計測 |
| `measure-many-files.sh` | 同一サイズで M=1/5/10/25/47 ファイル並べた M スケーリング測定 |
| `<axis>-N<N>.probe.ts` | 自動生成された dummy。**直接編集禁止**。`generate.ts` で再生成すること |
| `many/many-NN.probe.ts` | M スケーリング測定用に generate される |
| `many20/many-NN.probe.ts` | 同上 (20 tests/file 版) |

軸は次の 8 種:

- `baseline` — `expect(1).toBe(1)` のみ
- `eventbus` — `import "../eventBus"` + 空 expect
- `eventbus-emit` — listener 0 で `notifyStateChanged` を呼ぶ
- `eventbus-listener-leak` — `onStateChanged()` を登録し dispose しない
- `eventbus-listener-emit` — listener 登録 + emit を毎テスト
- `sqlite-close` — `new Database(":memory:"); db.close()`
- `sqlite-leak` — `new Database(":memory:")` を leak
- `spawn` — `await Bun.spawn(["echo","x"]).exited`

## 使い方

### 再生成

```bash
cd skills/cmux-team/manager
bun run perf-probe/generate.ts
```

### 1 ファイルだけ単独実行

```bash
cd skills/cmux-team/manager
gtimeout --kill-after=5 60 bun test --reporter=dots --timeout 10000 \
  ./perf-probe/baseline-N50.probe.ts
```

### 全測定

`<out-dir>` に TSV と raw ログが出力される。

```bash
cd skills/cmux-team/manager
OUT=/tmp/probe-out
mkdir -p "$OUT"
bash perf-probe/measure.sh "$OUT"
bash perf-probe/measure-extra.sh "$OUT"
bash perf-probe/measure-many-files.sh "$OUT"
```

`gtimeout --kill-after=N` の SIGKILL 併用は必須 (A021 §仮説8: bun は SIGTERM を実質無視する)。

## 結果の参照

T337 の最終結果は artifact として登録される (A022 予定)。生データは:

- 該当タスク `337-bun-test-o-n-2/runs/task-337-1777169439/{single,concat,extra,many-files}.tsv`
- `runs/.../raw-logs/` に bun の生 stdout

## 注意

- **本ディレクトリの `.probe.ts` は本番 CI/test では絶対に走らない**。手元での仮説検証専用
- 生成物 (`<axis>-N<N>.probe.ts`, `many/`, `many20/`) は git で追跡する。`generate.ts` を読まずとも内容が見られるように
- 軸を追加するときは `generate.ts` の `Axis` union と `AXES` 配列、および switch case を更新する
