# T337 検品レポート

- 検品日時: 2026-04-26 JST
- 検品 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-337-1777169439`
- 対象成果物:
  - レポート: `.team/tasks/337-bun-test-o-n-2/runs/task-337-1777169439/research.md`
  - spike: `skills/cmux-team/manager/perf-probe/`
  - 生データ: `runs/task-337-1777169439/{single,concat,extra,many-files}.tsv` + `raw-logs/`

## 判定: GO

A〜F のすべての必須項目が pass。実機 sanity check (`bun test perf-probe` → 0 件、`bun test ./perf-probe/<file>` → 走る) も再現。spawn 軸の per-test コスト突出が他軸の ~50 倍として明確に観測されている。Minor 指摘（後述）はあるが、本タスクの目的（A021 §仮説7 の素朴版を refute、H1/H2 への絞り込み、次タスクの観測計装案の提示）を達成しており、artifact 化に進める品質。

## A. 作業境界

- [x] 本番テスト群 (`skills/cmux-team/manager/*.test.ts` / `*.test.tsx`) に変更なし
  - 検証: `git diff --stat main..HEAD -- 'skills/cmux-team/manager/*.test.ts' 'skills/cmux-team/manager/*.test.tsx'` → 空
- [x] `eventBus.ts` / `bun:sqlite` 利用箇所などの本番コード修正なし
  - 検証: `git diff main..HEAD -- skills/cmux-team/manager/eventBus.ts skills/cmux-team/manager/state-machine/` → 空
- [x] `.team/artifacts/` への直接書き込みなし
  - 検証: `git status --short` の untracked は `skills/cmux-team/manager/perf-probe/` のみ。artifact 化は Conductor が後段で実施する取り決めに従っている
- [x] main ブランチに commit していない
  - 検証: `git log main..HEAD --oneline` → 空（task ブランチが main HEAD と同位置、commit 追加なし）
- [x] `bunfig.toml` 編集なし
  - 検証: `git diff main..HEAD -- bunfig.toml` → 空。研究レポート §2.1 と README が `bunfig.toml の追加・編集は不要` と結論しており、その通り

注: 作業ツリーには `package-lock.json` の `M` が残っているが、これは本タスク開始時の初期 status 由来であり、`git diff main..HEAD package-lock.json` は空（commit はされていない）。本タスクの修正物ではない。

## B. 拡張子戦略の妥当性

- [x] `.probe.ts` で本番テスト群と分離されていること（実機再確認）
  - `cd skills/cmux-team/manager && bun test perf-probe` → `The following filters did not match any test files ... 246 files were searched [5.00ms]` で **0 件マッチ**
  - `ls perf-probe/*.test.ts perf-probe/*.test.tsx perf-probe/*.spec.ts` → 全て no matches。`.test.ts` / `.test.tsx` / `.spec.ts` を含むファイルは perf-probe 配下に 0 個
  - `bun test ./perf-probe/baseline-N10.probe.ts` → `Ran 10 tests across 1 file. [13.00ms]` → 明示パスでのみ走ることを確認
  - `bun test ./perf-probe/spawn-N10.probe.ts` → `Ran 10 tests across 1 file. [38.00ms]` → spawn 軸も走る
- README §本番テスト群との分離 が実機挙動と一致

## C. 測定方法の妥当性

- [x] 単独実行 (`single.tsv`) / 連結実行 (`concat.tsv` + `extra.tsv`) / ファイル数スケーリング (`many-files.tsv`) の 3 系統が揃っている
- [x] `gtimeout --kill-after=N` で SIGKILL 併用
  - 検証: `measure.sh:37,56` / `measure-extra.sh:24` / `measure-many-files.sh:46,87` の全 5 箇所に `--kill-after=5|10` 付き。A021 §仮説8 の知見に整合
- [x] 時間取得が ms 精度 + bun 自己申告 elapsed の両方
  - `single.tsv` ヘッダ: `axis  N  wall_ms  bun_summary` で外側 `gdate +%s%3N` と bun の `Ran X tests across Y file. [N.NN ms]` の双方を保持
- [x] N=200 列が信頼できるシグナル
  - 実数値 (`single.tsv`):
    - `baseline N=200 wall=29 self=12`
    - `spawn N=200 wall=618 self=595`
  - **self_ms 比 = 595 / 12 = 49.6×**（per-test では 2.98 ms/spawn vs 0.06 ms/baseline ≈ 50×）。明確に他軸と階層が分離。ms/test スケール (0.06 → 2.98) で線形 vs 急峻が判別可能

## D. 仮説絞り込みの論理

- [x] A021 §仮説7（module-level singleton 累積）の refute が測定値と整合
  - eventbus-import (N=200 self=20)、eventbus-emit (15)、listener-leak (27)、listener-emit (25)、sqlite-close (18)、sqlite-leak (15) のすべてが線形以下。連結 (`all8-N200` self=623) でも超線形劣化なし
  - 「素朴な形では refute」「dashboard ink-render / daemon ライフサイクル / interactive 子プロセスは未再現」と但し書きが適切
- [x] H1（main.test.ts spawn leak）の根拠
  - spawn 軸が dummy 5 軸の中で唯一明確に重い (3 ms/spawn)
  - A021 で観測済みの `bun run main.ts token add` 13h leak (PID 11564 等) を引用
  - 個別実行が無事なのは「親 bun が exit すると子もまとめて死ぬ」と説明
- [x] H2（dashboard listener 漏れ）の根拠
  - dummy 200 listener では効かないが、ink-testing-library 由来の React tree subscription は数千規模になり得る
  - 1300 tests × 1000 listener = 130 万 callback の試算が示されている
- [x] 各 H に「次タスクで取るべき証拠」が具体的に列挙
  - H1: `pgrep -fc 'bun run.*main.ts'` 時系列、`proc.exited` 解決数、`runCli` 直接 import 化後の連結時間
  - H2: `__listenerCountForTest()` 時系列、dashboard skip 時の time、`unmount()` 漏れの一覧
- [x] dummy のスケール 1/3 が Limitation §7.1 に明記
- [x] 見逃された仮説候補の自己点検が Limitation §7.5 に明記
  - `bun:sqlite` の本物の負荷 (migration / WAL / 大量 INSERT) は probe していない
  - `trace-store.ts` / `token-store.ts` の Database singleton + migration 重複適用への言及あり
  - `eventBus.ts` 以外の module top-level 副作用が「daemon ライフサイクル / queue watcher / PID watcher / timer」として §4.3 に列挙されている

## E. 推奨事項の具体性

- [x] R1〜R5 が次タスクの「やること」粒度
  - R1: `runCli` の直接 import 化（最優先・実装）
  - R2: `--preload` で `__listenerCountForTest` ダンプ計装（観測強化）
  - R3: `eventBus.ts` の factory 化 / 全テスト境界 reset（実装）
  - R4: 連結中の子プロセス監視シェル断片（観測強化）
  - R5: CI で probe 周期測定（運用）
- [x] 各 R に期待効果 / 検証方法
  - R1: 「13 min → 数分台」「個別合計 vs 連結時間 の比が 1.x 倍に収まれば成功」
  - R2: 「listener 数 / heap 推移が file 境界ごとに stderr に出る → H2 を confirm/refute 可能」
  - R3 案 a/b: 「最小変更で全テスト reset を強制」
  - R4: 「劣化時刻と spawn 残存数の相関が見える」
  - R5: 「bun のバージョン更新で N² が混入したら早期検知」
- [x] R1 が他 `*-cli.test.ts` の実装パターンを参照
  - 「既に `gh-cache-cli.test.ts` / `token-cli.test.ts` で実装済みの直接 import パターンを `main.test.ts` 全体に適用」と implementation reference が明示

## F. 文書品質

- [x] research.md が 7 セクション構成
  - 1. 概要 / 2. Methods / 3. Measurements / 4. Analysis / 5. Hypothesis narrowing / 6. Recommendations / 7. Limitations + 付録
- [x] perf-probe/README.md に経緯・分離戦略・使い方
  - 経緯: A021 → T334 → T336 → T337 の系譜
  - 分離戦略: `.probe.ts` の auto-discovery 非対象であることを実コマンドの出力で示している
  - 使い方: 再生成 / 単独実行 / 全測定の 3 セクション
- [x] 測定スクリプトと生成スクリプトに「再生成方法」のコメント
  - `generate.ts:3` `// 使い方: cd skills/cmux-team/manager && bun run perf-probe/generate.ts`
  - `measure.sh:4` `# 使い方: cd skills/cmux-team/manager && bash perf-probe/measure.sh <out-dir>`
  - `measure-extra.sh:4` / `measure-many-files.sh:7-8` も同様に明示

## Fix Required

(なし — GO 判定)

## Minor Findings (GO でも記載)

1. **spawn/baseline self_ms 比が 49.6× で 50× 閾値を僅かに下回る**
   - 検品プロンプトの C 項は「50 倍以上」を期待しているが、`595 / 12 = 49.58`。per-test ms (2.98 / 0.06 ≈ 50) でも同程度
   - レポート §3 で計測単発 (±20% noise) と但し書きしており、研究 §4.1 自体は「30〜60 倍」と幅で記述。シグナルとしての階層分離は明確で、再測定すれば 50× を境界またぎする見込み。**判定には影響しない**が、artifact 化時の文中で「ほぼ 50 倍 (49.6×)」のように具体値を併記しても良い

2. **README の確認実行例の "140 files were searched" は古い**
   - `perf-probe/README.md` の確認例ブロックは perf-probe 配下が 24 ファイル時点のスナップショット。`many/` `many20/` の追加で実機は **246 files** に増えている
   - 例示の趣旨（フィルタが 0 件）は変わらないので機能上の問題はないが、README 末尾に「*generate.ts により ファイル数は変動する*」のような注意書きを足すと future-proof

3. **package-lock.json の `M` が working tree に残置**
   - 本タスクの作業物ではないが、status 出力上のノイズになる。最終的な spike commit を切る時点で `git checkout -- package-lock.json` で戻すか、無関係 commit に分離する判断は次の Conductor / Master レイヤーで対応

4. **計測単発のため再現性は別途要確認**
   - レポート §7.6 で自己言及済み。「主要数字（spawn-N200 self_ms, all-N200 self_ms）は 3 回 median」のような追加計測を artifact 化前にもう 1 周走らせると安全だが、今回は時間トレードオフ上 single-shot で OK と判断

5. **R3 のリスクへの言及が薄い**
   - `eventBus.ts` を factory 化（案 b）は呼び出し側全体に波及する。R3 案 a (preload で `beforeEach(__resetBusForTest)`) を本命と書きつつ、案 b の影響範囲（dashboard / daemon / queue / hook 受信側全部の signature 変更が必要）を 1 行で添えると、次タスク着手時の判断が早くなる。今回は `案 a の方がコスト低・効果検証が早い` の一言で済んでいるが、もう少しトレードオフを書いてもよい

## 補足: 検証コマンド再実行ログ

```text
$ git status --short
 M package-lock.json
?? skills/cmux-team/manager/perf-probe/

$ git diff --stat main..HEAD          # 空（commit 追加なし）
$ git log main..HEAD --oneline        # 空

$ git diff main..HEAD -- 'skills/cmux-team/manager/*.test.ts' \
                         'skills/cmux-team/manager/*.test.tsx' \
                         skills/cmux-team/manager/eventBus.ts \
                         skills/cmux-team/manager/state-machine/ \
                         bunfig.toml
                                       # 空

$ cd skills/cmux-team/manager && bun test perf-probe
The following filters did not match any test files in --cwd="..."
 perf-probe
246 files were searched [5.00ms]

$ bun test ./perf-probe/baseline-N10.probe.ts
 10 pass / 0 fail / 10 expect() calls / Ran 10 tests across 1 file. [13.00ms]

$ bun test ./perf-probe/spawn-N10.probe.ts
 10 pass / 0 fail / 10 expect() calls / Ran 10 tests across 1 file. [38.00ms]

$ head -3 single.tsv
axis  N  wall_ms  bun_summary
baseline  10  24  Ran 10 tests across 1 file. [8.00ms]
baseline  50  25  Ran 50 tests across 1 file. [8.00ms]
```
