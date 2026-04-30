# T375 検品レポート

## 判定: GO

## 要件カバレッジ

- [x] **要件1: tokenHandle 型追加** — 〇
  - `StatuslineConductor.agents[*]` (statusline.ts:41-47) に `tokenHandle?: string` 追加
  - `StatuslineRole`(kind: "agent").`agent` (statusline.ts:69-74) にも同型追加
  - `renderAgent` の引数型 (statusline.ts:302) も同型に拡張済み
- [x] **要件2: renderAgent でセグメント追加** — 〇
  - statusline.ts:314-316 で `handleSeg = agent.tokenHandle ? \` ${dim}|${reset} @${agent.tokenHandle}\` : ""`
  - taskId あり分岐 (statusline.ts:325) と taskId なし分岐 (statusline.ts:333) の両方で末尾に `+ handleSeg`
  - 区切りは既存の `${dim}|${reset}` パターンと一致
- [x] **要件3: 後方互換** — 〇
  - tokenHandle 未指定時は `handleSeg = ""` で文字列加算が no-op、既存出力と bit 一致
  - 専用テスト「tokenHandle なし — 既存出力と完全一致」(statusline.test.ts:412-421) で `expect(out).toBe("▸ researcher | T042 | ctx 42%")` を検証
- [x] **テスト3ケース** — 〇（実装は 4 ケース）
  - ① agent + tokenHandle あり → `@pers` が出る: statusline.test.ts:380-393（NF off / Color off, `toBe` で完全一致検証）
  - ② agent + tokenHandle あり / NF on / Color on: statusline.test.ts:395-410（dim 区切り `\x1b[2m|\x1b[0m @pers` を `toContain` + `endsWith` で検証）
  - ③ agent + tokenHandle なし → 既存出力一致: statusline.test.ts:412-421
  - ④ conductor.taskId なし + tokenHandle あり → タスクなし表示でも `@pers`: statusline.test.ts:423-436

## 検証結果

- **bun test**: `cd skills/cmux-team/manager && bun test --timeout 30000 statusline.test.ts` → **47 pass / 0 fail**（61 expect、118ms）
- **tsc**: `bunx tsc --noEmit` → エラー出力なし（新規 type エラーなし）
- **git status**: `package-lock.json` / `statusline.ts` / `statusline.test.ts` の 3 ファイルのみ modified
- **package-lock.json diff**: 19 行、内容は `version` 文字列 `4.15.0 → 4.16.0` のみ（Implementer の bun install 副次変更）

## Findings

### Critical (NOGO 要因)
- なし

### Major (Fix Required if GO)
- なし

### Minor (改善提案)
- **package-lock.json の version 差分について**: release commit `14b44a1 chore: release v4.16.0` は package.json のみ更新で package-lock.json は未追従だった。今回の作業中に bun install が走り副次的に同期された形。実害なし、かつリリース時の漏れを補完しているので許容。コミット時に含めるか分離するかは Conductor 判断で OK。
- **NF on / Color off ケースの直接 `toBe` 検証は省略**: 実装上 NF 軸は icon のみに作用し tokenHandle セグメントは NF 非依存のため、ケース ① (NF off / Color off) と ② (NF on / Color on) で実質網羅されている。改善としては「NF on / Color off」を `toBe("▸ implementer | T042 | ctx 42% | @pers")` （nerd icon 差し替え版）で 1 ケース足すと NF 軸の独立性がより明示できるが、必須ではない。
- **タスクなし + tokenHandle あり + NF on のケース** も同様に省略されているが、実装の構造上 (taskId 有無で handleSeg は共通) 不要と判断できる。

## スコープ確認

- master / conductor の renderer 部分には変更なし（statusline.ts:296 までは無修正）
- proxy.ts / daemon.ts / token-store / token-pool 等の変更なし（git status 通り）
- 他テストファイルの改変なし
- Implementer サマリの記述「proxy.ts は `formatStatusline` に `...rawState` をスプレッドで渡しており、daemon の `state.conductors[].agents[].tokenHandle` はそのまま流れてくる」は本タスク範囲では検証不要（タスク本文も statusline 描画追加のみのスコープ）

## コード品質

- 既存の `${dim}|${reset}` セグメント区切りパターンと完全に整合
- `agent` 型は 3 箇所（`StatuslineConductor.agents[*]`, `StatuslineRole.agent`, `renderAgent` 引数）で同じ shape を維持。型重複はあるが既存コードの記述スタイルを踏襲しており不整合ではない
- コメント (`T375: token pool 有効時のみ末尾に @<handle> セグメントを足す`) は WHY を簡潔に記述しており適切
- Implementer がレポート本文で言及している「color OFF 時は dim/reset が空文字になるので等幅で出る」は `col()` ヘルパー (statusline.ts:248-249, 272-273, 307-308) の挙動と整合確認済み

## 結論

**GO** — 完了処理（commit / merge）に進んでよい。

要件 1〜3 は全て満たされており、テストは要求 3 ケースを上回る 4 ケースで NF/Color 軸を網羅。既存テスト 43 件含めて 47 pass / 0 fail、tsc エラーなし、後方互換も `toBe` による bit 一致テストで担保。`package-lock.json` の差分は version bump 1 行のみで実害なし。
