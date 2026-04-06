# plan.md — Journal/Log の表示順を最新が一番上に変更し自動スクロール挙動を改善

対象ファイル: `skills/cmux-team/manager/dashboard.tsx`

---

## 1. 現状分析

### データフロー

- `readLogLines()` (L243): `.team/logs/manager.log` を読み込み、行の配列を返す。**古い順（先頭=最古、末尾=最新）**
- `parseJournalEntries()` (L205): ログ行から `task_received`, `conductor_started`, `task_completed`, `task_aborted` イベントを抽出し `JournalEntry[]` を返す。順序はログファイルと同じ**古い順**

### 表示関数

- `buildJournalRows()` (L523): `JournalEntry[]` をそのまま順に `ui.row` に変換。並べ替えは行わない
- `buildLogRows()` (L634): `string[]` をそのまま順に `ui.row` に変換。並べ替えは行わない

### スクロールオフセットの現在のセマンティクス

```
AppState:
  logScrollOffset: number    // 0 = 最下部（最新）、正の数 = 上にスクロールした行数 (L269)
  logAutoScroll: boolean     // true = 最新に自動追従 (L270)
  journalScrollOffset: number // 0 = 最下部（最新）、正の数 = 上にスクロールした行数 (L273)
  // ※ journalAutoScroll は存在しない
```

### スライスロジック（Journal, L829-836）

```tsx
const total = state.journalEntries.length;
let endIdx = total - state.journalScrollOffset;      // offset=0 → endIdx=total（末尾）
if (endIdx < JOURNAL_VISIBLE_LINES) endIdx = Math.min(total, JOURNAL_VISIBLE_LINES);
const startIdx = Math.max(0, endIdx - JOURNAL_VISIBLE_LINES);
return buildJournalRows(state.journalEntries.slice(startIdx, endIdx), repoUrl);
```

Log (L839-845) も同一ロジック。

**動作**: offset=0 で配列の末尾（最新）を表示。offset を増やすと古い方にスクロール。

### キーハンドラ（L898-936）

| キー | Journal | Log |
|------|---------|-----|
| Up | offset++ (古い方へ) | offset++ (古い方へ), autoScroll=false |
| Down | offset-- (新しい方へ) | offset-- (新しい方へ), autoScroll=(offset===0) |
| g | — | offset=max (最古へ), autoScroll=false |
| G | — | offset=0 (最新へ), autoScroll=true |

### 自動スクロール（refresh 内, L1040）

```tsx
logScrollOffset: s.logAutoScroll ? 0 : s.logScrollOffset,
```

- `logAutoScroll=true` のとき offset を 0（最新）にリセット
- Journal には auto-scroll ロジックが**存在しない**

---

## 2. 変更計画

### 2a. AppState の変更

**L273 付近に追加:**

```tsx
journalAutoScroll: boolean;  // true = 最新に自動追従
```

**L269-273 のコメントを更新:**

```tsx
logScrollOffset: number;      // 0 = 先頭（最新）、正の数 = 下にスクロールした行数
logAutoScroll: boolean;       // true = 最新に自動追従
journalScrollOffset: number;  // 0 = 先頭（最新）、正の数 = 下にスクロールした行数
journalAutoScroll: boolean;   // true = 最新に自動追従
```

**initialState (L726-729) に追加:**

```tsx
journalAutoScroll: true,
```

### 2b. スライスロジックの変更（ビュー構築）

**方針**: データを reverse して先頭からスライスする。offset=0 が先頭（最新）を意味するよう変更。

**Journal (L829-836) → 置き換え:**

```tsx
const reversed = [...state.journalEntries].reverse();
const total = reversed.length;
const startIdx = Math.min(state.journalScrollOffset, Math.max(0, total - JOURNAL_VISIBLE_LINES));
const endIdx = Math.min(startIdx + JOURNAL_VISIBLE_LINES, total);
return buildJournalRows(reversed.slice(startIdx, endIdx), repoUrl);
```

**Log (L839-845) → 置き換え:**

```tsx
const reversed = [...state.logLines].reverse();
const total = reversed.length;
const startIdx = Math.min(state.logScrollOffset, Math.max(0, total - LOG_VISIBLE_LINES));
const endIdx = Math.min(startIdx + LOG_VISIBLE_LINES, total);
return buildLogRows(reversed.slice(startIdx, endIdx));
```

### 2c. キーハンドラの方向反転

逆順表示のため、Up/Down のオフセット操作を反転する。

**Up キー (L898-916):**

```tsx
// Journal: offset 減少（より新しい方へ＝画面上方向へ）
case "journal": {
  const newOffset = Math.max(s.journalScrollOffset - 1, 0);
  return { ...s, journalScrollOffset: newOffset, journalAutoScroll: newOffset === 0 };
}
// Log: offset 減少（より新しい方へ）
case "log": {
  const newOffset = Math.max(s.logScrollOffset - 1, 0);
  return { ...s, logScrollOffset: newOffset, logAutoScroll: newOffset === 0 };
}
```

**Down キー (L917-936):**

```tsx
// Journal: offset 増加（より古い方へ＝画面下方向へ）
case "journal": {
  const maxOffset = Math.max(0, s.journalEntries.length - JOURNAL_VISIBLE_LINES);
  return { ...s, journalScrollOffset: Math.min(s.journalScrollOffset + 1, maxOffset), journalAutoScroll: false };
}
// Log: offset 増加（より古い方へ）
case "log": {
  const maxOffset = Math.max(0, s.logLines.length - LOG_VISIBLE_LINES);
  return { ...s, logScrollOffset: Math.min(s.logScrollOffset + 1, maxOffset), logAutoScroll: false };
}
```

### 2d. g/G キーの方向反転

**g キー (L976-982): 先頭（最新）へ → offset=0**

```tsx
g: () => app.update((s) => {
  if (s.focusedArea === "log") {
    return { ...s, logScrollOffset: 0, logAutoScroll: true };
  }
  if (s.focusedArea === "journal") {
    return { ...s, journalScrollOffset: 0, journalAutoScroll: true };
  }
  return s;
}),
```

**G キー (L970-975): 末尾（最古）へ → offset=max**

```tsx
G: () => app.update((s) => {
  if (s.focusedArea === "log") {
    const maxOffset = Math.max(0, s.logLines.length - LOG_VISIBLE_LINES);
    return { ...s, logScrollOffset: maxOffset, logAutoScroll: false };
  }
  if (s.focusedArea === "journal") {
    const maxOffset = Math.max(0, s.journalEntries.length - JOURNAL_VISIBLE_LINES);
    return { ...s, journalScrollOffset: maxOffset, journalAutoScroll: false };
  }
  return s;
}),
```

### 2e. 自動スクロールの改善（refresh 内, L1032-1046）

```tsx
app.update((s) => {
  // フォーカス中は自動スクロールしない
  const journalAuto = s.journalAutoScroll && s.focusedArea !== "journal";
  const logAuto = s.logAutoScroll && s.focusedArea !== "log";

  // 自動スクロール OFF 時: 新エントリ分だけ offset を増加して位置を保持
  const journalDelta = journalEntries.length - s.journalEntries.length;
  const logDelta = lines.length - s.logLines.length;

  return {
    ...s,
    daemon: newDaemon,
    logLines: lines,
    journalEntries,
    repoUrl,
    artifacts,
    journalScrollOffset: journalAuto ? 0 : s.journalScrollOffset + Math.max(0, journalDelta),
    logScrollOffset: logAuto ? 0 : s.logScrollOffset + Math.max(0, logDelta),
    taskCursor: Math.min(s.taskCursor, Math.max(newDaemon.taskList.length - 1, 0)),
  };
});
```

**ポイント:**
- `focusedArea` が journal/log の場合、autoScroll が true でも追従しない（要件: カーソル表示中は自動スクロールしない）
- autoScroll OFF 時、新エントリ数分 offset を加算してスクロール位置を保持（逆順配列の先頭にエントリが追加されることで生じるズレを補正）

### 2f. ステータスバーのヘルプテキスト更新（L862-871）

Journal フォーカス時のヘルプに `g/G` を追加:

```tsx
: state.focusedArea === "journal"
? [
    ui.kbd("↑/↓"), ui.text("scroll"),
    ui.kbd("g/G"), ui.text("top/bottom"),
    ui.kbd("ESC"), ui.text("back"),
  ]
```

---

## 3. スクロールセマンティクスの再設計

### offset の意味の変更

| | 旧（古→新表示） | 新（新→古表示） |
|---|---|---|
| offset=0 | 末尾（最新）を表示 | **先頭（最新）を表示** |
| offset 増加 | 古い方にスクロール（上へ） | **古い方にスクロール（下へ）** |
| autoScroll=true | offset=0 を維持 → 末尾追従 | offset=0 を維持 → **先頭追従** |

### スライス方式

- **旧**: `entries.slice(total-offset-VISIBLE, total-offset)` — 末尾基準
- **新**: `entries.reverse().slice(offset, offset+VISIBLE)` — 先頭基準（reverse 後）

### 位置保持の仕組み

逆順配列では新エントリが先頭に追加されるため、offset > 0 のとき全インデックスがずれる。refresh 時に `新エントリ数 = newEntries.length - oldEntries.length` を計算し、offset に加算することで同じエントリを表示し続ける。

---

## 4. リスク分析

### 4a. キー操作の直感性

**リスク**: Up/Down の動作方向が逆転する
**評価**: 低リスク。「最新が上」のリスト表示では、Down で古い方に進むのが自然。Slack、Discord 等多くの UI と同じ挙動。

### 4b. g/G キーの Vim 慣例との不整合

**リスク**: Vim では `g` = 先頭、`G` = 末尾。旧実装は「g=最古（先頭）、G=最新（末尾）」で Vim 慣例通りだったが、新実装では「g=最新（先頭）、G=最古（末尾）」になる。
**評価**: 低リスク。逆順表示により先頭が最新になったため、g=先頭=最新は Vim 慣例と一致。意味的にも正しい。

### 4c. パフォーマンス

**リスク**: 毎レンダーで `[...array].reverse()` を実行
**評価**: 無視可能。Journal エントリは数十〜数百件、Log は数千行程度。reverse() のコストは O(n) で十分高速。

### 4d. オフセット補正の精度

**リスク**: `Math.max(0, delta)` でエントリが減少した場合（ログローテーション等）のオフセット異常
**評価**: 低リスク。ログは追記のみで減少しない。万一の場合でも offset が過大になるだけで、max チェックにより自動的にクランプされる。

### 4e. 副作用のあるエリア

- `buildJournalRows()` / `buildLogRows()`: 変更不要。渡されたデータを順に表示するだけ
- `parseJournalEntries()` / `readLogLines()`: 変更不要。データ取得層は表示順に依存しない
- Artifacts タブ: 影響なし（独自のスクロール管理）
- Tasks パネル: 影響なし（独自のカーソル管理）

---

## 5. テスト項目

### 5a. 表示順の検証

- [ ] Journal タブを開き、最新エントリが一番上に表示されていることを確認
- [ ] Log タブを開き、最新ログが一番上に表示されていることを確認
- [ ] タスクを実行してエントリが追加されたとき、一番上に新エントリが表示されること

### 5b. スクロール操作の検証

- [ ] Journal フォーカスで ↓ キー → 古いエントリが見えること
- [ ] Journal フォーカスで ↑ キー → 新しいエントリに戻ること
- [ ] Log フォーカスで ↓ キー → 古いログが見えること
- [ ] Log フォーカスで ↑ キー → 新しいログに戻ること
- [ ] Log フォーカスで g キー → 最新（先頭）にジャンプ
- [ ] Log フォーカスで G キー → 最古（末尾）にジャンプ
- [ ] Journal フォーカスで g/G キーが同様に動作すること

### 5c. 自動スクロールの検証

- [ ] offset=0（最新表示）の状態で新エントリ追加 → 自動的に最新を追従
- [ ] ↓ キーでスクロールした状態で新エントリ追加 → スクロール位置が保持されること（古い方にずれない）
- [ ] Journal/Log にフォーカスした状態で新エントリ追加 → 自動スクロールしないこと
- [ ] ESC でフォーカスを外し、再度フォーカスしたとき → 最新表示なら auto-scroll が有効

### 5d. エッジケースの検証

- [ ] エントリ 0 件のとき → "no journal entries" / "no log entries" 表示
- [ ] エントリが VISIBLE_LINES 未満のとき → 正常に全件表示
- [ ] エントリが VISIBLE_LINES ちょうどのとき → スクロール不要で全件表示
- [ ] Home/End キーの動作に影響がないこと（未定義のため変化なし）
