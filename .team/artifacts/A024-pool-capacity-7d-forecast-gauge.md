---
type: decision
title: pool capacity を「今後 7 日の日次割当 forecast ゲージ」に再設計
author: surface:master
status: confirmed
related_tasks: []
related_artifacts: [A019]
supersedes: "A019 §pool_capacity 指標 / §TUI 表示（capacity_5h_pct / capacity_7d_pct 二値表示）"
updated: 2026-04-28
---

# pool capacity を「今後 7 日の日次割当 forecast ゲージ」に再設計

## 背景

現状の pool capacity 指標（`computePoolCapacity` / `capacity_5h_pct` / `capacity_7d_pct`）には以下の違和感がある:

1. **% の意味が不明瞭**: 「Max x20 を 168h 持続したときの流量 = 100%」基準。100% を超え得る % は人間の「残量」感覚と乖離
2. **5h / 7d 二値表示の判断負荷**: ボトルネック側だけ見れば良いのに、どちらが律速か毎回読み手が判断する必要がある
3. **「次に何ができるか」が読みにくい**: 瞬間流量比率なので、reset 越えで pool がどう推移するかが直感に乗らない

5h は短時間で reset するため戦術的（今走らせて大丈夫か）、7d は戦略的（週末まで持つか）と役割が異なる。
**5h は単純な util_5h % 表示で残し、7d は forecast 型ゲージにする**のが本設計の骨子。

## 確定事項

| 項目 | 決定 |
|---|---|
| 表示形式 | 7 セルのスパークライン（`▁▂▃▄▅▆▇█` 8 段階） |
| 横軸 | 今後 7 日（Day 0..6） |
| Day 0 の bin | `[now, 今日 24:00 (local)]`（残り時間のみ。可変幅） |
| Day d (d≥1) の bin | 24h 固定 |
| 縦軸 | bin 内の plan_ratio 加重 allocation を bin 幅で正規化した rate |
| 100% ライン | sustainable pace（`Σ plan_ratio / 168` /h） |
| 100% 超 | 頭打ち `█` で表現（数値超過は色で示唆） |
| 5h 軸 | 既存の util_5h % 表示で残す（forecast 化しない） |

## 計算式

各 selectable アカウント i の per-hour rate（util_7d / reset_7d_at から導出）:

```
rate_i(t) =
  t < reset_7d_at_i  → (1 - util_7d_i) / hours_to_reset_i      # reset 前: 残量を残時間で按分
  t ≥ reset_7d_at_i  → 1/168                                   # reset 後: 持続ペース
```

bin = [a, b] における allocation 積分:

```
alloc_i([a,b]) =
  b ≤ reset_i    : (b-a) × rate_pre_i
  a ≥ reset_i    : (b-a) / 168
  bin straddles  : (reset_i - a) × rate_pre_i + (b - reset_i) / 168
```

bar 高さ:

```
pool(d)  = Σ alloc_i(bin_d) × plan_ratio_i
denom(d) = (bin_hours_d / 168) × Σ plan_ratio_i
bar(d)   = pool(d) / denom(d)        # 100% = sustainable pace
```

bin 幅（bin_hours）で正規化するので、Day 0 が 6h など短くても bar 高さは Day 1..6 と直接比較可能（rate 比較になる）。

## 検証ケース

### Case 1: 単純例（now = 00:00、Day 0 = 24h フル）

A: util=50%, hours_to_reset=48h, rate_pre=0.0104/h
B: util=70%, hours_to_reset=120h, rate_pre=0.0025/h
plan_ratio = 1 each

| Day | A alloc | B alloc | pool | denom | bar |
|---|---|---|---|---|---|
| 0 | 0.25 | 0.06 | 0.31 | 0.286 | **108%** |
| 1 | 0.25 | 0.06 | 0.31 | 0.286 | **108%** |
| 2 | 0.143 (post) | 0.06 | 0.203 | 0.286 | **71%** |
| 3 | 0.143 | 0.06 | 0.203 | 0.286 | **71%** |
| 4 | 0.143 | 0.06 | 0.203 | 0.286 | **71%** |
| 5 | 0.143 | 0.143 (post) | 0.286 | 0.286 | **100%** |
| 6 | 0.143 | 0.143 | 0.286 | 0.286 | **100%** |

### Case 2: bin straddle（now = 18:00、Day 0 = 6h）

A: util=50%, hours_to_reset=40h（now+40h は Day 2 の途中）, rate_pre=0.0125/h
B: util=70%, hours_to_reset=120h（now+120h は Day 5 の途中）, rate_pre=0.0025/h
plan_ratio = 1 each

| Day | bin (h) | A alloc | B alloc | pool | denom | bar |
|---|---|---|---|---|---|---|
| 0 | [0, 6] | 0.075 | 0.015 | 0.090 | 0.0714 | **126%** |
| 1 | [6, 30] | 0.30 | 0.06 | 0.36 | 0.286 | **126%** |
| 2 | [30, 54] | 10×0.0125 + 14/168 = 0.208 | 0.06 | 0.268 | 0.286 | **94%** |
| 3 | [54, 78] | 0.143 | 0.06 | 0.203 | 0.286 | **71%** |
| 4 | [78, 102] | 0.143 | 0.06 | 0.203 | 0.286 | **71%** |
| 5 | [102, 126] | 0.143 | 18×0.0025 + 6/168 = 0.081 | 0.224 | 0.286 | **78%** |
| 6 | [126, 150] | 0.143 | 0.143 | 0.286 | 0.286 | **100%** |

reset の bin またぎが per-hour rate の積分で自然に処理される。

## TUI 表示

### ヘッダー（dashboard / status 共通、1 行）

```
pool 7d  ██▇▅▅▆█   next: @kddi 5h:65%
```

**構成**:
- `7d <spark>`: 7 セルの forecast（Day 0..6）
- `next: @handle 5h:NN%`: 次に spawn-agent で割り当てられる候補アカウントの util_5h

**7d スパークライン**:
- 8 段マッピング:
  - 0–12.5%: ` `（空）/ 12.5–25%: ▁ / 25–37.5%: ▂ / 37.5–50%: ▃
  - 50–62.5%: ▄ / 62.5–75%: ▅ / 75–87.5%: ▆ / 87.5–100%: ▇
  - ≥100%: █（cap）
- 色（全 cell 一括、`min(bar(d) for d=0..6)` ベース）:
  - ≥100% : green / 70–100%: yellow / <70% : red

**next 候補の選定（peek、lease は取らない）**:
- `project_tags` でフィルタ（`.team/config.json` / git remote fallback）
- `selectable=1` / blocker 条件クリア（util_5h ≤ 95% / 非 stale[^stale-rescue] / 非 lease）
- `score = w_5h × util_5h + w_7d × util_7d` 最小を選ぶ
- 既存 `selectToken` の lease 取得を skip した dry-run を提供

[^stale-rescue]: T373 以降、現行 `selectToken` admit は stale 救済方針に変更されている。
T374 で実装する `peekNextToken` は spawn-agent との整合のため admit 経路（`admitCandidates`）に追従し、
stale でも reset 通過済み軸の `effUtil_*=0` 救済込みで peek する。
本ヘッダーの「next 候補」表示はこの admit 経路と一致するため、
A024 執筆時点の「非 stale」blocker 文言は当時の admit 仕様の写しとして読み替える。

**5h util の色**:
- `>95%`: 赤（実質 blocker 通過した候補が居ない / 別アカウントに切り替わる境界）
- `>70%`: 黄
- それ以下: 緑（or gray）

**エッジケース**:

| 状況 | 表示 |
|---|---|
| 候補アカウントなし（全 blocked / tags 不適合） | `next: ⚠ no eligible account` |
| pool 機能 OFF / token 未登録 | このヘッダー行ごと出さない |
| 候補は居るが util_5h null（snapshot 待ち） | `next: @kddi 5h:—` |
| 全アカウントの reset_7d_at が null | 7d スパークラインは出さず `next:` だけ表示 |

### per-handle 行は出さない

A019 §TUI 表示にあった `Master [969] @pers <5h:10%/7d:30%> cap:100%` 形式の per-surface decoration は **本リリースでは削除**（5h は next 候補のみ、7d はヘッダー forecast に集約）。

詳細を見たい場合は `cmux-team token list` / `cmux-team pool status` で確認する。

## 既存実装との関係

| 既存 | 扱い |
|---|---|
| `computePoolCapacity` (token-store.ts:754-803) | 別関数で forecast 版を新設。既存も per_token cap 用途で当面残す |
| `pool-summary.ts::buildPoolSummary` | 戻り値型を拡張して forecast 配列を含める |
| `pool-status-header.ts::buildPoolHeaderLines` | 7d 行を スパークラインに置き換え |
| `pool-header-display.ts::buildPoolHeaderDisplay` | 同上（Ink 用 RateLimitPart） |
| `pool-next-reset.ts::computeNextReset` | forecast から自然に読み取れるので削除候補（残す場合は補足表示） |
| `capacity_5h_pct` | 廃止候補 → 各 token の `util_5h` 表示は残す |
| `capacity_7d_pct` | forecast に置き換えて廃止 |

## エッジケース

| ケース | 扱い |
|---|---|
| `util_7d` / `reset_7d_at` が片方 null | アカウントを完全除外（plan_ratio も denom から外す） |
| `selectable=false` | 完全除外（denom にも入れない） |
| reset がすでに過去 | now 起点で post-reset rate（1/168）を使う |
| 全アカウントの reset が >7d 先 | 全 bin が pre-reset rate になる（特殊扱い不要） |
| forecast が全 cell 100% 超 | 全部 `█` で OK（色で「rich」表現） |

## TODO（タスク化候補）

1. `forecast.ts`（仮称）: 入力 `TokenForCapacity[]` + `nowIso` → `bar[7]` を返す純関数 + テスト
2. `pool-summary.ts` を拡張して forecast 配列を `PoolSummary` に同梱
3. `pool-status-header.ts` / `pool-header-display.ts` をスパークライン表示に書き換え
4. `pool-next-reset.ts` の去就決定（残すか削除するか）
5. `docs/spec/09-token-pool.md` の表示仕様セクション更新
6. CHANGELOG / README 更新

## T444 update: BLOCKER_7D 反映へ計算式変更（2026-05-07）

旧式 `(1 - util_7d) / 1` は selectToken の `effUtil7d > BLOCKER_7D` exclude
（token-store.ts L1259）と整合せず、spark が 100% でも 5% しか余白がない楽観的表示になっていた。
numerator 側で `remaining = max(BLOCKER_7D - util_7d, 0)` / post_rate = `BLOCKER_7D / 168`
に変更し、denom は維持。「100% = sustainable pace」の semantics は保たれる
（実用上、BLOCKER_7D 比 sustainable pace を 100% として読む）。

### 新計算式

```
remaining_i = max(BLOCKER_7D - util_7d_i, 0)   # T444 で blocker 上限反映

rate_i(t) =
  t < hoursToReset_i  → remaining_i / hoursToReset_i              # reset 前: blocker 残量 / 残時間
  t >= hoursToReset_i → BLOCKER_7D / 168                          # reset 後: blocker 比 sustainable pace

alloc_i([a, b]) =
  b <= reset_i      : (b - a) * rate_pre_i
  a >= reset_i      : (b - a) * BLOCKER_7D / 168
  bin straddles     : (reset - a) * rate_pre + (b - reset) * BLOCKER_7D / 168

pool(d)  = Σ alloc_i(bin_d) * plan_ratio_i
denom(d) = (bin_hours_d / 168) * Σ plan_ratio_i           # 変更なし
bar(d)   = pool(d) / denom(d) * 100   # 100% = (BLOCKER_7D を上限とした) sustainable pace
```

### 検証ケース（新仕様 BLOCKER_7D=0.95 反映後）

#### Case 1（now = 00:00、Day 0 = 24h フル）

A: util=0.5, hours_to_reset=48h → pre_rate = (0.95-0.5)/48 = 0.009375
B: util=0.7, hours_to_reset=120h → pre_rate = (0.95-0.7)/120 = 0.002083
post_rate = 0.95/168 = 0.005655

| Day | A alloc | B alloc | pool | bar |
|---|---|---|---|---|
| 0 | 0.225 | 0.05 | 0.275 | **96%** |
| 1 | 0.225 | 0.05 | 0.275 | **96%** |
| 2 | 0.1357 (post) | 0.05 | 0.186 | **65%** |
| 3 | 0.1357 | 0.05 | 0.186 | **65%** |
| 4 | 0.1357 | 0.05 | 0.186 | **65%** |
| 5 | 0.1357 | 0.1357 (post) | 0.271 | **95%** |
| 6 | 0.1357 | 0.1357 | 0.271 | **95%** |

旧 `[108, 108, 71, 71, 71, 100, 100]` → 新 `[96, 96, 65, 65, 65, 95, 95]`

#### Case 2（now = 18:00、Day 0 = 6h、bin straddle）

A: util=0.5, hours_to_reset=40h → pre_rate = 0.45/40 = 0.01125
B: util=0.7, hours_to_reset=120h → pre_rate = 0.25/120 = 0.002083

| Day | bin (h) | A alloc | B alloc | pool | bar |
|---|---|---|---|---|---|
| 0 | [0, 6] | 0.0675 | 0.0125 | 0.080 | **112%** |
| 1 | [6, 30] | 0.27 | 0.05 | 0.32 | **112%** |
| 2 | [30, 54] | 0.1917 (straddle) | 0.05 | 0.242 | **85%** |
| 3 | [54, 78] | 0.1357 | 0.05 | 0.186 | **65%** |
| 4 | [78, 102] | 0.1357 | 0.05 | 0.186 | **65%** |
| 5 | [102, 126] | 0.1357 | 0.0714 (straddle) | 0.207 | **72%** |
| 6 | [126, 150] | 0.1357 | 0.1357 | 0.271 | **95%** |

旧 `[126, 126, 94, 71, 71, 78, 100]` → 新 `[112, 112, 85, 65, 65, 72, 95]`
