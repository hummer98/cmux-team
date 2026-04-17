# T207 design review — paneId 永続化廃止 plan.md

- Reviewer: design-reviewer
- Run: task-207-1776243788
- Reviewed file: `.team/tasks/207-paneid-surface-pane-on-demand/runs/task-207-1776243788/plan.md`

## Verdict: Approved

## Summary

plan は「dual source of truth の解消」という根本対策を取っており、方針 A（フィールド完全削除）の選択根拠・workspace 伝播経路・削除タスクの完全性・手動 E2E まで網羅されている。Critical findings は 0 件で、CRITICAL チェック項目は全てパスする。listSiblingSurfaces のパース仕様や新規ヘルパーの単体テストなど Minor の補強余地はあるが、実装着手の妨げにはならない。

## CRITICAL チェック項目評価

| 項目 | 結果 | 根拠 |
|------|------|------|
| サブタスクカバレッジ | PASS | S1〜S21 で schema.ts / cmux.ts / conductor.ts / daemon.ts / main.ts / i18n.ts / conductor.test.ts の全変更対象を網羅 |
| 統合テスト/検証 | PASS | S16 (`bunx tsc --noEmit`) / S18 (`bun test` 全件) / S21 (手動 E2E 4 ステップ) |
| 削除タスクの完全性 | PASS | S2 (`getPaneIdForSurface`) / S15 (`--pane-id` ヘルプ) / S20 (`listPaneSurfaces` export) / S14 (`schema.paneId`) を明示削除 |
| 既存テストへの影響 | PASS | S17 で `conductor.test.ts` の `panes[0]!.surface` 戻り値型追従、`treeSpy` 整理を明示 |
| workspace 引数の伝播 | PASS | 2.4 で daemon 内 (`state.workspace`) と spawn-agent (`getCallerWorkspace()`) の経路を分離して図示。S6/S7 で `resetConductor` への伝播を明示 |

## レビュー観点別評価

### 1. 根本対策か — PASS
「キャッシュ層の validation を強化する」ではなく「キャッシュ層自体を消す」を選んでおり対症療法ではない。1.2「dual source of truth」の指摘と 2.1 の方針 A 選択は一貫している。

### 2. AI の手抜き防止 — PASS
方針 A は変更が最大化する選択だが「妥協せず A 一択」と明記。サブタスクが 21 件あるが、どれもスコープが小さく分割されており「変更が大きいから一部を残す」という妥協は見られない。

### 3. 設計原則 — PASS
- DRY: `getPaneIdForSurface` (conductor.ts) と `getPaneForSurface` (cmux.ts) の重複を D7 で統一
- SSOT: 真のソース（cmux daemon）に一本化
- 新ヘルパー `listSiblingSurfaces` は「2 段階呼び出しを 1 cmd に集約」する妥当な抽象。不要な抽象ではない

### 4. セキュリティ — PASS
削除主体の変更で新規入力経路はない。`cmux tree` の出力パースは既存 `getPaneForSurface` パターンを踏襲する想定で、シェル展開や eval は介在しない。

### 5. 既存パターンとの整合性 — PASS
- workspace 引数の流し方（2.4）は `main.ts:543-563` の既存パターン（`cmdStartDaemon` で `getCallerWorkspace()` → `state.workspace`）と整合
- `cmux` ヘルパーを `cmux.ts` に集約する慣習通り、`listSiblingSurfaces` を `cmux.ts` に追加し `conductor.ts:51` の重複を削除
- ログフォーマットへの言及は plan 内には明示的にないが、S1 で `log("error", ...)` を使う旨は記載されており既存規約に沿う

### 6. T207 固有の重要観点 — PASS
- **方針 A vs B**: D1 で性能・実害根治・実装複雑度の 3 軸で比較。spawn-agent / resetConductor の頻度（秒〜分単位）を踏まえ A を選んでおり妥当
- **listSiblingSurfaces 設計**: cmux tree 1 回で済む点は確認済み。fallback は「`[]` 返却時に agent.surface を個別 close」というセーフネットを保持（S6）
- **race condition**: 5.1 で「常に最新値を引くため race window がむしろ短くなる」と言及。スナップショット採用 + `.catch(() => {})` の既存パターン継承
- **後方互換削除の影響**: D4 で task.md「後方互換不要」を引用。`CONDUCTOR_REGISTERED` は内部経路でユーザー操作の手動コマンドのみ影響、運用上は現セッションでも `--pane-id` を渡さない選択肢が既にある

## Findings

### F1. minor — S5 の検証コマンドが順序的に不整合
**箇所**: plan §4 S5 (`initializeConductorSlots を新シグネチャに追従`)
**問題**: S5 の検証として `rg "paneId" skills/cmux-team/manager/conductor.ts → 0 件` を要求しているが、S5 完了時点では `resetConductor` (S6 で対応) 内に `conductor.paneId` が残っているため 0 件にならない。順序的には S6 完了後の検証として記載すべき。
**影響**: 実装者が S5 で grep を回したときに「失敗扱い」と誤認するリスク。実害はないが手戻りの可能性。
**修正提案**: S5 の検証を「`createConductorPanes` / `initializeConductorSlots` の関数本体内で `paneId` 参照が消えていること（rg 単純カウントではなくスコープ目視）」に変更し、`rg paneId → 0 件` の検証は S6 完了時点に移す。

### F2. minor — `listSiblingSurfaces` のパース戦略が未明文化
**箇所**: plan §4 S1
**問題**: 「cmux tree を 1 回呼び、surface が属する pane の全 surface を返す」とあるが、`tree()` の出力フォーマット（インデント階層 / `pane pane:NN` ヘッダー / 内部 surface の列挙形式）からどう sibling を抽出するかの方針が書かれていない。`cmux.ts:155-170` の `getPaneForSurface` は「直前に出てきた `pane (pane:\d+)` を currentPane として記憶し、surface マッチで返す」という line-by-line スキャン。`listSiblingSurfaces` は次の `pane (pane:...)` ヘッダーが来るまでの surface 群を集める必要があり、実装ロジックがやや異なる。
**影響**: 実装者が独自パーサを書いて `getPaneForSurface` と乖離させるリスク。
**修正提案**: S1 に「`getPaneForSurface` と同一の line-by-line スキャンを基本とし、対象 pane に入ったら次の pane ヘッダーまでの `surface:\d+` を収集する」と一行追記。または `tree(workspace, { json: true, idFormat: "refs" })` の JSON 出力を使う旨を明示。

### F3. minor — `listSiblingSurfaces` の単体テストが S17 に含まれていない
**箇所**: plan §4 S17
**問題**: S17 は既存 `conductor.test.ts` の追従修正のみで、新規ヘルパー `listSiblingSurfaces` の最小単体テスト追加が含まれていない。`getPaneForSurface` も既存テストはないため過剰要求にはあたらないが、新規 helper の方が代替経路（fallback）を持つため regression を見落としやすい。
**影響**: cmux tree 出力フォーマットが将来変わったときの検知遅延。
**修正提案**: S17 に「（任意）`__setTreeImpl` で固定 tree 出力を流し込み、`listSiblingSurfaces` が同 pane の sibling のみを返すこと・空時に `[]` を返すことの最小 2 ケースを追加」とサブ項目を入れる。Approved の前提条件にはしない。

### F4. minor — `cmdSpawnConductor` での `launchConductor` 呼び出しがサブタスクから明示的に欠落
**箇所**: plan §4 S4 (`launchConductor から paneId 引数を削除`)
**問題**: plan 2.4 に「`cmdSpawnConductor (main.ts:1552)` ... `launchConductor(projectRoot, surface)` (workspace 不要)」と書かれており、S4 のシグネチャ変更後 `cmdSpawnConductor` の呼び出し側も影響を受けるが、S4 のサブタスク内に「`cmdSpawnConductor` の呼び出し箇所も追従」という明示的な修正項目がない。実装者は tsc エラーで気付くため致命的ではないが、サブタスクの完全性を高めるには明示する方が良い。
**影響**: tsc で必ず検知されるので実害は無いが、サブタスク粒度の網羅性が部分的に欠ける。
**修正提案**: S4 の対象に「`main.ts:1552 付近 cmdSpawnConductor` の呼び出しも 3 引数化」を追記。

## Recommendations

1. **F1 の順序修正**は実装者がブレずに進むために優先度高め。S5 の grep 検証コマンドは S6 完了後に移すか、スコープ限定の検証文言に変える。
2. **F2 のパース戦略明文化**は数行で済むので S1 の説明を 1 行拡張するだけで品質向上。
3. **F3 のヘルパー単体テスト**は S17 の任意項目として組み込む。`__setTreeImpl` 既存フックがあり実装コストは小さい。
4. **F4 の cmdSpawnConductor 明示**は tsc が拾うので必須ではないが、サブタスク粒度を整える観点で追記推奨。
5. （追加観察）`cmux.ts` の `newSurface(paneId?)` シグネチャは `--pane` 引数を取り続けるので残置で正しい。`listPaneSurfaces` の S20 削除判断は内部呼び出しゼロ確認後に行うとの条件付きで適切。

総じて plan は実装着手可能なレベルに達している。Minor findings は実装中に随時拾える範囲。
