# T289 Inspection — Issues タブのカーソル追従スクロール修正

## 判定

**GO**

## 確認項目チェックリスト

| # | 項目 | 結果 | 備考 |
|---|------|------|------|
| 1 | スコープ遵守 | **PASS** | 期待ファイルのみ変更、禁止領域への侵入なし |
| 2 | 実装の正確性 | **PASS** | plan §3 の after パターンと一致 |
| 3 | テストの妥当性 | **PASS** | T1/T2/T3 を網羅、"#1" 誤マッチ回避の改善あり |
| 4 | テスト実行 | **PASS** | bun test 全件 PASS、tsc 新規エラー 0 件 |
| 5 | 動作確認（任意） | **SKIP** | ユニットテストで十分カバー（TUI 実環境なし） |

---

## 1. スコープ遵守

`git diff --stat`:

```
 package-lock.json                                  |  4 +-
 skills/cmux-team/manager/dashboard-issues.test.tsx | 49 ++++++++++++++++++++++
 skills/cmux-team/manager/dashboard.tsx             | 25 +++++++++--
 3 files changed, 73 insertions(+), 5 deletions(-)
```

- `dashboard.tsx`: 定数 1 行追加 + `buildIssueRows` の else ブロック置換のみ（キーバインド / `switchTab` / `loadIssuesFromCache` への変更なし）
- `dashboard-issues.test.tsx`: `describe("buildIssueRows", ...)` 末尾にテスト 3 件追加のみ
- `package-lock.json`: `"version": "4.2.0"` → `"4.3.0"` の 2 箇所のみ。main 側で `package.json` が 4.3.0 に bump 済みなのに lock が 4.2.0 のままという既存不整合を `npm install` が自動修正したものであり、plan §「許容されうる副次変更」に該当

禁止対象（他タブ用定数・関数変更 / 新機能追加 / i18n 追加 / キーバインド）への侵入なし。

## 2. 実装の正確性

### 2.1 定数追加（L48）

```ts
const ARTIFACT_VISIBLE_LINES = 12;
const ISSUE_VISIBLE_LINES = 20;        // ← 追加
const SETTINGS_PREVIEW_LINES = 20;
```

定数ブロック中、plan §3.1 の指定位置（`ARTIFACT_VISIBLE_LINES` 直後）に正確に配置。

### 2.2 `buildIssueRows` else ブロック置換

plan §3.2 の after パターンと一致。要点:

- `issueStartIdx` の計算式が `buildArtifactRows`（L845-857）と完全に等価:
  `Math.max(0, Math.min(state.issueCursor - ISSUE_VISIBLE_LINES + 1, state.issueItems.length - ISSUE_VISIBLE_LINES))`
- `if (state.issueCursor < issueStartIdx) issueStartIdx = state.issueCursor;` ガードも移植済み
- ループが `visibleIssues` を回し、`globalIdx = issueStartIdx + i` で `isSelected === state.issueCursor` 判定
- `last sync` / `syncing` / `issueLastError` 行は else ブロックの外に残り、ビューポート計算の影響を受けない（plan 意図通り）
- parts 構築（`displayState` / `typePrefix` / `labels`）は既存そのまま

## 3. テストの妥当性

plan §4 の T1/T2/T3 を網羅:

| テスト | 内容 | plan 対応 |
|-------|------|-----------|
| `issueItems.length > VISIBLE + カーソル末尾 → 選択行が含まれる` | total=30 / cursor=29、`#30` 含まれ先頭 `"#1"` は含まれず、`rows.length <= 20` | T1 ✓ |
| `カーソル 0 → 先頭アイテムが描画される` | total=30 / cursor=0、`"#1"` と `#20` が含まれ `#30` は含まれず | T2 ✓ |
| `issueItems.length <= VISIBLE → 全件描画` | total=3 / cursor=2、`rows.length===3`、`"#1"` と `"#3"` が含まれる | T3 ✓ |

**改善点**: plan 原案の `expect(s).not.toContain("#1")` は `#10`, `#11` 等に部分マッチしてしまうため、実装では `"#1"` (引用符付き) で完全一致判定に変更。`stringifyRows` が `title="..."` 形式で出力することを利用した妥当な改善。既存テスト 8 件（`issueItems.length <= 2` のケース）はウィンドウ置換後も同一挙動で通る。

## 4. テスト実行

### 4.1 `bun test dashboard-issues.test.tsx`

```
 11 pass
 0 fail
 27 expect() calls
Ran 11 tests across 1 file. [107.00ms]
```

既存 8 件 + 追加 3 件 すべて PASS。

### 4.2 `bun test`（全体回帰）

```
 970 pass
 0 fail
 2285 expect() calls
Ran 970 tests across 35 files. [45.28s]
```

退行 0 件。

### 4.3 `bunx tsc --noEmit`

T289 適用後の tsc エラー 3 件:

- `conductor.ts(201,3): error TS1016`
- `daemon.test.ts(3956,9): error TS2322`
- `daemon.ts(1597,22): error TS2352`

**baseline 検証**: `git stash` で T289 変更を退避した状態でも同じ 3 件が再現。T289 変更ファイル（`dashboard.tsx` / `dashboard-issues.test.tsx`）起因のエラーは 0 件。plan §4「既存エラーはあれば baseline として許容」に該当。

## 5. 動作確認結果

TUI 実環境での確認は skip。ユニットテスト T1 (cursor=29 → window=[10,29] に `#30` 含まれ `#1` 含まれず) で追従スクロールのコア挙動、T2 (cursor=0 → window=[0,19]) で先頭固定の挙動、T3 (total=3 → 全件) で小規模時の従来動作維持が機械的に検証されており、手動確認の付加価値は小さい。

## 検出した問題

なし。

## 備考

- `package-lock.json` の 4.2.0 → 4.3.0 差分は main 側 `package.json` との既存不整合の補正で、T289 の関心事ではない。コミット時に一緒に含めるかは Conductor の判断に委ねる（scope 的には切り離した方が clean だが、npm install の副作用として機械的に発生した差分であり問題視するほどではない）。
