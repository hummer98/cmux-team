# T289 Plan — Issues タブのカーソル追従スクロール修正

## 1. 現状分析

対象: `skills/cmux-team/manager/dashboard.tsx`

### 定数ブロック（L44-48）

```ts
const LOG_VISIBLE_LINES = 30;
const TASK_VISIBLE_LINES = 5;
const JOURNAL_VISIBLE_LINES = 30;
const ARTIFACT_VISIBLE_LINES = 12;
const SETTINGS_PREVIEW_LINES = 20;
```

Issues タブ用定数が無い。

### `buildArtifactRows`（L827-893）— 参照実装

window 計算 L845-857:

```ts
let artifactStartIdx = 0;
if (filtered.length > ARTIFACT_VISIBLE_LINES) {
  artifactStartIdx = Math.max(
    0,
    Math.min(
      state.artifactCursor - ARTIFACT_VISIBLE_LINES + 1,
      filtered.length - ARTIFACT_VISIBLE_LINES,
    ),
  );
  if (state.artifactCursor < artifactStartIdx) artifactStartIdx = state.artifactCursor;
}
const visibleArtifacts = filtered.slice(artifactStartIdx, artifactStartIdx + ARTIFACT_VISIBLE_LINES);
```

描画ループ（L859-876）は `visibleArtifacts` を回し、`globalIdx = artifactStartIdx + i` で選択判定。

### `buildIssueRows`（L902-950）— 現状

- L910-920: `last sync` / `syncing` indicator 行（window 外、変更不要）
- L922-942: 本体ループが `state.issueItems` **全件**を単純描画（window 計算欠落）
  - L925 `for (let i = 0; i < state.issueItems.length; i++)`
  - L927 `const isSelected = i === state.issueCursor;`
- L944-947: `issueLastError` 行（window 外、変更不要）

artifacts との差分: (a) 可視行数定数の欠落、(b) start index 計算の欠落、(c) slice せず全件描画、(d) `isSelected` が `globalIdx` でなく生 `i`。

### 既存テスト

`skills/cmux-team/manager/dashboard-issues.test.tsx` 8 件（非 git / 認証なし / 空 / last sync / syncing / 通常レンダリング / カーソル強調 / エラー行）。`makeState` / `makeIssue` / `stringifyRows` ヘルパあり。再利用する。

## 2. 変更対象ファイル

- `skills/cmux-team/manager/dashboard.tsx` — 定数 1 行追加 + `buildIssueRows` ループ置換
- `skills/cmux-team/manager/dashboard-issues.test.tsx` — describe 末尾に 3 件追加

## 3. 具体的な差分

### 3.1 定数追加（L44-48）

**before** は §1 の通り。**after** は `ARTIFACT_VISIBLE_LINES` の直後に 1 行挿入:

```ts
const ARTIFACT_VISIBLE_LINES = 12;
const ISSUE_VISIBLE_LINES = 20;   // ← 追加
const SETTINGS_PREVIEW_LINES = 20;
```

### 3.2 `buildIssueRows` ループ置換（L922-942）

`last sync` / error 行には触らず、`else` ブロックのみ書き換える。

**before（L924-942）:**

```ts
} else {
  for (let i = 0; i < state.issueItems.length; i++) {
    const item = state.issueItems[i]!;
    const isSelected = i === state.issueCursor;
    // ... parts 構築・rows.push ...
  }
}
```

**after:**

```ts
} else {
  // カーソル追従スクロール（buildArtifactRows L845-857 と同じ式）
  let issueStartIdx = 0;
  if (state.issueItems.length > ISSUE_VISIBLE_LINES) {
    issueStartIdx = Math.max(
      0,
      Math.min(
        state.issueCursor - ISSUE_VISIBLE_LINES + 1,
        state.issueItems.length - ISSUE_VISIBLE_LINES,
      ),
    );
    if (state.issueCursor < issueStartIdx) issueStartIdx = state.issueCursor;
  }
  const visibleIssues = state.issueItems.slice(issueStartIdx, issueStartIdx + ISSUE_VISIBLE_LINES);

  for (let i = 0; i < visibleIssues.length; i++) {
    const item = visibleIssues[i]!;
    const globalIdx = issueStartIdx + i;
    const isSelected = globalIdx === state.issueCursor;
    // parts 構築は既存と同じ（displayState / typePrefix / labels）
    // rows.push(ui.row({ gap: 1 }, parts));
  }
}
```

parts 構築（ui.text × 6）は既存そのまま流用。変更点は宣言順で (i) `issueStartIdx` 計算ブロック追加、(ii) `state.issueItems` → `visibleIssues`、(iii) `globalIdx` 追加、(iv) `isSelected` が `globalIdx === state.issueCursor` になる、の 4 点のみ。

## 4. テストケース設計

`dashboard-issues.test.tsx` の `describe("buildIssueRows", ...)` 末尾に追加。実装定数と同期するためテスト側に `const VISIBLE = 20;` を置く（export しない）。

### T1: カーソル末尾近く → 選択行が描画に含まれる

```ts
test("issueItems.length > VISIBLE + カーソル末尾 → 選択行が含まれる", () => {
  const VISIBLE = 20;
  const total = VISIBLE + 10; // 30
  const items: IssueListItem[] = Array.from({ length: total }, (_, i) => ({
    issue: makeIssue({ number: i + 1, title: `issue-${i + 1}` }),
    labels: [], assignees: [],
  }));
  const rows = buildIssueRows(makeState({ issueItems: items, issueCursor: total - 1 }));
  const s = stringifyRows(rows);
  expect(s).toContain(`#${total}`);   // 選択行 #30 が含まれる
  expect(s).not.toContain("#1");       // 先頭は window 外
  expect(rows.length).toBeLessThanOrEqual(VISIBLE);
});
```

### T2: カーソル上端 → 先頭が見える

```ts
test("カーソル 0 → 先頭アイテムが描画される", () => {
  const VISIBLE = 20;
  const total = VISIBLE + 10;
  const items: IssueListItem[] = Array.from({ length: total }, (_, i) => ({
    issue: makeIssue({ number: i + 1, title: `issue-${i + 1}` }),
    labels: [], assignees: [],
  }));
  const rows = buildIssueRows(makeState({ issueItems: items, issueCursor: 0 }));
  const s = stringifyRows(rows);
  expect(s).toContain("#1");
  expect(s).toContain(`#${VISIBLE}`);  // 先頭 20 件
  expect(s).not.toContain(`#${total}`); // 末尾は window 外
});
```

### T3: アイテム数 < VISIBLE → 全件描画（従来動作維持）

```ts
test("issueItems.length <= VISIBLE → 全件描画", () => {
  const items: IssueListItem[] = Array.from({ length: 3 }, (_, i) => ({
    issue: makeIssue({ number: i + 1, title: `issue-${i + 1}` }),
    labels: [], assignees: [],
  }));
  const rows = buildIssueRows(makeState({ issueItems: items, issueCursor: 2 }));
  expect(rows.length).toBe(3); // last sync / error なし
  const s = stringifyRows(rows);
  expect(s).toContain("#1");
  expect(s).toContain("#3");
});
```

既存 8 件はいずれも `issueItems.length <= 2` のため window 置換後も同一挙動のまま通る。

## 5. 動作確認手順

1. ユニットテスト:
   ```bash
   cd skills/cmux-team/manager && bun test dashboard-issues.test.tsx
   ```
   追加 3 件 + 既存 8 件 すべて PASS を確認。
2. 全体回帰: `cd skills/cmux-team/manager && bun test`
3. 型チェック: `cd skills/cmux-team/manager && bunx tsc --noEmit`
4. 手動確認（任意、TUI 起動可能な環境のみ）: `cmux-team status` で Issues タブ（5）を開き、`j` で 21 件目以降までカーソルを送ってカーソル追従スクロールを確認、`k` で先頭復帰。

## 6. スコープ外

- キーバインド処理 / `switchTab` / `loadIssuesFromCache` は触らない
- `ISSUE_VISIBLE_LINES` 以外の可視行数定数（ARTIFACT / TASK / JOURNAL / LOG）は変更しない
- Issues タブの並び順・フィルタ・検索・プレビュー行等の新機能は追加しない
- i18n 文字列（`gh_tui_*`）の新規追加はしない
