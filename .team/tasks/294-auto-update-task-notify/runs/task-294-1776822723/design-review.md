# T294 Design Review

## 判定: Approved

（Changes Requested に倒すほどの致命的な見落とし・誤削除・TDD 破綻はない。ただし Recommendations に挙げた 5 点は implementer 着手前に plan へ取り込むか、implementer 判断の余地として明示しておくことを推奨する）

## 総評

- タスク指示の 6 項目（enum 縮約 / 自動起票削除 / `self-update` 削除 / notify モードのバナー / `kind: cmux-team-update` 特別扱い削除 / ドキュメント更新）が全て計画に載っており、各対象ファイルに対して具体的な line number + 差し替え内容まで降りている。完全性は高い。
- 特に §1.1「現状把握」のダイジェストは実際のソース（schema.ts L378、daemon.ts L78/L335/L3455/L3504/L3589、main.ts L463-470/L534/L573/L994-998/L1018/L4159/L4710、dashboard.tsx L344-350/L1272-1289、main.test.ts L284-399、daemon.test.ts L1316-1432、i18n.ts L689/L1416）とほぼ完全に一致しており、**誤った削除対象の記載はない**ことを Read で確認した。
- §3.1 の TDD 戦略は「RED を踏んでから実装へ」という順序が守れており、削除すべきテストと追加すべきテスト（破壊的変更の reject ケース）が明確に列挙されている。
- 破壊的変更の移行ガイド（§2.4 / §2.5 / §4.1）と CHANGELOG v4.5.0 の記述（§5）も揃っており、既存ユーザーの config / env / shell profile に値が残っているケースへの対応が想定されている。
- 計画スコープはタスク範囲内に収まっており、「ついで」のリファクタリングは混入していない（§6「スコープ外」で update-notifier 上げ・kind 完全削除・rename 案を明示的に除外）。

## 良い点

- Read で確認した実コードに対して line number の一致率が高く、実装時に「書いたら消える行が違った」事故が起こりにくい。
- `fetchLatestVersion` / `readCurrentVersion` / `updateNotifier` / `NO_UPDATE_NOTIFIER` / `update-notifier` パッケージといった **notify モードで残すべき依存** が §2.1 の表 + §4.3 / §4.4 で明示されており、「ついで削除」を防いでいる。
- `createTaskProgrammatic(opts.kind)` および `TaskFile.kind` 読み取りを **残す** 判断（§2.1 / §4.5）は、アーカイブ内の旧 `kind: cmux-team-update` を壊さないために適切。
- dashboard banner の文言統一（§2.2 / §3.3 の diff）で `ua.latest` を直接コマンドに埋める方針は、self-update 廃止後の手動更新導線として実用的。
- docs/spec/06-implementation-tasks.md の T187 記述を「削除」ではなく「補足を 1 行追加」する方針（§3.2 step 10）は、歴史性を保つ選択として妥当。
- §4.1 で **他プロジェクト（mado, Dear 等）の .team/config.json** に `"task"` / `true` が残っていないかを ready 化前に `rg '"autoUpdate"' ~/git` で確認するチェックリストを用意している点は、破壊的変更の実務的な配慮として評価できる。
- §7 セルフレビューチェックリストが 16 項目まで具体的に降りており、implementer が完了判定の根拠にできる。

## Recommendations

### A. 完全性

- [ ] **R-A1: `DaemonState.updateAvailable.createdTaskId` フィールドの扱いを明示する**
  - 現状: `daemon.ts` L71-76 で `updateAvailable: { current, latest, detectedAt, createdTaskId?: string | null }` が定義され、L3487 で `createdTaskId: null` 初期化、L3529 / L3574 で `createUpdateTask` が設定している。
  - `createUpdateTask` 削除後、この 2 箇所の書き込みは消滅するため **`createdTaskId` は死にフィールドになる**。plan は §2.1 の表で banner 側の `createdTaskId` 参照削除は列挙しているが、**型定義側（daemon.ts L75）および初期化（L3487）の除去**については明示がない。
  - 対応案: plan §3.2 step 4 に「`updateAvailable` 型から `createdTaskId` を削除、L3487 の `createdTaskId: null` も削除」を追記する。残してもバグにはならないが、dead field は後続タスクの混乱源になる。

### B. 正確性

- [ ] **R-B1: `main.test.ts` L335-338 / L340-343 / L345-348 の維持対象を plan に明示する**
  - plan §3.1「削除するテスト」リストには L335 以降のケース（`env 未設定 + config="notify" → notify`、`env 未設定 + config 未設定 → off`、`不正な env 値は throw`）が登場せず、「書き換え」「削除」「維持」のどれに分類されるか曖昧。いずれも T294 後も有効なテストなので **維持** だが、implementer が全部書き直す際のノイズになる可能性がある。
  - 対応案: §3.1 に「以下は現状維持: L335-338 / L340-343 / L345-348 / L350-353」を 1 行追加。

- [ ] **R-B2: `daemon.test.ts` L1316 の describe ブロック名変更**
  - 現状 `describe("checkUpdateAndNotify / createUpdateTask (T187)")`。`createUpdateTask` が消えるため、describe タイトルから `/ createUpdateTask` を外すべき。`(T187)` も `(T187/T294)` に更新するのが自然（T187 で追加、T294 で縮約した経緯）。
  - plan §3.1 では子テストの差し替えは具体的だが、親 describe の rename 指示が抜けている。

### C. TDD 順序

- [ ] **R-C1: 破壊的変更の起動時 exit 1 検証を plan に残すか明示する**
  - plan §3.1 末尾で「`resolveAutoUpdateMode` が throw することで代替」と結論している。これは正当だが、**ユーザー影響面としての「v4.5.0 初回起動で exit 1 + 移行メッセージが出る」経路のスモーク検証** は §3.2 step 12 の手動検証で担保される予定である旨を明示しておくと安心。
  - 対応案: §3.1 末尾に「CLI exit 検証は step 12 の手動検証で行い、単体テストでは throw のみを検証する（責務分離）」と 1 行追記。

### D. リスク分析

- [ ] **R-D1: banner 文言の改行／幅の実害確認**
  - plan の推奨 `(run: npm install -g @hummer98/cmux-team@X.Y.Z)` は現状の `(run: cmux-team self-update)` より **大幅に長くなる**（約 23 字 → 約 50 字）。
  - dashboard.tsx のヘッダは単一行描画。狭い端末や 16x9 レイアウトで折り返し／切り詰めが起きる可能性がある。実害はないが、plan §2.2 で「文言は latest を含むワンライナーに固定」としている以上、**16x9 レイアウトの標準幅で 1 行に収まるか（もしくは truncate 方針で OK か）を implementer が実端末で目視確認する旨** を §3.2 step 12 の手動検証項目として追加することを推奨する。
  - 代替案: `(upgrade: npm i -g ...)` など短縮形の検討も選択肢として plan に残す。

### E. ドキュメント

- [ ] **R-E1: docs/spec/06-implementation-tasks.md に T294 の独立エントリを追加するか判断を明示する**
  - 他の T-xxx（T213, T242, T253, T263, T264, T266, T269, T275, T283, T284 など）は固有の見出しまたは段落を持つ形式で記載されている。plan §3.2 step 10 は「T187 行に補足 1 行」方針を取るが、**T294 自体の独立エントリが無い** まま済ませるかどうかは判断が分かれる。
  - 対応案: plan に「T294 の独立エントリを Phase NN に追加 or T187 行に補足のみ」のどちらを取るかを明記する（どちらでもよいが implementer が迷う）。

### F. 過不足

（重大な過不足なし。§6 のスコープ外リストが妥当に機能している）

## 参考（コードの Read 結果サマリー）

実際のソースと plan 記述の突合せ（主要部のみ）:

| 対象 | plan 記述 | 実コード | 一致 |
|---|---|---|---|
| schema.ts `AutoUpdateMode` | L376〜396, `z.enum(["off","notify","task"])` | L378 `z.enum(["off","notify","task"])` | ✓ |
| schema.ts `normalizeAutoUpdate` | boolean → task/off、`task` 受理 | L387-396 同左 | ✓ |
| config.ts `TeamConfig.autoUpdate` | `boolean \| AutoUpdateMode` | L31 同左 | ✓ |
| config.ts `resolveAutoUpdateMode` | env > config > "off" | L80-99 同左 | ✓ |
| daemon.ts `DaemonState.updateMode` | L78 | L78 `"off" \| "notify" \| "task"` | ✓ |
| daemon.ts `createDaemon` 初期化 | L333-335 `updateMode: "off"` | L334-335 同左 | ✓ |
| daemon.ts `checkUpdateAndNotify` | L3455-3495 | L3455-3495 同左、L3492 に `if (mode === "task")` 分岐あり | ✓ |
| daemon.ts `createUpdateTask` | L3504-3587 | L3504 `export async function createUpdateTask` | ✓ |
| daemon.ts `buildUpdateTaskBody` | L3589-3614 | L3589 `function buildUpdateTaskBody` | ✓ |
| daemon.ts `updateAvailable.createdTaskId` | plan §2.1 banner 側のみ言及 | **L75 で型定義、L3487 で初期化、L3529/L3574 で書き込み** | △ 型定義側が plan に欠落 |
| main.ts `cmdSelfUpdate` | L4158-4237 | L4159 `async function cmdSelfUpdate` | ✓ |
| main.ts switch `"self-update"` | L4710-4711 | L4710-4711 同左 | ✓ |
| dashboard.tsx autoUpdate 行 | L344-350 | L346-349 同左 (`typeof cfg.autoUpdate === "boolean"` 分岐含む) | ✓ |
| dashboard.tsx update banner | L1272-1289 | L1272-1289 同左 | ✓ |
| i18n.ts ヘルプ | L689 / L1416 | 同左 | ✓ |
| main.test.ts `resolveAutoUpdateMode` | L284-354 | L284-354（12 ケース） | ✓ |
| main.test.ts `normalizeAutoUpdate` | L356-399 | L356-398（10 ケース） | ✓ |
| daemon.test.ts `checkUpdateAndNotify / createUpdateTask` | L1316-1432 | L1316 describe 開始、L1408 に `kind: cmux-team-update` | ✓ |
| templates/ja/master.md | L201 「cmux-team 自身の更新」| L201 同左 | ✓ |
| templates/en/master.md | L201 「cmux-team self-update」 | L201 同左 | ✓ |
| CLAUDE.md | L741-743 / L907-933 | 該当記述あり | ✓ |
| README.md / README.ja.md | L38-60 / L131 | 該当記述あり | ✓ |
| docs/spec/01, 05, 06 | L90 / L140+L416-428 / L310 | 該当記述あり | ✓ |

**結論**: plan の現状把握は 1 箇所（`updateAvailable.createdTaskId` 型定義側の削除）を除き、実コードと正確に一致している。その 1 点も R-A1 として軽微な追記で解決可能なので、全体として Approved で差し支えない。
