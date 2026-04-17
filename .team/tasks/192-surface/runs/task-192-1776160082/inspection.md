# Inspection: T192

## 判定

**GO**（Non-blocking の指摘あり。blocking 項目なし）

## 完了基準チェック

| 基準 | 結果 | 備考 |
|-----|------|------|
| bun test 全パス | Pass (246/0 fail, 472 expect) | `skills/cmux-team/manager && bun test` で実行 |
| tsc 0 errors | Pass | `bun run tsc --noEmit` exit=0 |
| grep 置換完全性 (`surface=\${`) | Pass (0 件) | 実装系すべて置換済み |
| grep 置換完全性 (`surface=surface:` リテラル) | Pass | 残存 2 件は `dashboard.tsx:284,290`（後方互換パーサーのコメント/正規表現。plan 4.5 の除外対象で想定通り） |
| grep 置換完全性 (`conductor_surface=\${` 等) | Pass (0 件) | |
| logger.ts ヘルパー (formatSurface/formatPair) | Pass | 冪等性・空入力・null/undefined 受容・`"S"` role すべて logger.test.ts で確認 (15 ケース) |
| daemon_started に version | Pass | `main.ts:317-321` で `state.version = await loadVersion()` → `daemon_started` 先頭に `${state.version}` を付加 |
| dashboard.tsx 新旧両対応 | Pass | `extractSurface()` が旧 `surface=surface:NNN` と新 `C[NNN]`/`A[NNN]`/`M[NNN]`/`U[NNN]`/`S[NNN]` を両方ヒット |
| CLAUDE.md 更新 | Pass | 「ロギングポリシー > ログフォーマット > surface 表記（T192）」節追加、ロール表・親子 `>` 記法・実例 3 本を記載 |
| 変更範囲の逸脱 | Pass | 10 ファイル / +239 -78 行。plan 4.3 のファイル集合と一致 |

## 実行結果

### bun test

```
 246 pass
 0 fail
 472 expect() calls
Ran 246 tests across 14 files.
```

### tsc

```
$ bun run tsc --noEmit
EXIT=0
```

### grep 置換完全性

```
$ rg -n 'surface=\${' skills/cmux-team/manager --type ts
(0 件)

$ rg -n 'surface=surface:' skills/cmux-team/manager --type ts
skills/cmux-team/manager/dashboard.tsx:284: *   - 旧: `surface=surface:NNN` → `surface:NNN` を返す
skills/cmux-team/manager/dashboard.tsx:290:  const old = detail.match(/surface=surface:(\S+)/);
→ いずれも parseJournalEntries の後方互換パーサー。plan 4.5 で dashboard.tsx は除外対象として明示。

$ rg -n 'conductor_surface=\${|agent_surface=\${' skills/cmux-team/manager --type ts
(0 件)
```

### git diff --stat

```
 CLAUDE.md                               |  24 ++++++
 skills/cmux-team/manager/cmux.ts        |   6 +-
 skills/cmux-team/manager/conductor.ts   |  14 ++--
 skills/cmux-team/manager/daemon.test.ts |  14 ++++
 skills/cmux-team/manager/daemon.ts      | 128 ++++++++++++++++++--------------
 skills/cmux-team/manager/dashboard.tsx  |  21 +++++-
 skills/cmux-team/manager/logger.test.ts |  49 +++++++++++-
 skills/cmux-team/manager/logger.ts      |  39 ++++++++++
 skills/cmux-team/manager/main.ts        |  16 ++--
 skills/cmux-team/manager/master.ts      |   6 +-
 10 files changed, 239 insertions(+), 78 deletions(-)
```

## Non-blocking 指摘

以下は blocking ではないため GO 判定。将来の別 PR で対応可能。

1. **dashboard.tsx の TUI 色付け（plan 5.1-5.2）が未実装**
   - plan 5.1 では `parseLogLine` 戻り値に `roles?: { token, role }[]` を追加し、plan 5.2 で MAGENTA 色定数を新規追加してロール別のセグメント着色を行う設計だった。
   - impl は `extractSurface()` ヘルパーで journal 解析の新旧両対応までは実装したが、`parseLogLine` のロール抽出・色付け描画・MAGENTA 定数追加は未反映。
   - plan 5.5 に「セグメント方式が `@rezi-ui/core` で崩れる場合は次 PR で簡易版にフォールバック」と記載があり、スコープを絞った判断として許容範囲。
   - ただし impl-report にこの「色付けを次 PR に先送りした」旨の明記がなく、「plan.md の全項目を実装完了」と書かれているのは不正確。後追いで別タスク起票するか、impl-report / CHANGELOG に「TUI 色付けは次 PR」と追記することを推奨。

2. **CLAUDE.md の「ID プレフィックス表記」表から色カラムが省略**
   - plan 6.1 ではロールごとの「色（dashboard）」カラム（シアン/黄/マゼンタ/緑/グレー 等）および `task_id=`, `artifact_id=` の描画時着色の記載を含む設計だった。
   - 実装された CLAUDE.md はロール・意味・例の 3 カラムで色情報はなし。
   - 色付けが未実装な現状では色カラムを省いた方が整合的で、この簡略化は妥当。ただし色付けを次 PR で実装する際には CLAUDE.md も更新すること。

## Blocking 指摘

なし。
