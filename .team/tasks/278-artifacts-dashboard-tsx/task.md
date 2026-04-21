---
id: 278
title: Artifacts タブのスクロールをカーソル追従にする (dashboard.tsx)
priority: medium
created_by: surface:287
created_at: 2026-04-20T08:52:31.638Z
---

## タスク
## 問題

TUI ダッシュボードの Artifacts タブで、↑/↓ でカーソル (`artifactCursor`) は動くが、リストのスクロール位置がカーソルに追従しない。カーソルが可視範囲外に出ても表示がずれず、選択中の行が見えなくなる。

Journal/Log はオフセット型スクロール、Tasks はカーソル追従型スクロールで、**Tasks と同じ挙動** を Artifacts にも適用したい。

## 現状

`skills/cmux-team/manager/dashboard.tsx`:

- Tasks タブ（L1094-1101）: `TASK_VISIBLE_LINES` と `taskCursor` から `taskStartIdx` を計算して `slice` している（カーソル追従）
  ```ts
  const totalTasks = daemon.taskList.length;
  let taskStartIdx = 0;
  if (totalTasks > TASK_VISIBLE_LINES) {
    taskStartIdx = Math.max(0, Math.min(state.taskCursor - TASK_VISIBLE_LINES + 1, totalTasks - TASK_VISIBLE_LINES));
    if (state.taskCursor < taskStartIdx) taskStartIdx = state.taskCursor;
  }
  const visibleTasks = daemon.taskList.slice(taskStartIdx, taskStartIdx + TASK_VISIBLE_LINES);
  ```
- Artifacts タブ（`buildArtifactRows` L799-850）: `filtered` 全件を `for` でそのまま rows に積んでいる。スクロール計算なし。`artifactCursor` は `>` マーカー描画にしか使われていない。

## 修正方針

`buildArtifactRows` で Tasks と同じ `startIdx` 計算を導入し、`filtered` を可視範囲だけ slice する。インジケータ行・プレビューブロックは従来通り下に付ける。

1. `ARTIFACT_VISIBLE_LINES` 定数を L30-33 付近に追加（`TASK_VISIBLE_LINES` に準じた値。目安: 10〜15 行。他タブのレイアウト圧迫を避けるため Journal/Log の 30 よりは小さく）
2. `buildArtifactRows(state)` 内で:
   - `filtered.length > ARTIFACT_VISIBLE_LINES` の場合のみ `startIdx` を算出して slice する（タスクと同じ式）
   - `for` ループのインデックス `i` は **slice 後のローカル index**、`isSelected` 判定は **元の index (`startIdx + i`) と `state.artifactCursor` の比較** に変更する
   - プレビュー部（`filtered[state.artifactCursor]` 参照）はそのまま（全件中から参照するので startIdx に依存しない）
3. 念のため Up/Down キー側（L1341-1343, L1368-1370）は `artifactCursor` のクランプだけなので変更不要なはず。動作確認時に cursor が境界値で正しく動くかだけ検証。

## 影響範囲

- `skills/cmux-team/manager/dashboard.tsx` のみ
- 既存の sort/filter (`s`/`f` キー) は `artifactCursor: 0` にリセットする挙動なのでそのまま動く
- プレビュー行の描画範囲は変更しない（選択中 artifact のプレビューは常に末尾に出る）

## 検証

ビルド後、`cmux-team start` で起動し、Artifacts タブで以下を確認:

1. `f` で filter を全解除 → artifact 数が可視行を超えた状態で ↑/↓ を連打、カーソル行が常に画面内に入ること
2. リスト末尾で更に ↓ を押してもカーソルが動かず画面もずれないこと（`Math.min(cursor + 1, filtered.length - 1)` で止まる）
3. 先頭で ↑ を押してもカーソル 0 で止まること
4. Tasks タブと同じ体感（カーソル行が常に可視範囲の中/下側に追従）になっていること
5. プレビュー行（`── Axxx: title ──`）が選択中 artifact のものに連動して更新されること

## 参考

- Tasks タブのカーソル追従実装: `skills/cmux-team/manager/dashboard.tsx:1094-1113`
- Artifacts タブ描画: `skills/cmux-team/manager/dashboard.tsx:756-850`
- Up/Down キーハンドラ: `skills/cmux-team/manager/dashboard.tsx:1327-1381`
- Artifacts ステート定義: `skills/cmux-team/manager/dashboard.tsx:375-376` の `artifactCursor`
