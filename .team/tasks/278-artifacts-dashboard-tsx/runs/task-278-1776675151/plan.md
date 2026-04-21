---
task: T278
role: planner
created: 2026-04-20
---

# T278 Artifacts タブ カーソル追従スクロール 実装計画

## 1. 背景・目的

TUI ダッシュボード（`skills/cmux-team/manager/dashboard.tsx`）の Artifacts タブでは、↑/↓ キーで `state.artifactCursor` は更新されるが、`buildArtifactRows` は `filtered` 配列全体を `for` ループで描画しているため、カーソルが画面下端を超えてもスクロール位置が変わらず、選択中の行が視界から消える。

Tasks タブ（L1094-1113）は `TASK_VISIBLE_LINES` を境界にカーソル追従型の `startIdx` を算出して slice する方式で解決済み。Artifacts タブにも同じパターンを適用し、Artifacts が増えても選択行が常に可視領域に収まるようにする。

## 2. 影響範囲

- 変更ファイル: `skills/cmux-team/manager/dashboard.tsx` のみ
- 変更箇所:
  - L30-33 付近 — 定数 `ARTIFACT_VISIBLE_LINES` の追加（1 行）
  - L799-850 — `buildArtifactRows` 内の for ループ（slice 導入 + `isSelected` 判定変更）
- 変更しない箇所:
  - Up/Down キーハンドラ（L1341-1343, L1368-1371）— cursor 更新ロジックは既に境界を clamp しているため変更不要
  - フィルタ/ソート切替時の `artifactCursor: 0` リセット（L1481, L1487）— 既存で cursor=0 へ戻るため、slice 側で自動的に先頭に追従する
  - 初期化 `artifactCursor: 0`（L1045）— 変更不要
  - プレビュー描画（L836-847）— `filtered[state.artifactCursor]` は元 index 参照のままで正しい

## 3. 詳細な実装ステップ

### Step 1. 定数の追加（L30-33 付近）

L30-33 の視認性定数ブロックに `ARTIFACT_VISIBLE_LINES` を追加する。

```diff
 const LOG_VISIBLE_LINES = 30;
 const TASK_VISIBLE_LINES = 5;
 const JOURNAL_VISIBLE_LINES = 30;
+const ARTIFACT_VISIBLE_LINES = 12;
 const SETTINGS_PREVIEW_LINES = 20;
```

### Step 2. `buildArtifactRows` 内で slice + isSelected 判定の変更（L817-833）

Tasks タブ (L1097-1100) と同じ式で `startIdx` を算出し、`filtered` を slice する。for のインデックス `i` は slice 後のローカル index、`isSelected` 判定は元の index（`startIdx + i`）と `state.artifactCursor` の比較に変更する。

```diff
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
     // ... (残りはそのまま)
   }
```

### Step 3. プレビュー部はそのまま

L836-847 のプレビュー描画は `filtered[state.artifactCursor]` を参照しているため、slice の影響を受けない。変更不要。

### Step 4. Up/Down キーハンドラの動作確認

- Up (L1342): `Math.max(s.artifactCursor - 1, 0)` — cursor が負にならない
- Down (L1370): `Math.min(s.artifactCursor + 1, filtered.length - 1)` — cursor は最大でも `filtered.length - 1`

Step 2 の `startIdx` 式はこの範囲で常に有効な slice 範囲を返すため、キーハンドラ側の変更は不要。

## 4. 設計判断

### 4.1 `ARTIFACT_VISIBLE_LINES` の推奨値と理由

**推奨値: 12**

理由:
- タスク本文の指示は「10〜15 行、Journal/Log の 30 より小さく」
- Artifacts タブはリスト部に加えて下部に 5 行程度のプレビューブロック（空行 + セパレータ + body 冒頭 5 行 + `...`）を重ねて表示する（L836-847）。表示件数を大きくするとプレビューが画面下にはみ出しやすい
- TASK_VISIBLE_LINES = 5 よりは大きくし、通常の artifact 件数（十数件〜数十件）でスクロール挙動を視認できる必要がある
- 12 は「10〜15 の中央寄り」かつ「プレビュー込みでも画面内に収まる」現実的な値

実運用で画面サイズに合わないと判明した場合は、将来的に「ターミナルの行数から動的算出」する拡張余地を残す。今回は定数方式で Tasks タブと同形を保つ。

### 4.2 `startIdx` 計算式

Tasks タブ (L1097-1100) の式をそのまま流用する:

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
```

動作:
- `filtered.length <= ARTIFACT_VISIBLE_LINES`: `startIdx = 0`、全件表示（slice は `[0, length]` 相当）
- カーソルが下方向に VISIBLE_LINES を超えた場合: `startIdx = cursor - VISIBLE_LINES + 1`（カーソルが最下行に来るまでスクロール）
- 末尾付近: `startIdx = length - VISIBLE_LINES`（最後の 1 ページは固定）
- カーソルが `startIdx` より上になった場合（Up で戻った直後など）: `startIdx = cursor`（カーソルが先頭行に来るようスクロール）

### 4.3 ループ内 `isSelected` 判定の変更点

| Before | After |
|---|---|
| `for (let i = 0; i < filtered.length; i++)` | `for (let i = 0; i < visibleArtifacts.length; i++)` |
| `const a = filtered[i]!;` | `const a = visibleArtifacts[i]!;` |
| `const isSelected = i === state.artifactCursor;` | `const globalIdx = artifactStartIdx + i;`<br>`const isSelected = globalIdx === state.artifactCursor;` |

`i` はあくまで slice 後のローカル index（0〜VISIBLE_LINES-1）。`artifactCursor` は slice 前の元 index を保持し続けるので、比較には `globalIdx` を使う。Tasks タブ L1106-1107 と同じ構造。

## 5. テスト / 動作検証

手動検証（タスク本文の検証 1〜5 を踏襲）:

1. **多件スクロール**: artifact を 20 件以上用意（`ls .team/artifacts | wc -l` で現状確認、不足分はダミー作成）。Artifacts タブで ↓ を連打して 13 件目以降に進み、カーソル行が画面内に残ること、上の行が見切れていくことを確認
2. **上端**: カーソルを先頭まで戻し、先頭行が常に見えていること（`startIdx = 0`）
3. **下端**: カーソルを末尾まで進め、末尾行が常に見えていること（`startIdx = length - VISIBLE_LINES`）
4. **フィルタ切替時**: タイプフィルタ / ソート切替で `artifactCursor: 0` になり、slice も先頭から始まること（プレビューが正しい artifact を指すこと）
5. **少件数**: artifact が `ARTIFACT_VISIBLE_LINES` 以下（12 件以下）のとき、全件表示され、カーソル移動で scroll が起きないこと（旧挙動と同一）

補助確認:
- `cd skills/cmux-team/manager && bun run tsc --noEmit` で型エラーが無いこと（リポジトリの慣習に合わせ、既存の型チェックコマンドがあればそれを使う）
- Tasks タブ側の挙動が変わっていないこと（今回の変更は Artifacts 側に閉じる）

## 6. リスク・考慮事項

| リスク | 影響 | 対応 |
|---|---|---|
| `filtered.length <= ARTIFACT_VISIBLE_LINES` の境界 | slice が短くなりすぎる | `if (filtered.length > ARTIFACT_VISIBLE_LINES)` で保護。それ以下なら `startIdx=0` で全件 slice（`slice(0, VISIBLE_LINES)` は length 未満なら length 分返す仕様で安全） |
| 空リスト (`filtered.length === 0`) | 早期 return で既に処理済み | 変更なし (L802-804) |
| `artifactCursor >= filtered.length` となる瞬間 | sort/filter 切替中や artifacts 再読込時に cursor が範囲外になると `isSelected` が誰も一致せず、プレビューも空 | 現状で `artifactCursor: 0` リセット済み (L1481, L1487)。再読込での範囲外は **既存からある問題** であり、本タスクのスコープ外（別途 T 起票を検討する場合はこの plan とは別扱い） |
| `ARTIFACT_VISIBLE_LINES` が端末高さに対して大きすぎる | プレビューが画面下にはみ出す | 定数 12 は Journal/Log (30) の半分以下、Tasks (5) の 2.4 倍と保守的。実運用で問題が出たら定数調整または動的化で対応 |
| Tasks と同じ式での off-by-one | Tasks 側で長期稼働実績がある式をそのまま流用するため低リスク | 検証 1〜3 でカバー |
| プレビューの `filtered[state.artifactCursor]` が slice と不整合 | prop 名が紛らわしいが `filtered` は slice 前のフル配列のため整合 | コメントで明示するか、変数名を `visibleArtifacts` とすることで混同防止（Step 2 参照） |

## 7. 変更後の構造（概略）

```
buildArtifactRows(state):
  filtered = getFilteredArtifacts(state)
  if filtered.length === 0: return [no artifacts]
  rows = []
  push フィルタ/検索インジケータ行（既存）
  // ── 新規 ────────────────────
  startIdx = tasks と同じ式（filtered.length > VISIBLE_LINES のときのみ）
  visibleArtifacts = filtered.slice(startIdx, startIdx + VISIBLE_LINES)
  for i in 0..visibleArtifacts.length:
    globalIdx = startIdx + i
    isSelected = globalIdx === state.artifactCursor
    push artifact 行
  // ────────────────────────────
  push プレビュー（filtered[state.artifactCursor] のまま — 変更なし）
  return rows
```

## 8. 作業見積もり

- 実装: 10〜15 分（定数 1 行 + for ループ前後に 10 行弱の追加）
- 型チェック + 手動検証: 15〜20 分
- 合計: 30 分程度の小タスク
