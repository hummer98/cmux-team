# T381 conflict resolution log

## メタ情報

- **taskRunId**: `task-381-1777565435`
- **branch**: `task-381-1777565435/task`
- **rebase target**: `main` (local main was strict-ahead of origin/main)
- **PRE_REBASE HEAD**: `01ee051ae47f0db17e15d717e6c5cd2edad39b6c`
- **POST_REBASE HEAD**: `ff86026` (= cherry-picked T381 on top of T380)

## 衝突 commit

| commit | role | 内容 |
|---|---|---|
| `01ee051` (T381, ours) | cherry-pick 元 | cmux-team metrics に snapshot/compare/health subcommand を追加 |
| `6706359` (T380, theirs / new main) | rebase target | docs(spec): metrics taxonomy + CodeDNA 評価判定基準を文書化 |

T380 と T381 はどちらも `docs/spec/11-metrics.md` を新規作成し、`docs/spec/glossary.md` に §11 を追加するため、add/add および content conflict が発生。両者は補完的（taxonomy の基盤 vs 運用層）。

## 衝突ファイル別採用方針

### 1. `docs/spec/11-metrics.md`（add/add conflict）

| 採用 | 内容 |
|---|---|
| T380 全文（§1〜§7）を保持 | metrics taxonomy 基盤として必要 |
| T381 §1〜§7 を §7〜§13 として renumber | 運用層を taxonomy の上に重ねる |
| T381 §8 (関連) と T380 §7 (関連) を統合して新 §14 | 重複する関連 spec / task / コードを 1 箇所に集約 |
| 冒頭タイトルは `# 11. Metrics`（T380 ベース） | spec 番号体系と整合 |
| T381 冒頭の SSOT / TZ / schema_version 注釈 | §6 と §7 の間の境界注釈ボックスに移動（冒頭の混雑回避） |
| T380 §4.1 の `N=14 day` 暫定値 | T381 確定の `4 週 = 2026-05-04 〜 5-31` に update（歴史メモを §4.1 に注釈追加） |
| T380 §4.4 の閾値言及 | §10 への参照を追加（コード SSOT を明示） |
| T381 内の cross-link | 新セクション番号に更新（`#1-snapshot-...` → `#7-snapshot-...`、`#2-baseline...` → `#8-baseline...`、`#3-cohort...` → `#9-cohort-比較-cli` 等） |

### 2. `docs/spec/glossary.md`（content conflict §11）

| 採用 | 内容 |
|---|---|
| T380 の 6 用語 | `metrics SSOT`, `cohort comparison`, `baseline period`, `evaluation period`, `header rot`, `agent message GC` |
| T381 の 1 用語 | `daily snapshot`（新規追加） |
| 重複 3 用語 | `cohort comparison` / `baseline period` / `evaluation period` は両者の定義を merge（T381 の運用情報「2026-05-04 から 4 週」と CLI 例を T380 の定義に追加） |
| 一次リンク | 新セクション番号に更新（§7 / §8 / §9 等） |
| セクションタイトル | `## 11. Metrics / cohort 比較`（T381 ベース、taxonomy 単独タイトルから運用込みのタイトルへ） |

最終 7 用語: `metrics SSOT`, `baseline period`, `evaluation period`, `cohort comparison`, `daily snapshot`, `header rot`, `agent message GC`。

## Resolution Strategy

1. **両側の意図を統合**: T380 の taxonomy は T381 の運用が依拠する基盤、T381 の運用は T380 の taxonomy の自然な拡張。両者を排除せず串刺し。
2. **番号衝突回避**: 両側とも `## 1.〜## 7|8.` を持っていたため T381 を §7〜§14 に renumber。リンクも全て更新。
3. **歴史的妥当性の保持**: T380 §4.1 の N=14 day を消さず歴史メモとして残し、T381 で N=4 週に確定した経緯を脚注で説明（後続のレビュアーが「なぜ変わったのか」を追える）。
4. **SSOT の明示**: T381 が確定した `metrics-thresholds.ts` を §10 の SSOT として強調し、T380 §4.4 の閾値言及からも §10 への参照を追加（コード/spec の責務分離）。

## Verification

| 検査 | 結果 |
|---|---|
| 8-4 (1) scope_violation | pass — CHANGED ⊆ ALLOWED（cherry-pick 元 commit が触ったファイル + 衝突ファイルの和集合に収まる） |
| 8-4 (2) test (metrics 系 7 ファイル + events-cli) | pass — 137 pass / 0 fail |
| 8-4 (3) tsc (skills/cmux-team/manager) | pass — exit 0、新規エラーゼロ |

## Iterations

- **iteration 1**: 8-1 で `docs/spec/11-metrics.md` と `docs/spec/glossary.md` の 2 ファイル衝突を確認 → 8-2 で衝突元 = T380 (commit 6706359) と特定 → 8-3 で両ファイルを semantic merge → 8-4 検証 pass → 8-5 完了。

iteration 数: **1 回で収束**。escalation なし。
