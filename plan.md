# 実装計画: ダッシュボード QoL 改善

## 1. 変更概要

dashboard.tsx（1025行）に対し、以下4点の改善を行う:

1. **フォーカスシステム導入** — `focusedArea` 状態を追加し、各エリア（tasks/journal/log/artifacts）にフォーカスを当てた操作モードを実現
2. **各エリアのスクロール統一** — Journal にスクロール機構を追加、フォーカス時は Up/Down で各エリアをスクロール
3. **Tasks カーソル表示改善** — `"_ "` プレフィックスから `underline` スタイルへ変更
4. **フッター キーガイド** — フォーカス状態に応じた動的キーガイド表示

## 2. AppState の変更

**対象**: L253-270 `interface AppState`

### 追加フィールド

```typescript
focusedArea: "global" | "tasks" | "journal" | "log" | "artifacts";
journalScrollOffset: number;  // 0 = 最下部（最新）、正の数 = 上にスクロールした行数
```

### 初期値の設定箇所

`createNodeApp` 呼び出し時の初期 state オブジェクト（L670 付近の app 初期化）に追加:

- `focusedArea: "global"`
- `journalScrollOffset: 0`

### 定数追加

L22 `const TASK_VISIBLE_LINES = 5;` の隣に:

```typescript
const JOURNAL_VISIBLE_LINES = 30;
```

### 削除・変更

- L708 の `tasksFocused` ローカル変数は `state.focusedArea === "tasks"` に置き換え

## 3. キーバインドの再構成

**対象**: L842-949 `app.keys({...})`

### 現状 → 変更後の対照表

| キー | 現状の動作 (行番号) | 変更後 |
|------|-----------|--------|
| `Up` (L843-846) | taskCursor-- (常時) | focusedArea に応じて分岐 |
| `Down` (L847-850) | taskCursor++ (常時) | focusedArea に応じて分岐 |
| `1` (L851) | activeTab = journal | そのまま維持 |
| `2` (L852) | activeTab = artifacts | そのまま維持 |
| `3` (L853) | activeTab = log | そのまま維持 |
| `Tab` (L854-858) | タブ順回り | そのまま維持 |
| `Enter` (L860-879) | artifacts open | focusedArea === "artifacts" 時のみ |
| `j` (L880-889) | artifacts ↓ / log ↓ | **削除**（Up/Down に統合） |
| `k` (L891-899) | artifacts ↑ / log ↑ | **削除**（Up/Down に統合） |
| `G` (L901-905) | log bottom | focusedArea === "log" 時のみ |
| `g` (L907-912) | log top | focusedArea === "log" 時のみ |
| `s` (L914-918) | artifacts sort | focusedArea === "artifacts" 時のみ |
| `f` (L920-924) | artifacts filter | focusedArea === "artifacts" 時のみ |
| `r` (L926) | reload | focusedArea === "global" 時のみ |
| `q` (L927-929) | quit | focusedArea === "global" 時のみ |
| `Q` (L931-934) | full quit 確認 | focusedArea === "global" 時のみ |
| `Escape` (L945-948) | confirmingFullQuit 解除のみ | focusedArea → "global" **も**行う |

### 新規キーバインド（追加）

| キー | 動作 |
|------|------|
| `T` | `focusedArea = "tasks"` |
| `J` | `activeTab = "journal"`, `focusedArea = "journal"` |
| `L` | `activeTab = "log"`, `focusedArea = "log"` |
| `A` | `activeTab = "artifacts"`, `focusedArea = "artifacts"` |

### Up/Down の分岐ロジック（詳細）

```typescript
Up: () => app.update((s) => {
  switch (s.focusedArea) {
    case "tasks":
      return { ...s, taskCursor: Math.max(s.taskCursor - 1, 0) };
    case "journal": {
      const maxOffset = Math.max(0, s.journalEntries.length - JOURNAL_VISIBLE_LINES);
      return { ...s, journalScrollOffset: Math.min(s.journalScrollOffset + 1, maxOffset) };
    }
    case "log": {
      const maxOffset = Math.max(0, s.logLines.length - LOG_VISIBLE_LINES);
      return { ...s, logScrollOffset: Math.min(s.logScrollOffset + 1, maxOffset), logAutoScroll: false };
    }
    case "artifacts": {
      return { ...s, artifactCursor: Math.max(s.artifactCursor - 1, 0) };
    }
    default: // global — 何もしない
      return s;
  }
}),
Down: () => app.update((s) => {
  switch (s.focusedArea) {
    case "tasks":
      return { ...s, taskCursor: Math.min(s.taskCursor + 1, Math.max(s.daemon.taskList.length - 1, 0)) };
    case "journal": {
      const newOffset = Math.max(s.journalScrollOffset - 1, 0);
      return { ...s, journalScrollOffset: newOffset };
    }
    case "log": {
      const newOffset = Math.max(s.logScrollOffset - 1, 0);
      return { ...s, logScrollOffset: newOffset, logAutoScroll: newOffset === 0 };
    }
    case "artifacts": {
      const filtered = getFilteredArtifacts(s);
      return { ...s, artifactCursor: Math.min(s.artifactCursor + 1, filtered.length - 1) };
    }
    default:
      return s;
  }
}),
```

### Escape の変更

```typescript
Escape: () => {
  confirmingFullQuit = false;
  app.update((s) => ({ ...s, confirmingFullQuit: false, focusedArea: "global" }));
},
```

## 4. ビュー変更（Tasks カーソル、Journal スクロール、フッター）

### 4.1 Tasks カーソル表示

**対象**: L708-718

現状 (L708):
```typescript
const tasksFocused = state.activeTab === "journal";
```

変更後:
```typescript
const tasksFocused = state.focusedArea === "tasks";
```

現状 (L714-717):
```typescript
ui.text(tasksFocused && isSelected ? "_ " : "  ", tasksFocused && isSelected ? { bold: true } : {}),
buildTaskRow(task, assignedTaskIds.has(task.id), repoUrl),
```

変更後:
```typescript
buildTaskRow(task, assignedTaskIds.has(task.id), repoUrl,
  tasksFocused && isSelected ? { underline: true } : undefined),
```

**注**: `buildTaskRow` 関数（L400 付近）にオプショナルな `styleOverride` パラメータを追加し、行内の各 `ui.text` に適用する。rezi-ui の `underline` サポート確認が必要。未対応の場合は `{ bold: true, inverse: true }` で代替。

### 4.2 Journal スクロール

**対象**: L766-768

現状:
```typescript
state.activeTab === "journal"
  ? buildJournalRows([...state.journalEntries].reverse(), repoUrl)
```

変更後:
```typescript
state.activeTab === "journal"
  ? (() => {
      const reversed = [...state.journalEntries].reverse();
      const total = reversed.length;
      let endIdx = total - state.journalScrollOffset;
      if (endIdx < JOURNAL_VISIBLE_LINES) endIdx = Math.min(total, JOURNAL_VISIBLE_LINES);
      const startIdx = Math.max(0, endIdx - JOURNAL_VISIBLE_LINES);
      return buildJournalRows(reversed.slice(startIdx, endIdx), repoUrl);
    })()
```

Log (L771-777) と同じスクロール計算パターンを適用。`journalScrollOffset = 0` で最新エントリが表示される。

### 4.3 フッター キーガイド

**対象**: L780-834

5パターン + confirmingFullQuit に書き換え:

```typescript
footer: ui.statusBar({
  left: state.confirmingFullQuit
    ? [/* 既存の確認UI — L782-788 変更なし */]
    : state.focusedArea === "tasks"
    ? [
        ui.kbd("↑/↓"), ui.text("scroll"),
        ui.kbd("ESC"), ui.text("back"),
      ]
    : state.focusedArea === "journal"
    ? [
        ui.kbd("↑/↓"), ui.text("scroll"),
        ui.kbd("ESC"), ui.text("back"),
      ]
    : state.focusedArea === "log"
    ? [
        ui.kbd("↑/↓"), ui.text("scroll"),
        ui.kbd("g/G"), ui.text("top/bottom"),
        ui.kbd("ESC"), ui.text("back"),
      ]
    : state.focusedArea === "artifacts"
    ? [
        ui.kbd("↑/↓"), ui.text("select"),
        ui.kbd("Enter"), ui.text("open"),
        ui.kbd("s"), ui.text(`sort:${state.artifactSort}`),
        ui.kbd("f"), ui.text(state.artifactTypeFilter ? `type:${state.artifactTypeFilter}` : "filter"),
        ui.kbd("ESC"), ui.text("back"),
      ]
    : [ // global
        ui.kbd("T"), ui.text("tasks"),
        ui.kbd("J"), ui.text("journal"),
        ui.kbd("L"), ui.text("log"),
        ui.kbd("A"), ui.text("artifacts"),
        ui.kbd("r"), ui.text("reload"),
        ui.kbd("q"), ui.text("quit"),
        ui.kbd("Q"), ui.text("full quit"),
      ],
}),
```

## 5. 実装手順（ステップバイステップ）

### Step 1: AppState 拡張 (L22, L253-270, L670付近)

1. L22 に `const JOURNAL_VISIBLE_LINES = 30;` を追加
2. L253-270 の `interface AppState` に `focusedArea` と `journalScrollOffset` を追加
3. 初期 state に `focusedArea: "global"`, `journalScrollOffset: 0` を追加

### Step 2: キーバインド再構成 (L842-949)

1. `Up`/`Down` を `focusedArea` 分岐ロジックに変更 (L843-850)
2. `j`/`k` ハンドラを削除 (L880-899)
3. `T`, `J`, `L`, `A` キーハンドラを追加
4. `g`/`G` に `focusedArea === "log"` ガード追加 (L901-912)
5. `s`/`f`/`Enter` に `focusedArea === "artifacts"` ガード追加 (L860-924)
6. `r`/`q`/`Q` に `focusedArea === "global"` ガード追加 (L926-934)
7. `Escape` に `focusedArea: "global"` リセット追加 (L945-948)

### Step 3: Tasks カーソル表示 (L708-718)

1. `tasksFocused` を `state.focusedArea === "tasks"` に変更
2. `"_ "` プレフィックスを廃止し `underline` スタイル適用
3. `buildTaskRow` にスタイルオーバーライド引数を追加（必要に応じて）

### Step 4: Journal スクロール (L766-768)

1. Journal 表示を `journalScrollOffset` ベースのスクロールに変更
2. Log (L771-777) と同じスクロール計算パターンを適用

### Step 5: フッター更新 (L780-834)

1. `activeTab` ベースの3パターンを `focusedArea` ベースの5パターンに書き換え

### Step 6: refresh 整合性 (L962-971)

1. `taskCursor` のクランプは既存ロジック (L970) で対応済み
2. `journalScrollOffset` は auto-scroll 不要（イベント頻度が低いため）— 変更なし
3. `focusedArea` は refresh で変更しない

## 6. 注意事項・リスク

### rezi-ui の underline サポート

`{ underline: true }` が rezi-ui でサポートされているか実装時に確認が必要。

- **代替案 A**: `bold` + `> ` プレフィックスで選択表示
- **代替案 B**: 背景色反転 `{ inverse: true }`

### タスクスクロール境界バグ調査

L702-705 の既存スクロール計算:
```typescript
taskStartIdx = Math.max(0, Math.min(state.taskCursor - TASK_VISIBLE_LINES + 1, totalTasks - TASK_VISIBLE_LINES));
if (state.taskCursor < taskStartIdx) taskStartIdx = state.taskCursor;
```

検証結果:
- `taskCursor = 0`, `totalTasks = 10` → `taskStartIdx = max(0, min(-4, 5))` = 0 ✓
- `taskCursor = 9`, `totalTasks = 10` → `taskStartIdx = max(0, min(5, 5))` = 5, `visibleTasks = [5..9]` ✓
- `taskCursor = 3`, `totalTasks = 10` → `taskStartIdx = max(0, min(-1, 5))` = 0, `visibleTasks = [0..4]`, カーソル3は範囲内 ✓
- `totalTasks <= 5` → `taskStartIdx = 0` 常に全件表示 ✓

**大きなバグは見当たらない。** 実装時に再確認。

### j/k 削除の影響

vim 風の `j/k` スクロールが使えなくなるが、フォーカスシステムにより `T`→`↑↓` や `L`→`↑↓` で代替可能。トレードオフとして許容。

### activeTab との連動

- `J`/`L`/`A` キー → `activeTab` **と** `focusedArea` を同時変更
- `1`/`2`/`3` キー → `activeTab` のみ変更（`focusedArea` は変更しない）
- `ESC` → `focusedArea = "global"` のみ（`activeTab` は変更しない）

この分離により「タブを見る」と「タブを操作する」を使い分けられる。
