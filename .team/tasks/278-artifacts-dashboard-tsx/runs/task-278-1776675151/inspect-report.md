# Inspect Report (T278)

## Verdict: GO

## Checklist

- [x] ARTIFACT_VISIBLE_LINES = 12 added at L30-33 area（L33 に追加、JOURNAL_VISIBLE_LINES の直後 / SETTINGS_PREVIEW_LINES の直前）
- [x] startIdx 計算式 (Tasks と同形)（L817-826、Tasks タブ L1113-1116 と同一構造）
- [x] visibleArtifacts slice（L827: `filtered.slice(artifactStartIdx, artifactStartIdx + ARTIFACT_VISIBLE_LINES)`）
- [x] for ループ変更 (visibleArtifacts.length)（L829: `for (let i = 0; i < visibleArtifacts.length; i++)`）
- [x] isSelected globalIdx 比較（L831-832: `const globalIdx = artifactStartIdx + i; const isSelected = globalIdx === state.artifactCursor;`）
- [x] プレビュー未変更（`filtered[state.artifactCursor]` は diff に出現なし、変更対象外）
- [x] Up/Down キー未変更（diff は `buildArtifactRows` 内と定数追加のみ、キーハンドラ行に変更なし）

## 型チェック結果

コマンド:
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-278-1776675151/skills/cmux-team/manager
bun run tsc --noEmit
```

出力:
```
conductor.ts(197,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3650,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
error: "tsc" exited with code 2
```

`dashboard.tsx` でフィルタすると 0 件:
```bash
$ bun run tsc --noEmit 2>&1 | grep dashboard.tsx
(空)
```

既存 2 件のエラー（`conductor.ts:197`, `daemon.test.ts:3650`）は本タスクの変更対象外ファイルで、impl-report.md §3 の記載とも一致。変更箇所の型安全性は担保されている。

## 境界ケース分析

| ケース | 期待挙動 | コード上の根拠 | 判定 |
|---|---|---|---|
| `filtered.length === 0` | 早期 return、変更部に到達しない | L803-805（既存）で `rows.push([...no artifacts...])` & return | OK |
| `filtered.length <= ARTIFACT_VISIBLE_LINES` | `artifactStartIdx = 0`、全件表示 | `if (filtered.length > ARTIFACT_VISIBLE_LINES)` ガード外のため初期値 `0` のまま。slice は `[0, 12]` だが配列長未満のため length 分返る仕様で安全 | OK |
| `cursor = 0` | `startIdx = 0` | `Math.min(0 - 12 + 1, len - 12)` = `min(-11, ...)` → `Math.max(0, 負数)` = `0`。さらに `cursor(0) < startIdx(0)` は false | OK |
| `cursor = filtered.length - 1`（末尾） | `startIdx = length - VISIBLE_LINES` | `Math.min(len-1-12+1, len-12)` = `min(len-12, len-12)` = `len-12`。`Math.max(0, len-12)` = `len-12` | OK |
| Up で cursor 戻し時に `cursor < startIdx` | `startIdx = cursor` に追従 | `if (state.artifactCursor < artifactStartIdx) artifactStartIdx = state.artifactCursor;` で明示的に再代入 | OK |
| `ARTIFACT_VISIBLE_LINES` 境界ちょうど（len == 12） | 全件表示（slice=12 件） | ガード `len > 12` が false → `startIdx=0` のまま → `slice(0, 12)` で全件 | OK |

## Tasks タブとの比較

Tasks タブ (L1112-1117):
```ts
let taskStartIdx = 0;
if (totalTasks > TASK_VISIBLE_LINES) {
  taskStartIdx = Math.max(0, Math.min(state.taskCursor - TASK_VISIBLE_LINES + 1, totalTasks - TASK_VISIBLE_LINES));
  if (state.taskCursor < taskStartIdx) taskStartIdx = state.taskCursor;
}
const visibleTasks = daemon.taskList.slice(taskStartIdx, taskStartIdx + TASK_VISIBLE_LINES);
```

Artifacts タブ (L817-827、本実装):
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

式・変数対応関係ともに完全一致（`totalTasks` ↔ `filtered.length`、`taskCursor` ↔ `artifactCursor`、`TASK_VISIBLE_LINES` ↔ `ARTIFACT_VISIBLE_LINES`）。Tasks 側は 1 行で書き、Artifacts 側は改行で整形しているが意味論上等価。`globalIdx === cursor` による isSelected 判定も Tasks L1122-1123 と同形。

## コードスタイル

- 追加コメントは 1 行のみ（`// カーソル追従スクロール（Tasks タブ L1094-1100 と同じ式）`）で plan.md 準拠
- 他ファイル未変更、関連しない refactor/cleanup なし
- 過剰な説明文なし

plan.md の Step 1-3 全てが正確に実装され、境界ケース・型安全性・Tasks タブとの整合性すべて確認できた。GO とする。
