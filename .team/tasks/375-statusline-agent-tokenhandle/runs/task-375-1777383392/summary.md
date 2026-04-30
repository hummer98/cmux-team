# T375 — statusline に agent の tokenHandle を表示

## 概要

token pool 有効時に各 agent がどの token (`@handle`) を使っているかを cmux ペインの statusline に末尾セグメントとして表示する機能を追加。

## 完了したサブタスク

- Phase 3 (Implementer): `renderAgent` への tokenHandle セグメント追加 + 4 テスト追加
- Phase 4 (Inspector): GO 判定（要件 1〜3 全充足、Critical/Major findings なし）

## 変更ファイル

- `skills/cmux-team/manager/statusline.ts` (+22/-6)
  - `StatuslineConductor.agents[*]` / `StatuslineRole.agent` / `renderAgent` 引数の 3 箇所に `tokenHandle?: string` 追加
  - `renderAgent` で `handleSeg = agent.tokenHandle ? \` ${dim}|${reset} @${tokenHandle}\` : ""` を taskId 有無の両分岐で末尾に付加
- `skills/cmux-team/manager/statusline.test.ts` (+58/-0)
  - 4 ケース追加（NF off, NF on/Color on, 後方互換 bit 一致, taskId なし + tokenHandle あり）
- `package-lock.json` (+2/-2)
  - bun install による副次変更（version `4.15.0 → 4.16.0`、リリース時漏れの補完）

## テスト結果

- `cd skills/cmux-team/manager && bun test --timeout 30000 statusline.test.ts` → **47 pass / 0 fail**（既存 43 + 新規 4、61 expect / 118ms）
- `bunx tsc --noEmit` → 新規エラーなし

## 動作確認（手元）

cmux 環境で pool ON にして agent を spawn する手元確認は本タスクでは実施せず、テストでセグメント形式と後方互換を担保。pool OFF / `tokenHandle` 未設定時は `handleSeg = ""` で文字列加算が no-op となり既存出力と bit 一致することを `toBe()` 検証で担保している。

## マージコミット

(後段で埋める)

## 自己判断

- **フロー判定**: 当初「軽微」(Phase 3 のみ) を想定したが、test 込みで +83 行となり目安 (+30/-30) を超えたため「中規模」に格上げして Inspector を回した。判断材料は変更行数のみで、コード変更自体は方針明示の単純追加。
- **テスト 4 ケース**: 要件は 3 ケースだが NF on/off の両軸を担保するため Implementer が 1 ケース追加。Inspector も妥当性を確認済み。
- **package-lock.json**: bun install 副次変更（version 1 行のみ）。Inspector も「許容、リリース時漏れの補完」と評価。commit に含める。

## 懸念・残課題

- なし。Inspector の Minor 提案 (NF on / Color off ケース追加、taskId なし + NF on ケース追加) は実装の構造上 NF 軸が icon のみに作用するため省略可能と判断（Inspector も「必須ではない」と明記）。
