# T082: TUI ダッシュボード QoL 改善 — 実装計画

## 対象ファイル

`skills/cmux-team/manager/dashboard.tsx` のみ

## 変更1: Tasks 列のカーソル表示改善

### 現状（L694-701）
```tsx
const isSelected = globalIdx === state.taskCursor;
return ui.row({ gap: 0 }, [
  ui.text(isSelected ? "> " : "  ", isSelected ? { bold: true } : {}),
  buildTaskRow(task, assignedTaskIds.has(task.id), repoUrl),
]);
```
常時 `>` カーソルが表示される。

### 変更内容
- **フォーカス判定**: `activeTab === "journal"` のとき Tasks セクションがフォーカス状態（↑/↓ キーがタスク操作に使われるため）。`artifacts` / `log` タブ時は非フォーカス（j/k がそれぞれの操作に使われる）。
- **非フォーカス時**: カーソル非表示（`"  "` 固定）
- **フォーカス時**: 選択行に `_ ` を表示、非選択行は `"  "`

### 具体的変更
```tsx
const tasksFocused = state.activeTab === "journal";
// ...
ui.text(tasksFocused && isSelected ? "_ " : "  ", tasksFocused && isSelected ? { bold: true } : {})
```

## 変更2: Tasks のステータス表示を Nerd Font アイコン化

### 現状（L414-445 buildTaskRow 関数）
```tsx
const label = isAborted ? "aborted" : isClosed ? "closed" : assigned ? "running" : blockedLabel ?? task.status;
// ...
ui.text(`[${label}]`, colorStyle),
```
テキストで `[running]`, `[closed]` 等を表示。

### 変更内容
ステータスに応じた Nerd Font アイコンを使用。`nerdIcon()` ヘルパー（既存）でフォールバック。

| status | Nerd Font | fallback |
|--------|-----------|----------|
| running | `` (U+F04B nf-fa-play) | `[running]` |
| closed | `` (U+F00C nf-fa-check) | `[closed]` |
| ready | `◆` (U+25C6) | `[ready]` |
| aborted | `` (U+F00D nf-fa-times) | `[aborted]` |
| blocked | `` (U+F023 nf-fa-lock) | `[blocked]` |
| draft | `` (U+F040 nf-fa-pencil) | `[draft]` |

### 具体的変更
`buildTaskRow` 内で `label` テキストの代わりにアイコンマッピングを使用:
```tsx
const statusIcons: Record<string, { nerd: string; fallback: string }> = {
  running: { nerd: "\uf04b", fallback: "[running]" },
  closed: { nerd: "\uf00c", fallback: "[closed]" },
  ready: { nerd: "\u25c6", fallback: "[ready]" },
  aborted: { nerd: "\uf00d", fallback: "[aborted]" },
  blocked: { nerd: "\uf023", fallback: "[blocked]" },
  draft: { nerd: "\uf040", fallback: "[draft]" },
};
const iconInfo = statusIcons[label] ?? { nerd: `[${label}]`, fallback: `[${label}]` };
const statusDisplay = nerdIcon(iconInfo.nerd, iconInfo.fallback);
```
既存の `icon` 変数（行頭の `●/○/✕`）も Nerd Font 化する:
- `icon` 変数は行頭のドット表示で、status アイコンとは別。こちらはそのまま維持する（タスク指示に含まれていない）。

## 変更3: Journal のイベントアイコンを Nerd Font 化 + surface dim

### 3a. アイコン変更

#### 現状（L207-228 parseJournalEntries）
```tsx
result.push({ time, icon: "[+]", ... });   // タスク追加
result.push({ time, icon: "[▶]", ... });   // タスク開始
result.push({ time, icon: "[✓]", ... });   // タスク完了
result.push({ time, icon: "[✕]", ... });   // タスク中止
```

#### 変更内容
| event | Nerd Font | fallback |
|-------|-----------|----------|
| task_received `[+]` | `` (U+F055 nf-fa-plus_circle) | `[+]` |
| conductor_started `[▶]` | `` (U+F04B nf-fa-play) | `[▶]` |
| task_completed `[✓]` | `` (U+F058 nf-fa-check_circle) | `[✓]` |
| task_aborted `[✕]` | `` (U+F057 nf-fa-times_circle) | `[✕]` |

`parseJournalEntries` 内で `nerdIcon()` を呼ぶ:
```tsx
result.push({ time, icon: nerdIcon("\uf055", "[+]"), ... });
```

`journalIconColors` のキーも Nerd Font アイコンに対応するように更新が必要。
→ アイコン文字列が環境依存で変わるため、色は `parseJournalEntries` 内で level ベースにするか、アイコンとセットで色情報を持つ構造に変更。

### 3b. surface 表示を dim にする

#### 現状
`parseJournalEntries` で `message` に `surfaceTag` を含めている:
```tsx
const surfaceTag = surface ? `[${surface}] ` : "";
result.push({ ..., message: `${surfaceTag}${title}` });
```
`buildJournalRows` では message 全体を同じスタイルで表示。

#### 変更内容
`JournalEntry` に `surface?: string` フィールドを追加し、`buildJournalRows` で dim スタイルで個別レンダリング。

```tsx
// JournalEntry に追加
interface JournalEntry {
  time: string;
  icon: string;
  taskId: string;
  message: string;
  level: "info" | "warn" | "error";
  surface?: string;        // ← 追加
  iconColor?: number;      // ← 追加（アイコンの色を直接持つ）
}
```

`buildJournalRows` で:
```tsx
return ui.row({ gap: 1 }, [
  ui.text(entry.time, { dim: true }),
  ui.text(entry.icon, entry.iconColor ? { style: { fg: entry.iconColor } } : {}),
  ui.text(`T${entry.taskId.padStart(3, "0")}`, { bold: true }),
  entry.surface ? ui.text(`[${entry.surface}]`, { dim: true }) : null,
  buildTitleWithLinks(entry.message, repoUrl),
]);
```

## 注意事項

- `nerdIcon()` は既存（L129-131）。`CMUX_NERD_FONT === "0"` でフォールバック。
- Nerd Font のコードポイントは nerdfonts.com/cheat-sheet で要確認。計画書のコードポイントが正しいか実装時に検証すること。
- `journalIconColors` マップ（L450-455）はキーがアイコン文字列。Nerd Font 化で動的になるため、`iconColor` フィールドで直接色を渡す方式に変更する。
- 既存のテスト（`daemon.test.ts`）には dashboard のテストはないため、テスト追加は不要。
