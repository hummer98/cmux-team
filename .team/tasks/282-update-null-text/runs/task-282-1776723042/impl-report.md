# T282 実装レポート

## 変更したファイル

- `skills/cmux-team/manager/dashboard.tsx`（1 箇所）

## 差分要約

`ui.column({ gap: 0 }, [...])` の配列要素として配置されていた Update 通知バナー生成 IIFE を、配列 spread による条件付き挿入に置き換えた。

**before:**

```tsx
// Update 通知バナー（T187）
(() => {
  const ua = daemon.updateAvailable;
  if (!ua) return ui.text("", { dim: true });
  // ... suffix 組み立て ...
  return ui.text(`⬆ update available: ...`, { style: { fg: YELLOW, bold: true } });
})(),
```

`updateAvailable` が null のとき `ui.text("", { dim: true })` が配列要素として残り、`gap: 0` の column 上で 1 行分の高さを占有して空白行になっていた。

**after:**

```tsx
// Update 通知バナー（T187）— updateAvailable が非 null のときのみ挿入
...(daemon.updateAvailable
  ? [(() => {
      const ua = daemon.updateAvailable!;
      // ... suffix 組み立て ...
      return ui.text(`⬆ update available: ...`, { style: { fg: YELLOW, bold: true } });
    })()]
  : []),
```

`updateAvailable` が null のときは `...[]` で配列から要素自体が消えるため、ヘッダー直下の空白行が解消される。非 null 時の挙動（3 分岐 suffix）は従来通り維持。

TypeScript の narrowing 対策として内部 IIFE では `daemon.updateAvailable!` の non-null assertion を使用（元コードの動作と等価）。

## 型チェック・ビルド結果

`skills/cmux-team/manager` で `bunx tsc --noEmit` を実行:

- dashboard.tsx 起因のエラー: **0 件**
- 既存エラー（本タスク非関連・本修正前から存在）:
  - `conductor.ts(197,3)` TS1016 required parameter cannot follow an optional parameter
  - `daemon.test.ts(3720,9)` TS2322 literal type
  - `daemon.ts(1538,22)` TS2352 conversion

本修正は dashboard.tsx のみに限定しており、既存エラーはスコープ外。

## 残課題・懸念点

- 本プロジェクトには TUI 自動スナップショットテストが存在しないため、視覚的確認は手動目視（`cmux-team start` 後にヘッダー直下の行詰まりを目視）となる。
- `updateAvailable` 非 null 時の 3 分岐（`createdTaskId` / `updateMode === "task"` / default）は純粋にロジック移行のみで、従来通りのバナーが出る想定。
- 他の「null 時に空 text を返す」パターンが dashboard.tsx 内にあるかは未確認（T282 のスコープ外）。
- 既存の tsc エラー 3 件（conductor.ts / daemon.test.ts / daemon.ts）は本タスクと無関係。別タスクで対応すべき事項。
