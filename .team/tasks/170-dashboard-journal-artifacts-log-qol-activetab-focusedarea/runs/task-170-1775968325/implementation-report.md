# 実装レポート — dashboard.tsx Journal / Artifacts / Log タブ QoL 改善

task: 170
run: task-170-1775968325
対象ファイル: `skills/cmux-team/manager/dashboard.tsx` のみ

## 変更箇所の一覧

### 1. `switchTab` ヘルパー導入（`app.view(buildViewWithApp);` 直後、`app.keys({...})` の直前）

```ts
type TabId = AppState["activeTab"];
const FOCUSED_AREA_FOR_TAB: Record<TabId, AppState["focusedArea"]> = {
  journal: "journal",
  artifacts: "artifacts",
  log: "log",
};
function switchTab(tab: TabId) {
  try {
    app.update((s) => ({ ...s, activeTab: tab, focusedArea: FOCUSED_AREA_FOR_TAB[tab] }));
  } catch {}
}
```

配置位置の根拠: `app` インスタンスをクロージャで参照できる位置、かつ `app.keys({...})` より前。`function` 宣言のため、`buildViewWithApp`（宣言位置はこの前）内からも hoisting により呼び出し可能。

### 2. タブボタン onPress（旧 964-984）

`ui.button({ id: "tab-journal" | "tab-artifacts" | "tab-log" })` の `onPress` を、個別の `app.update(...)` から `switchTab("journal" | "artifacts" | "log")` に統一。

### 3. 数字キー `1` / `2` / `3` — バグ修正

- 変更前: `app.update((s) => ({ ...s, activeTab: ... }))`（focusedArea 未更新）
- 変更後: `switchTab("journal" | "artifacts" | "log")`（activeTab + focusedArea を同期）

### 4. `Tab` キー — バグ修正

- 変更前: `app.update` 内で activeTab のみを巡回（focusedArea 未更新）
- 変更後: `(ctx)` 引数で現在の activeTab を読み、次のタブへ `switchTab(next)` で遷移

```ts
Tab: (ctx) => {
  const tabs: AppState["activeTab"][] = ["journal", "artifacts", "log"];
  const idx = tabs.indexOf(ctx.state.activeTab);
  const next = tabs[(idx + 1) % tabs.length]!;
  switchTab(next);
},
```

### 5. `J` / `A` / `L` キー — ヘルパー統一

機能は等価だが、記述を `switchTab(...)` に統一。

### 6. フッターヒントに J/A/L を追記

- `tasks` ブランチ: `J` journal / `A` artifacts / `L` log を `Enter open` と `ESC back` の間に追記
- `journal` ブランチ: `A` artifacts / `L` log を追記（自タブ `J` は省略）
- `log` ブランチ: `J` journal / `A` artifacts を追記（自タブ `L` は省略）
- `artifacts` ブランチ: `J` journal / `L` log を `f filter` の後に追記（自タブ `A` は省略）
- `global` ブランチ（1043 以降）: 変更なし

### 7. Escape ハンドラ — 変更なし

plan 記載通り、`confirmingFullQuit = false` / `focusedArea: "global"` を維持。activeTab はそのまま保持される。

## 型チェック結果

```
$ bunx tsc --noEmit
cmux.ts(22,5): error TS2322: Type '{ stdout: string | NonSharedBuffer; ... }' ... // 既存
dashboard.tsx(372,5): error TS2322: Type '"unstyled"' is not assignable ... // 既存（sectionTitle の dsVariant）
dashboard.tsx(956,11): error TS2322: Type '"unstyled"' is not assignable ... // 既存（Tasks セクションボタン）
main.ts(394,42): error TS2345: Argument of type 'string | null' ... // 既存
```

**今回の変更による新規エラーなし。** 上記 4 件はすべて既存の型エラー。

検出件数: 4 件。`head -60` で取得した全出力に含まれる追加の dashboard.tsx エラーはなし（= switchTab 導入、ctx 参照、フッターヒント追記のいずれも TS チェックを通過）。

## plan からの逸脱

なし。plan.md §2 の「採用案 c」通りに実装。`switchTab` の配置位置は plan.md §2-0 で検討された 3 案のうち「最も安全な案」を不要とし、シンプルに「`app.update` で両 state を一括更新する `switchTab` を全経路から呼ぶ」形を採用（Tab キーも含む）。

## 未解決の懸念

- 型チェックで既存エラーが 4 件残っているが、いずれも今回のスコープ外。`dashboard.tsx` の `dsVariant: "unstyled"` 問題は rezi-ui 側の型定義と実装の乖離と思われる（実行時には問題なく動作しているはず）。
- 手動 E2E 確認（plan.md §3）は本実装者の責務外。ユーザーまたは Inspector ロールが実施する想定。
- `ctx` 引数の型は他の `(ctx) =>` ハンドラ（`Enter`, `r`, `q`, `Q`）と同じ形なので、新たな型定義の追加は不要。

## 変更ファイル

- `skills/cmux-team/manager/dashboard.tsx` （+36 行 / -13 行）

他のファイル、テンプレート（`skills/cmux-team/templates/*.md`）、ランタイムプロンプト（`.team/prompts/*.md`）、CLI、自動テストは一切変更していない。
