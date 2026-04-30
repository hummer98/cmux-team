# T337 完了サマリー

- 完了日時: 2026-04-26 JST
- ブランチ: `task-337-1777169439/task` → main に ff-only マージ予定
- 関連: A021 (T327), T334, T336

## やったこと

`bun test` 全体実行 O(N²) 級劣化の真因を、最小再現の合成テスト (dummy `*.probe.ts`) で軸ごとに切り分け。Researcher → Inspector の 2 phase で実施し、結果を **A022 (research artifact)** として登録した。

### サブタスク

1. Researcher Agent (surface:88) で perf-probe spike + 測定 + research.md 作成（約 12 分）
2. Inspector Agent (surface:91) で品質検品 → **GO 判定** Fix Required なし（約 6 分）

## 主な発見

- **A021 §仮説7（module-level singleton 累積）の素朴版は dummy では reject**。eventBus singleton import / emit / listener leak / SQLite Database leak のいずれも N=200 で線形以下、連結でも超線形劣化なし
- **`Bun.spawn` 軸だけ突出**: 他軸の ~50 倍 (3 ms/spawn)。A021 §仮説3（`main.test.ts` の `runCli` close 待ち leak）と整合
- **真因候補は 2 つに絞り込み**:
  - H1（強）: `main.test.ts` の `runCli` spawn leak／cold start コスト
  - H2（中）: `dashboard.tsx` の `onStateChanged` 登録が ink-testing-library 由来の React render tree 全体で漏れる
- bun runner 自体に N² overhead は無い（M=47 ファイル × 20 tests = 940 tests を bun_self 48 ms で消化）

## 次タスクの輪郭（research.md §6 から）

1. **R1（最優先・実装）**: `main.test.ts` の `runCli` を直接 import 形式に置き換える（`gh-cache-cli.test.ts` / `token-cli.test.ts` 既存パターン適用）
2. **R2（高優先・観測）**: `bunfig.toml` `[test] preload` で `__listenerCountForTest()` ダンプを全テストに inject
3. **R3（中優先・実装）**: `eventBus.ts` を factory 化 or 全テスト境界で `__resetBusForTest()` reset
4. **R4（中優先・観測）**: 連結中の `pgrep -fc 'bun run.*main.ts'` 時系列モニタ
5. **R5（低優先・運用）**: T336 (CI workflow) で probe を月次実行

## 変更ファイル

| パス | 種別 | 役割 |
|---|---|---|
| `skills/cmux-team/manager/perf-probe/README.md` | 新規 | perf-probe の経緯・分離戦略・使い方 |
| `skills/cmux-team/manager/perf-probe/generate.ts` | 新規 | 8 軸 × N=10/50/200 の dummy ファイル生成スクリプト |
| `skills/cmux-team/manager/perf-probe/measure.sh` | 新規 | 単独 + 連結実行の TSV 計測 |
| `skills/cmux-team/manager/perf-probe/measure-extra.sh` | 新規 | listener 系・8 軸連結の追加計測 |
| `skills/cmux-team/manager/perf-probe/measure-many-files.sh` | 新規 | M=1/5/10/25/47 ファイル並べた M スケーリング測定 |
| `skills/cmux-team/manager/perf-probe/<axis>-N<N>.probe.ts` | 新規 | 24 ファイル（8 軸 × 3 サイズ） |
| `skills/cmux-team/manager/perf-probe/many{,20}/many-NN.probe.ts` | 新規 | M スケーリング測定用 dummy |
| `.team/artifacts/A022-bun-test-o-n2-probe.md` | 新規 | research.md を artifact 化（Conductor 完了処理で生成） |

本番テスト群 (`*.test.ts` / `*.test.tsx`) には変更なし（Inspector 確認済み）。`bunfig.toml` 編集なし（`.probe.ts` 拡張子で auto-discovery 回避）。

## 測定データ

- 6 軸 × N=10/50/200 + 連結 + ファイル数スケーリング 47 ファイルまで = **38 データポイント**
- 単独実行 TSV: `single.tsv`
- 連結実行 TSV: `concat.tsv`
- listener 系・8 軸連結 TSV: `extra.tsv`
- ファイル数スケーリング TSV: `many-files.tsv`
- 全 raw bun output: `raw-logs/` (49 files)

## 検品結果

`inspection.md` を参照。判定 **GO**、A〜F 全項目 pass。Minor Findings 5 件はいずれも artifact 化のブロッカーではなく、判定に影響しない:

1. spawn/baseline self_ms 比 49.6×（50× 閾値を僅かに下回るが幅 30-60× で記述済み）
2. README の "140 files were searched" 例が古い（実機 246 files）
3. `package-lock.json` の `M` working tree 残置（本タスクと無関係、Conductor 側で revert）
4. 計測単発の再現性（Limitation §7.6 で自己言及済み）
5. R3 のトレードオフ言及がやや薄い

## 納品方式

- ローカル ff-only マージ（main へ）
- artifact: `A022-bun-test-o-n2-probe.md`
- マージコミット SHA: 後段で記載
