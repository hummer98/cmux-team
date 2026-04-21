---
task: T278
role: implementer
created: 2026-04-20
---

# T278 Artifacts タブ カーソル追従スクロール 実装レポート

## 1. 変更概要

plan.md の Step 1-3 を `skills/cmux-team/manager/dashboard.tsx` に適用した。

- L30-33 付近: 視認性定数ブロックに `ARTIFACT_VISIBLE_LINES = 12` を追加（Tasks / Journal / Log / Settings の並びに合わせ JOURNAL の直後 / SETTINGS の直前）
- `buildArtifactRows` (L817-833 付近): Tasks タブ (L1094-1100) と同形の `artifactStartIdx` 算出と `filtered.slice(...)` を導入、for ループを `visibleArtifacts` で回すように変更、`isSelected` 判定を `globalIdx === state.artifactCursor` に変更
- プレビュー描画 (`filtered[state.artifactCursor]`)、Up/Down キーハンドラ、初期化、フィルタ/ソート切替時の cursor リセットは **変更していない**

## 2. git diff（commit 前）

```diff
diff --git a/skills/cmux-team/manager/dashboard.tsx b/skills/cmux-team/manager/dashboard.tsx
index c429b38..4a717d4 100644
--- a/skills/cmux-team/manager/dashboard.tsx
+++ b/skills/cmux-team/manager/dashboard.tsx
@@ -30,6 +30,7 @@ import { AGENT_ROLES } from "./schema";
 const LOG_VISIBLE_LINES = 30;
 const TASK_VISIBLE_LINES = 5;
 const JOURNAL_VISIBLE_LINES = 30;
+const ARTIFACT_VISIBLE_LINES = 12;
 const SETTINGS_PREVIEW_LINES = 20;

 // --- GitHub リポジトリ URL 解決 ---
@@ -814,9 +815,24 @@ function buildArtifactRows(state: AppState): any[] {
     rows.push(ui.text(`  ${indicators.join("  ")}`, { dim: true }));
   }

-  for (let i = 0; i < filtered.length; i++) {
-    const a = filtered[i]!;
-    const isSelected = i === state.artifactCursor;
+  // カーソル追従スクロール（Tasks タブ L1094-1100 と同じ式）
+  let artifactStartIdx = 0;
+  if (filtered.length > ARTIFACT_VISIBLE_LINES) {
+    artifactStartIdx = Math.max(
+      0,
+      Math.min(
+        state.artifactCursor - ARTIFACT_VISIBLE_LINES + 1,
+        filtered.length - ARTIFACT_VISIBLE_LINES,
+      ),
+    );
+    if (state.artifactCursor < artifactStartIdx) artifactStartIdx = state.artifactCursor;
+  }
+  const visibleArtifacts = filtered.slice(artifactStartIdx, artifactStartIdx + ARTIFACT_VISIBLE_LINES);
+
+  for (let i = 0; i < visibleArtifacts.length; i++) {
+    const a = visibleArtifacts[i]!;
+    const globalIdx = artifactStartIdx + i;
+    const isSelected = globalIdx === state.artifactCursor;
     const typeColor = artifactTypeColors[a.type] ?? GRAY;
     const date = a.created ? utcToLocal(a.created).slice(0, 5) : "";
```

## 3. 型チェック

コマンド: `cd skills/cmux-team/manager && bunx tsc --noEmit`

結果: `dashboard.tsx` に新規エラーなし。

既存エラー（本タスクと無関係、変更前から存在）:

```
conductor.ts(197,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3650,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
```

- いずれも本タスクの変更対象外ファイル
- `dashboard.tsx` でフィルタ (`bunx tsc --noEmit 2>&1 | grep dashboard.tsx`) しても 0 件
- 変更箇所の型安全性は担保されている

## 4. 手動検証

TUI 起動による目視検証は Conductor 権限外（`cmux-team start` 済み環境での TUI 操作が必要）のため、**本 Agent では実施していない**。Inspector Agent 側の手動検証に委ねる。

検証観点（plan.md §5 の再掲）:

1. 多件スクロール（20 件以上で ↓ 連打、13 件目以降でカーソルが画面内に残る / 上が見切れる）
2. 上端（カーソル先頭で `startIdx=0`）
3. 下端（カーソル末尾で `startIdx = length - VISIBLE_LINES`）
4. フィルタ/ソート切替時（`artifactCursor=0` に戻り slice も先頭から）
5. 少件数（12 件以下では全件表示・スクロールなし＝旧挙動維持）

## 5. 未対応 / スコープ外

- commit はしない（Conductor が Phase 4 で まとめて実施）
- `artifactCursor >= filtered.length` となる瞬間（再読込中）の境界は **既存からある問題**、本タスクスコープ外（plan.md §6 リスク欄に明記）
- `ARTIFACT_VISIBLE_LINES` の動的化（端末高さ連動）は将来拡張として保留

## 6. 作業境界の遵守

- 対象: `skills/cmux-team/manager/dashboard.tsx` のみ（他ファイル未編集）
- 関連ない refactor / cleanup は行っていない
- 追加コメントは plan.md 準拠の 1 行（`// カーソル追従スクロール（Tasks タブ L1094-1100 と同じ式）`）のみ
