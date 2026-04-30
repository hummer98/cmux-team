# Design Review — T325 (revision 2)

## Verdict
- **Approved**（軽微な残リスクあり、Implementer に渡せる品質に達している）

## Summary

改訂版 plan は前回の Changes Requested で挙げた必須 1〜3 をすべて適切に取り込んでいる。

1. **「50 件以上」要件のエスカレーション**: §0「検証基準の更新（rev2）」で「最低 12 ケース pass + 推奨 15 件以上 + 移植不能テストは全件 inline コメントで skip 理由を記録」に明示下方修正し、Step 0 を新設して着手前の Master 報告手順を組み込んだ。§3 / §4 R1 / §5 完了条件 #2 にも一貫して反映されており、後段で verdict が割れる構造的リスクは解消している。
2. **`deleteToken` 配線**: Conductor 判断 (b) 別タスク起票を採用し、§5 完了条件 #6 に「`T319 D系列を cmdTokenRemove に配線する` を本タスク完了後に起票する」と明記。§3 注記 / §4 R11 でも production consumer 不在を明示しており、dead code 化リスクは管理下に置かれている。Option C（main の token-cli.ts 不変）も維持されている。
3. **`os.homedir()` 記述**: 旧版の誤記述（`XDG_HOME` 言及 / native API 警告）はすべて削除され、§1.3 / §2-A で「Node.js / Bun の `os.homedir()` は POSIX (macOS 含む) 上で `HOME` env が定義されていれば必ず尊重する」と正しく書き直されている。`process.env.HOME = tmpDir` 上書き経路と「副作用回避時の手動入力経路 fallback」も併記。

推奨 4〜8 もすべて plan に取り込まれている: 件数 13 件への再カウント (§1.2)、補強テスト 2 件の選び直し (§1.1 候補 1 / 候補 2)、Step 2-A-Pre による readline mock hoisting 検証ステップの明示、`process.argv = originalArgv.slice()` の fresh copy 代入統一、`globalThis.fetch` を関数毎に try/finally で退避する pattern。

新規懸念 R9 (`credential_source` 列文字列の整合) / R10 (`cmdTokenRemove` の Keychain 削除タイミング → 手動検証 #3 を追加) / R11 (D 系列 production consumer 不在) も §4 に明記され、§5 / §6 で対応指示まで具体化されている。

件数も §0 / §1.2 / §2-A / §3 / §5 完了条件 #2 すべてで「active 13 件 + skip 4 件」と一致しており、整合性は維持されている。

## 良かった点（改訂で追加された強み）

- **§0 の検証基準下方修正と §3 / §5 への一貫反映**: 「task.md の 50 件目標は Option C と物理的に矛盾」を §0 / §4 R1 で明示し、新基準（最低 12 / 推奨 15）を §3 検証計画の表注記 / §5 完了条件 #2 まで波及させた。後段で「目標未達」判定にされる構造的リスクが解消された。
- **Step 0 (検証基準の Master エスカレーション) を着手前ステップとして独立化**: 旧版では Conductor 判断に暗黙に頼っていた合意手順が、明示的な Step 0 として可視化された。Implementer は「合意後に Step 1 へ進む」というガード条件を明確に把握できる。
- **Step 2-A-Pre の追加（mock hoisting 検証 1 ケース）**: 「`cmdTokenList` の 0 件案内 → `cmdTokenAdd` の manual 経路成功」という 2 段階の素振りで readline mock が効くことを早期検証する手順が、§6 で「省略禁止」と強調されている。13 件全実装後に「実は readline mock が効いてなかった」と発覚する事故を構造的に防いでいる。
- **D 系列 11 件の補強 2 件選び直し**: 旧版の「12 文字 prefix 検証」（caller 責務で意味薄）から、`deleteToken` 部分状態冪等性 + `updateTokenAuth + getTokenByAuthHash` 往復確認の 2 件に差し替え。test の存在意義が明確になった。
- **`os.homedir()` 記述の全面書き直し**: 不正確な workaround を Implementer に渡すリスクを排除。「副作用回避優先時は手動入力経路に統一する fallback」も併記され、Implementer に判断余地を残している。
- **新規 R9 / R10 / R11 の追加**: `credential_source` 文字列差異 / Keychain 削除タイミング / D 系列 dead code 化の 3 点が事前に洗い出され、それぞれ「文字列書き換え指示」「手動検証 #3 追加」「フォローアップタスク起票」として具体的対応に落ちている。
- **§6 の Implementer 向け二大書き換えポイント明示**: `credential_source` (R9) と `auth_hash` 長さ regex (R7) を「移植開始前に grep で全箇所を洗い出すこと」と指示。abort 版 test 移植時の事故を構造的に減らす。

## 残リスク・懸念

1. **推奨 15 件には未達**（軽微）  
   active 13 件は最低基準（12 件）を超えるが、推奨基準（15 件）には未達。§0 の「+ 任意の補強分」は具体候補が示されておらず、実装中に Implementer が判断する余地となる。Master が「推奨ライン到達」を強く要求する場合、追加 2 件の捻出箇所として候補は (a) `cmdTokenList` の plan_ratio 表示まわり、(b) `cmdTokenSetPlan` の plan_ratio 連動（旧 review §5 候補）、(c) `cmdTokenRotate` の `credential_source` 維持確認、あたりだが、本タスクの blocker ではない。

2. **Step 0 の合意プロセスが Conductor 進行管理に委譲**（軽微）  
   §0 末尾の「合意プロセス自体は Conductor の進行管理ロジックで担保」は具体的な合意フローが明文化されていない。Master が新基準を即時承認する想定だが、もし「12 件では不足」と返答された場合の分岐（plan 再改訂 / Option C 撤回検討 / abort）は plan 内に書かれていない。実運用上は Conductor が summary.md で報告 → Master 応答待ち → 合意で Step 1 進行、という流れで処理可能なため blocker ではない。

3. **フォローアップタスク 2 件の起票漏れリスク**（軽微）  
   §5 完了条件 #6 (`T319 D系列を cmdTokenRemove に配線`) と #7 (`T319 補償 tx 追加`) は本タスク完了後の起票となるため、Conductor / Master が summary.md レビュー時に起票を忘れると dead code / 補償 tx 不在のまま放置される。**summary.md 上で「フォローアップ起票指示」を必須項目として明示すれば**起票漏れを構造的に防げる（§5 #6 で指示している通り）。R3 / R11 が現実問題化する前に確実に拾えるよう Conductor は注意。

4. **§3 手動検証 #3 (remove → 即 add) の `Keychain test mode` 前提**（軽微）  
   `KEYCHAIN_TEST_MODE = "1"` での検証は in-memory mode を使うため、本物の macOS Keychain に対する remove → add の挙動は test 範囲外。本物 Keychain で `deleteTokenFromKeychain` が失敗 → handle 残存 → 次回 add 衝突、という R10 の最悪ケースは plan 範囲では検出できない。これは Option C の制約上やむを得ず、フォローアップ補償 tx タスク (§5 #7) で吸収する設計で妥当。

5. **`mock.module("readline", ...)` の hoisting が Bun のバージョンに依存しないか**（軽微）  
   §4 R5 / Step 2-A-Pre で hoisting 検証を行う設計は適切だが、Bun のバージョンアップで hoisting 挙動が変わった場合の影響は plan 内に予防策がない。Step 2-A-Pre が失敗した場合の fallback として「DI 化」「HOME + tty 別経路」が言及されているが、いずれも Option C 抵触の可能性がある（DI 化は token-cli.ts の signature 変更）。Master / Conductor 判断要請、と plan は明記しているため、運用上の対応路線としては許容範囲。
