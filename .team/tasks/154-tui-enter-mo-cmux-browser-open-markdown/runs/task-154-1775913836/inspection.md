# 検品結果: T154 — TUI停止せず mo + cmux browser open で Markdown 表示

## 判定: GO

全検品項目をパス。

## 検品詳細

### 1. コード品質 — PASS

計画通りに実装されている:
- `mo` パス: `Bun.spawn(["mo", filePath])` → 500ms 待機 → `Bun.spawn(["cmux", "browser", "open", ...])` → `return`
- `cat` フォールバック: TUI 停止 → `cat` 実行 → TUI 再開 → `onResumed()`
- JSDoc コメントも更新済み（L742-745）

### 2. 型安全性 — PASS

`npx tsc --noEmit` で検出されたエラー3件はすべて既存・無関係:
- `dashboard.tsx:372` — `"unstyled"` 型不一致（既存）
- `dashboard.tsx:914` — `"unstyled"` 型不一致（既存）
- `main.ts:402` — `string | null` vs `string | undefined`（既存）

今回の変更に起因するエラーはゼロ。

### 3. ロジック正確性 — PASS

- **mo パスで TUI が停止されていないこと**: L754-760 で `app.stop()` は呼ばれず、`dashboardActive` も変更なし。`return` で即座に関数終了。
- **mo パスで `dashboardActive` が変更されていないこと**: 確認済み。`dashboardActive = false` は L763 にあり、`cat` パスでのみ到達。
- **cat フォールバックで TUI 停止・再開が正しいこと**: L763-765 で `dashboardActive = false` → `clearInterval` → `app.stop()`。L776-777 で `app.start()` → `onResumed()`。
- **cat フォールバックで `onResumed()` が呼ばれること**: L777 で呼ばれる。ただし `catch {}` 内で例外が発生した場合も `app.start()` / `onResumed()` は `try` ブロックの外にあるため確実に実行される。

### 4. 呼び出し元への影響 — PASS

diff のハンクは `openArtifactInViewer` 関数本体のみ（L741-778）。呼び出し元2箇所:
- L1082-1092: 変更なし
- L1101-1111: 変更なし

どちらも `openArtifactInViewer(app, filePath, () => { dashboardActive = true; ... refresh(); })` のまま。mo パスでは `onResumed` が呼ばれない（`return` で終了）が、呼び出し元のコールバックは `dashboardActive = true` を設定するだけなので、mo パスでは `dashboardActive` が `false` にならないため問題なし。

### 5. stdio 設定 — PASS

- L756: `Bun.spawn(["mo", filePath], { stdio: ["ignore", "ignore", "ignore"] })` — OK
- L758: `Bun.spawn(["cmux", "browser", "open", ...], { stdio: ["ignore", "ignore", "ignore"] })` — OK

両方とも stdin/stdout/stderr すべて `"ignore"` で TUI の stdio と干渉しない。
