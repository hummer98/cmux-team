# T282 実装計画書

## 1. 問題の再確認

TUI ダッシュボードのヘッダー直下に、常時 1 行の空白行が残っている。

- 症状: `cmux-team start` 後、最新版で稼働している間（= 大半の時間）はヘッダー直下に意味のない空白行が 1 行挿入された状態になる。
- 影響範囲: UX のみ（機能上の不具合はない）。
- 発生条件: `daemon.updateAvailable` が `null` のとき（＝通常稼働時）。

## 2. 現状コードの把握

### 対象箇所: `skills/cmux-team/manager/dashboard.tsx:1163-1179`

```tsx
// Update 通知バナー（T187）
(() => {
  const ua = daemon.updateAvailable;
  if (!ua) return ui.text("", { dim: true });
  let suffix: string;
  if (ua.createdTaskId) {
    suffix = `(task created: T${ua.createdTaskId})`;
  } else if (daemon.updateMode === "task") {
    suffix = `(task skipped — check logs)`;
  } else {
    suffix = `(run: cmux-team self-update)`;
  }
  return ui.text(
    `⬆ update available: v${ua.current} → v${ua.latest}  ${suffix}`,
    { style: { fg: YELLOW, bold: true } },
  );
})(),
```

### 構造の確認

- 親コンテナ: `ui.column({ gap: 0 }, [...])`（`dashboard.tsx:1132`）
- Update バナーは IIFE として **配列要素の 1 つ** として常に評価される。
- `updateAvailable` が null のときも `ui.text("", { dim: true })` という **空文字 text 要素**が配列に含まれるため、`gap: 0` でも 1 行分の高さを占有してしまう。

### 周辺要素（コンテキスト）

| 位置 | 要素 |
|------|------|
| 1134-1162 | ヘッダー行（rate limit + cmux-team 行） |
| 1163-1179 | **Update 通知バナー（今回の修正対象）** |
| 1181 | `sectionTitle("Master")` — 本来ヘッダーの直下に来てほしい |
| 1182 | `buildMasterSection(daemon)` |

## 3. 修正方針

### 基本方針

IIFE を**削除**し、配列 spread による**条件付き挿入**に書き換える。
`updateAvailable` が null のときは **何も挿入しない**（配列要素が消える）ため、`ui.column` 上で行が詰まる。

### 書き換え後のイメージ

```tsx
// Update 通知バナー（T187）— updateAvailable が非 null のときのみ挿入
...(daemon.updateAvailable
  ? [(() => {
      const ua = daemon.updateAvailable!;
      let suffix: string;
      if (ua.createdTaskId) {
        suffix = `(task created: T${ua.createdTaskId})`;
      } else if (daemon.updateMode === "task") {
        suffix = `(task skipped — check logs)`;
      } else {
        suffix = `(run: cmux-team self-update)`;
      }
      return ui.text(
        `⬆ update available: v${ua.current} → v${ua.latest}  ${suffix}`,
        { style: { fg: YELLOW, bold: true } },
      );
    })()]
  : []),
```

spread で `[]` を展開すれば配列から要素自体が消えるため、空 text 要素による空行占有が解消する。

### 代替案（比較）

| 案 | 内容 | 採否 |
|----|------|------|
| A | 上記の配列 spread + IIFE | **採用**。最小差分で null 時に要素を消せる |
| B | ヘルパー関数 `buildUpdateBanner(daemon)` に抽出して `...(daemon.updateAvailable ? [buildUpdateBanner(daemon)] : [])` | ファイル内の他バナーと一貫性が取れる場合は候補だが、今回は関数抽出の先例が dashboard.tsx にないため見送り |
| C | `ui.column` の children を `.filter(Boolean)` して null 弾き | column 全体の意味論を変えるため影響範囲が大きく不採用 |

タスク記述では B 型の例が示されているが、dashboard.tsx 内では IIFE スタイルが周辺（ヘッダー行の IIFE も含め）で既に使われているため、最小差分となる A を採用する。

## 4. 実装ステップ

1. **該当 IIFE の削除**
   - `dashboard.tsx:1163-1179` の `(() => { ... })(),` を削除する。
2. **条件付き spread 形式で置き換え**
   - 同位置に `...(daemon.updateAvailable ? [/* IIFE */] : []),` を挿入する。
   - IIFE 内部のロジック（suffix 決定、`ui.text` の生成）はそのまま維持する。
   - IIFE 冒頭の `if (!ua) return ...` ガードは不要になる（`daemon.updateAvailable` truthy 分岐内でのみ評価されるため）。ただし TypeScript の narrowing を維持するため `const ua = daemon.updateAvailable!;` とする（または `if (ua)` ガードを残してそのまま単一 return にする）。
3. **前後の要素順序は変えない** — コメント `// Update 通知バナー（T187）` は残す。

### 具体的な編集差分（概念）

```diff
-        // Update 通知バナー（T187）
-        (() => {
-          const ua = daemon.updateAvailable;
-          if (!ua) return ui.text("", { dim: true });
-          let suffix: string;
-          if (ua.createdTaskId) {
-            suffix = `(task created: T${ua.createdTaskId})`;
-          } else if (daemon.updateMode === "task") {
-            suffix = `(task skipped — check logs)`;
-          } else {
-            suffix = `(run: cmux-team self-update)`;
-          }
-          return ui.text(
-            `⬆ update available: v${ua.current} → v${ua.latest}  ${suffix}`,
-            { style: { fg: YELLOW, bold: true } },
-          );
-        })(),
+        // Update 通知バナー（T187）— updateAvailable が非 null のときのみ挿入
+        ...(daemon.updateAvailable
+          ? [(() => {
+              const ua = daemon.updateAvailable!;
+              let suffix: string;
+              if (ua.createdTaskId) {
+                suffix = `(task created: T${ua.createdTaskId})`;
+              } else if (daemon.updateMode === "task") {
+                suffix = `(task skipped — check logs)`;
+              } else {
+                suffix = `(run: cmux-team self-update)`;
+              }
+              return ui.text(
+                `⬆ update available: v${ua.current} → v${ua.latest}  ${suffix}`,
+                { style: { fg: YELLOW, bold: true } },
+              );
+            })()]
+          : []),
```

## 5. テスト計画

### 5.1 型チェック・ビルド

- `cd skills/cmux-team/manager && bun tsc --noEmit`（あるいは既存の lint/typecheck スクリプト）で型エラーがないことを確認する。
- 特に `daemon.updateAvailable!` の non-null assertion が TypeScript の型推論と整合していることを確認する。

### 5.2 手動確認（最新版稼働時）

1. `cmux-team start` で daemon 起動。
2. TUI ヘッダー行（`─ cmux-team ... ─`）の直下に **空白行が入らず**、そのまま `─ Master ─` セクション見出しが続くことを目視確認する。

### 5.3 手動確認（update available 時）

1. `state.updateAvailable` を手動で設定してバナーを表示させる方法:
   - 一時的に dashboard.tsx 内（あるいは daemon の updateAvailable 設定箇所）で固定値 `{ current: "4.1.0", latest: "4.2.0", createdTaskId: null }` を流し込む。
   - あるいは `daemon.ts` の `updateAvailable` を更新する箇所にデバッグ用の即時代入を仕込む。
2. バナー `⬆ update available: v4.1.0 → v4.2.0  (run: cmux-team self-update)` が表示されること。
3. `createdTaskId` / `updateMode === "task"` / それ以外 の 3 分岐で suffix が正しく切り替わることを確認する（3 パターン手動トグル）。

### 5.4 回帰確認

- Master / Conductors / Tasks / Journal など他セクションの描画・レイアウトに影響がないこと。
- `gap: 0` の前提が他箇所に影響していないこと（今回は column の子要素を 1 つ減らすだけなので影響範囲は限定的）。

## 6. リスク・注意点

- **TypeScript narrowing**: 外側の `daemon.updateAvailable ? ... : ...` で truthy 判定後、IIFE 内で `const ua = daemon.updateAvailable` とすると TS が再評価時に null に戻す可能性があるため、`daemon.updateAvailable!` の non-null assertion か、IIFE 内で再度 `if (!ua) return ...` を残すかのどちらかが必要。前者を採用する（元コードの動作と等価）。
- **コメント文言**: T187 の来歴を残すため `// Update 通知バナー（T187）` は保持する。T282 の記述を追記するかは任意（本修正では最小差分とするため追記しない）。
- **他の空 text 要素の扱い**: `dashboard.tsx` 内の他の箇所で同様の「null 時に空 text を返す」パターンがないかは今回スコープ外。T282 は本箇所のみを対象とする。
- **ランタイム影響**: `ui.column` に渡す配列長が状態により 1 変動するが、`gap: 0` のため視覚的影響は「行が詰まる／詰まらない」のみ。再レンダリング頻度・パフォーマンスへの追加負荷はない。
- **テストの自動化**: 本プロジェクトには TUI の自動スナップショットテストは存在しないため、確認は手動目視となる（既知の制約）。
