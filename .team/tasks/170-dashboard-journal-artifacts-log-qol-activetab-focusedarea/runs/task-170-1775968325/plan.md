# 実装計画書 — dashboard.tsx Journal / Artifacts / Log タブ QoL 改善

対象: `skills/cmux-team/manager/dashboard.tsx` 単独改修
スコープ: タブ切り替え経路の統一 + フッターヒント拡充

---

## 1. 設計方針

### 採用案: 実装案 c（`switchTab` ヘルパー統一）

`activeTab` と `focusedArea` は「表示タブ」と「操作対象」を別軸で表しているが、**タブ軸キー経由で切り替わる場合は常に両者を同期させる**のが不変条件。これを複数箇所で個別に書くと必ず漏れる（現状 1/2/3/Tab キーで漏れている）。

→ **ヘルパー関数 `switchTab(tab)` を定義し、タブ軸の全入口（ボタン onPress・1/2/3・Tab・J/A/L）をこれに統一する。**

Escape / T キーは「フォーカスのみを操作する経路」であり、activeTab には手を付けない（不変条件のただし書きに合致）。

### `switchTab` のシグネチャ・配置

```ts
// 配置: dashboard.tsx 内、app.keys({...}) 呼び出しの直前
//       （app インスタンスをクロージャで参照できる位置なら良い）
type TabId = AppState["activeTab"]; // "journal" | "artifacts" | "log"

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

- `try/catch` は既存の onPress ハンドラと同じ慣習。
- タブ ID → focusedArea のマッピングは自明だが、辞書化することで将来新タブ追加時の変更点を集約できる。

---

## 2. 変更箇所の詳細

### 2-1. タブボタン onPress（964-984）

既に両方更新しているが、ヘルパー統一のため書き換える。

**Before:**
```tsx
ui.button({
  id: "tab-journal",
  ...
  onPress: () => { try { app.update((s) => ({ ...s, activeTab: "journal", focusedArea: "journal" })); } catch {} },
}),
ui.button({
  id: "tab-artifacts",
  ...
  onPress: () => { try { app.update((s) => ({ ...s, activeTab: "artifacts", focusedArea: "artifacts" })); } catch {} },
}),
ui.button({
  id: "tab-log",
  ...
  onPress: () => { try { app.update((s) => ({ ...s, activeTab: "log", focusedArea: "log" })); } catch {} },
}),
```

**After:**
```tsx
ui.button({
  id: "tab-journal",
  ...
  onPress: () => switchTab("journal"),
}),
ui.button({
  id: "tab-artifacts",
  ...
  onPress: () => switchTab("artifacts"),
}),
ui.button({
  id: "tab-log",
  ...
  onPress: () => switchTab("log"),
}),
```

### 2-2. 数字キー 1/2/3（1103-1105）— バグ修正

**Before:**
```ts
"1": () => app.update((s) => ({ ...s, activeTab: "journal" })),
"2": () => app.update((s) => ({ ...s, activeTab: "artifacts" })),
"3": () => app.update((s) => ({ ...s, activeTab: "log" })),
```

**After:**
```ts
"1": () => switchTab("journal"),
"2": () => switchTab("artifacts"),
"3": () => switchTab("log"),
```

### 2-3. Tab キー（1106-1110）— バグ修正

**Before:**
```ts
Tab: () => app.update((s) => {
  const tabs: AppState["activeTab"][] = ["journal", "artifacts", "log"];
  const idx = tabs.indexOf(s.activeTab);
  return { ...s, activeTab: tabs[(idx + 1) % tabs.length]! };
}),
```

**After:**
```ts
Tab: (ctx) => {
  const tabs: AppState["activeTab"][] = ["journal", "artifacts", "log"];
  const idx = tabs.indexOf(ctx.state.activeTab);
  const next = tabs[(idx + 1) % tabs.length]!;
  switchTab(next);
},
```

（`ctx.state` で現在の activeTab を参照。`switchTab` 内で一括更新するため、二重 update を避ける）

### 2-4. J / A / L キー（1112-1114）— 既に正しいがヘルパーに統一

**Before:**
```ts
J: () => app.update((s) => ({ ...s, activeTab: "journal", focusedArea: "journal" })),
L: () => app.update((s) => ({ ...s, activeTab: "log", focusedArea: "log" })),
A: () => app.update((s) => ({ ...s, activeTab: "artifacts", focusedArea: "artifacts" })),
```

**After:**
```ts
J: () => switchTab("journal"),
L: () => switchTab("log"),
A: () => switchTab("artifacts"),
```

### 2-5. フッターヒントに J/A/L 追加（1017-1042）

現状 J/A/L 案内は `global` ブランチ（1043-1051）のみ。tasks/journal/artifacts/log 各ブランチにも `J/A/L` を追記する。

**tasks ブランチ（1017-1022）:**
```tsx
: state.focusedArea === "tasks"
? [
    ui.kbd("↑/↓"), ui.text("scroll"),
    ui.kbd("Enter"), ui.text("open"),
    ui.kbd("J"), ui.text("journal"),
    ui.kbd("A"), ui.text("artifacts"),
    ui.kbd("L"), ui.text("log"),
    ui.kbd("ESC"), ui.text("back"),
  ]
```

**journal ブランチ（1023-1028）:**
```tsx
: state.focusedArea === "journal"
? [
    ui.kbd("↑/↓"), ui.text("scroll"),
    ui.kbd("g/G"), ui.text("top/bottom"),
    ui.kbd("A"), ui.text("artifacts"),
    ui.kbd("L"), ui.text("log"),
    ui.kbd("ESC"), ui.text("back"),
  ]
```

（自タブへの J は省略。遷移先のみ列挙して冗長さを抑える）

**log ブランチ（1029-1034）:**
```tsx
: state.focusedArea === "log"
? [
    ui.kbd("↑/↓"), ui.text("scroll"),
    ui.kbd("g/G"), ui.text("top/bottom"),
    ui.kbd("J"), ui.text("journal"),
    ui.kbd("A"), ui.text("artifacts"),
    ui.kbd("ESC"), ui.text("back"),
  ]
```

**artifacts ブランチ（1035-1042）:**
```tsx
: state.focusedArea === "artifacts"
? [
    ui.kbd("↑/↓"), ui.text("select"),
    ui.kbd("Enter"), ui.text("open"),
    ui.kbd("s"), ui.text(`sort:${state.artifactSort}`),
    ui.kbd("f"), ui.text(state.artifactTypeFilter ? `type:${state.artifactTypeFilter}` : "filter"),
    ui.kbd("J"), ui.text("journal"),
    ui.kbd("L"), ui.text("log"),
    ui.kbd("ESC"), ui.text("back"),
  ]
```

**書式ルール:**
- `J/A/L` は独立した `ui.kbd` + `ui.text` のペアで並べる（他ヒントと同じ形式）
- 自タブへの遷移案内は省略
- 並び順: 既存操作 → タブ遷移 → ESC（最後）
- `1/2/3` / `Tab` は補助的なので冗長化回避のため表示しない（J/A/L だけ案内）

### 2-6. Escape ハンドラ（1210-1213）— 変更なし

```ts
Escape: () => {
  confirmingFullQuit = false;
  app.update((s) => ({ ...s, confirmingFullQuit: false, focusedArea: "global" }));
},
```

**現状のままで OK。** Escape は「操作対象を外す」意味論（focusedArea を global に戻す）であり、activeTab は「何が表示されているか」を保持すべき。ユーザーが Journal を見ながら Escape → また J で journal に戻れる、という挙動が期待される。

不変条件「activeTab と focusedArea がタブ軸で食い違う状態を作らない」は **focusedArea がタブ軸のとき（journal/artifacts/log）** が対象。global / tasks の場合は activeTab と独立して良いと明記されている。

---

## 3. テスト観点（手動確認チェックリスト）

### 3-1. 数字キー同期
- [ ] `1` キー: activeTab=journal / Journal ボタンが bold / フッターが journal 用 / Up/Down で Journal がスクロール
- [ ] `2` キー: activeTab=artifacts / Artifacts ボタンが bold / フッターが artifacts 用 / Up/Down で artifact カーソル移動
- [ ] `3` キー: activeTab=log / Log ボタンが bold / フッターが log 用 / Up/Down で Log がスクロール

### 3-2. Tab キー巡回
- [ ] `Tab` 連打で journal → artifacts → log → journal … と巡回
- [ ] 各遷移後にボタン bold・フッター・Up/Down 対象が同期

### 3-3. J/A/L 発火元
- [ ] global フォーカス（起動直後 or Escape 後）から `J`/`A`/`L` がそれぞれ該当タブへ遷移
- [ ] tasks フォーカス中から `J`/`A`/`L` 発火可能、フッターに案内が出ている
- [ ] journal フォーカス中から `A`/`L` 発火可能、フッターに案内が出ている
- [ ] artifacts フォーカス中から `J`/`L` 発火可能、フッターに案内が出ている
- [ ] log フォーカス中から `J`/`A` 発火可能、フッターに案内が出ている
- [ ] 遷移後、遷移先フッターに J/A/L ヒントが表示されている

### 3-4. タブボタンクリック
- [ ] Journal ボタンクリック → 3-1 の `1` キーと同じ結果
- [ ] Artifacts ボタンクリック → 3-1 の `2` キーと同じ結果
- [ ] Log ボタンクリック → 3-1 の `3` キーと同じ結果

### 3-5. Escape 時の activeTab 保持
- [ ] Journal を表示 → Escape → focusedArea=global、activeTab=journal のまま（Journal 表示継続、ボタン bold 維持）
- [ ] Artifacts を表示 → Escape → Artifacts 表示継続
- [ ] Log を表示 → Escape → Log 表示継続
- [ ] Escape 後に再度 `J`/`A`/`L` で該当タブにフォーカス戻し可能

---

## 4. 影響範囲・リスク

- **変更ファイル**: `skills/cmux-team/manager/dashboard.tsx` のみ
- **他ファイル依存**: なし（AppState 型・focusedArea の値は既存のまま、追加・削除なし）
- **テンプレート / prompts / CLI コマンド**: 変更なし
- **ランタイム互換性**: キー動作の挙動改善のみ。既存の機能を壊さない
- **リスク**:
  - `switchTab` ヘルパーを `app` インスタンス生成後・`app.keys()` 呼び出し前に配置する必要がある（配置順序注意）
  - Tab キーは `ctx.state` 参照に変更するため、`ctx` 引数の型と渡ってくるタイミングに注意（他の `(ctx) =>` ハンドラと同じ書式）

---

## 5. 非スコープ

- テンプレート (`skills/cmux-team/templates/*.md`) の更新はなし
- `.team/prompts/*.md` の更新はなし
- 自動テストの追加はなし（プロジェクト方針どおり手動 E2E 確認のみ）
- `cmux-team-investigate` スキル等、他のスキル・コマンドは触らない
- タブボタンのハイライト強化（nice-to-have）は本計画では行わない
- `1`/`2`/`3`/`Tab` のフッター案内は行わない（J/A/L のみ）

---

## 6. 完了条件

- `switchTab` ヘルパー導入済み
- 1/2/3/Tab キーで activeTab + focusedArea が同時更新される
- J/A/L ヒントが tasks / journal / artifacts / log フッターに追加されている
- Escape 挙動は従来通り（activeTab 保持、focusedArea=global）
- 手動テスト観点（§3）すべて通過
