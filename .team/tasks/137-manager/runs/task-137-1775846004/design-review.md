# Design Review: T137 サイドバーステータス更新

## Verdict: Changes Requested

## Findings

### [Major] computeSidebarStatus が state を引数に取りつつ state.lastSidebarCategory を参照 — 純粋関数ではない
- 問題: plan.md のセクション 4.3 で `computeSidebarStatus()` を「純粋な判定ロジック」と記述しているが、"done" 判定のために `state.lastSidebarCategory` を参照している。これは副作用を持つ state を読む関数であり、テストや推論が困難になる。
- 推奨: `computeSidebarStatus` の引数に `prevCategory: string | null` を明示的に渡す形にし、DaemonState への直接参照を排除する。これにより純粋関数としてテスト可能になる。

```typescript
function computeSidebarStatus(
  state: Pick<DaemonState, "conductors" | "rateLimit" | "pendingTasks" | "openTasks">,
  prevCategory: string | null,
): SidebarStatus { ... }
```

### [Major] "done" 判定の条件が不完全 — error/throttled からの遷移で "done" が表示されない
- 問題: plan.md セクション 2 の "done" 条件は `lastSidebarCategory === "running" || "running_pending"` のときのみ発火する。しかし、タスク実行中にスロットリングが発生し、スロットリング解消後にタスクが完了していた場合、`lastSidebarCategory` は `"throttled"` であり "done" が表示されない。
- 推奨: "done" の条件を「直前が idle 以外」かつ「openTasks === 0」に広げるか、あるいは "done" 遷移のトリガーを `openTasks の減少` で判定する方式を検討する。ただし、これが許容可能なエッジケースであれば Minor に格下げ可。

### [Minor] clearStatus の catch が空 — ロギングポリシー違反
- 問題: plan.md セクション 3 の `clearStatus()` で `catch (e: any) {}` と空の catch を使用している。CLAUDE.md のロギングポリシーでは「空の catch は禁止、ただし冪等な後処理は例外として許容」と明記されている。
- 推奨: `clearStatus` は冪等な後処理に該当するのでポリシー上は許容されるが、plan.md のコメントにその旨を明記している点は良い。既存の `closeSurface` / `renameTab` と同じパターンなので一貫性は保たれている。**実装時はこのまま進めて問題ない。**

### [Minor] `updateSidebarStatus` と `updateTeamJson` の並列実行が plan に記載されているが tick() のコード例では直列
- 問題: plan.md セクション 4.2 で「`updateTeamJson()` と並列で呼ばれる」と書かれているが、セクション 4.4 の tick() コード例では末尾に `await updateSidebarStatus(state)` を直列で追加している。一方、main.ts:481-482 を見ると `tick()` と `updateTeamJson()` は main.ts のメインループで直列に呼ばれている（`await tick(state); await updateTeamJson(state);`）。
- 推奨: plan.md の記述を「`tick()` の末尾で `updateTeamJson()` の直前（main.ts ループ内）に呼ばれる」に訂正する。あるいは main.ts 側で `Promise.all([updateTeamJson(state), updateSidebarStatus(state)])` にする場合はその旨を明記する。現状の「tick() 末尾に追加」で問題ないが、記述の矛盾を解消すべき。

### [Minor] DaemonState の型定義変更が schema.ts ではなく daemon.ts
- 問題: plan.md では `DaemonState` に `lastSidebarStatus` と `lastSidebarCategory` を追加するとしているが、`DaemonState` は `daemon.ts:36` で定義されている（schema.ts ではない）。plan.md のセクション 1 の変更対象に schema.ts は含まれておらず、セクション 4.1 で正しく daemon.ts と記載されているので実害はない。ただしレビュー指示書では schema.ts の確認が求められていたので念のため記録する。
- 推奨: 変更なし。DaemonState は daemon.ts で定義されており、plan の変更対象は正しい。

### [Minor] formatResetRemaining のコピーは妥当だが、将来的に共有ユーティリティ化を検討
- 問題: plan.md で dashboard.tsx の `formatResetRemaining` をコピーする方針。dashboard.tsx は React/Ink の TUI モジュールなので daemon.ts から import するのは不自然という理由は妥当。
- 推奨: 現時点ではコピーで問題ない。ただし、将来的に 3 箇所以上で使われるようになった場合は `utils.ts` 等への切り出しを検討。plan の判断は承認。

### [Minor] setStatus の key が "claude_code" でハードコード
- 問題: plan.md セクション 4.2 で `cmux.setStatus("claude_code", ...)` と key をハードコードしている。cmux のドキュメントでは「異なるツールが独自のキーを管理」とあり、将来的に複数の status を持つ場合に競合する可能性がある。
- 推奨: 定数化する（`const SIDEBAR_STATUS_KEY = "claude_code"` を daemon.ts のトップレベルに配置）。軽微な改善だが、shutdown 時の clearStatus と updateSidebarStatus の両方で同じ key を使う必要があるため、typo 防止にも有効。

## Recommendations

1. **`computeSidebarStatus` を純粋関数化する**: `prevCategory` を明示的引数にする。DaemonState 全体ではなく必要なフィールドのみを受け取る Pick 型を使う。
2. **"done" 遷移条件の明確化**: `"throttled"` → 完了のパスを許容するか、意図的に除外するかを明記する。除外する場合はその理由をコメントで残す。
3. **plan.md の tick()/updateTeamJson() 並列記述の矛盾を解消する**: 実装時にどちらの構成を取るか決める。
4. **status key を定数化する**: `"claude_code"` をリテラルで複数箇所に書くのではなく定数にする。
