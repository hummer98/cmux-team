# Implementation Notes — T394: shift+R/G/Q → ctrl+R/G/Q

## 変更ファイル / 行

### `skills/cmux-team/manager/dashboard.tsx`

キーバインド本体（trie 登録キー）:

| line | 修正前 | 修正後 |
|---|---|---|
| 1745 | `"shift+r": (ctx) => {` | `"ctrl+r": (ctx) => {` |
| 1846 | `"shift+g": () => app.update((s) => {` | `"ctrl+g": () => app.update((s) => {` |
| 1881 | `"shift+q": (ctx) => {` | `"ctrl+q": (ctx) => {` |

ヘルプ表記（footer の `ui.kbd(...)`）:

| line | focus / tab | 修正前 | 修正後 |
|---|---|---|---|
| 1548 | journal | `ui.kbd("g/G")` | `ui.kbd("g/Ctrl+G")` |
| 1556 | log | `ui.kbd("g/G")` | `ui.kbd("g/Ctrl+G")` |
| 1584 | issues | `ui.kbd("R")` | `ui.kbd("Ctrl+R")` |
| 1592 | metrics | `ui.kbd("g/G")` | `ui.kbd("g/Ctrl+G")` |
| 1609 | global | `ui.kbd("Q")` | `ui.kbd("Ctrl+Q")` |

### `CHANGELOG.md`

`[Unreleased]` セクションに `### Changed` を追加し、plan.md「5. CHANGELOG 記載案」の文言を追記。

## 検証結果

### `bun run tsc --noEmit`

- exit=0（型エラーなし）

### `bun test --timeout 30000` （dashboard 関連 4 ファイル）

| ファイル | 結果 |
|---|---|
| `dashboard-conductor.test.tsx` | 6 pass / 0 fail（17 expect） — exit=0 |
| `dashboard-issues.test.tsx` | 11 pass / 0 fail（27 expect） — exit=0 |
| `dashboard-metrics.test.tsx` | 30 pass / 0 fail（52 expect） — exit=0 |
| `dashboard-pool.test.tsx` | 2 pass / 0 fail（11 expect） — exit=0 |

合計 49 pass / 0 fail。

## 備考

- plan.md「2-B. 新規テスト」の方針通り新規ユニットテストは追加していない（trie 登録キーは文字列定数で tsc 型チェック対象、端末の制御バイト送出は実機でしか再現できないため）
- 手動検証（plan.md「4. 検証手順」の golden path / edge）は実装フェーズ外。Conductor / レビュー側で実機確認が必要
- ヘルプ表記の幅（plan.md 3-E）も実機確認待ち。`g/Ctrl+G` で 7 文字、`Ctrl+R` / `Ctrl+Q` で 6 文字。狭幅 cmux pane で折り返し検証が必要
- commit / push は plan の制約通り行っていない（Conductor が完了処理で実施）
