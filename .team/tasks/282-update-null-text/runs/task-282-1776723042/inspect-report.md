# Inspection Report: T282

## 判定: GO

## 確認項目
- [x] plan.md 通りの修正が行われている
- [x] null 経路で空 text が混入しない
- [x] 型チェック成功
- [x] 副作用なし
- [x] CLAUDE.md ガイドライン遵守

## コメント

### plan.md との整合

`skills/cmux-team/manager/dashboard.tsx:1163-1180` の実装は plan.md の「基本方針（案 A）」および「具体的な編集差分（概念）」と完全に一致。

- IIFE を配列 spread (`...(cond ? [IIFE] : [])`) に置き換え済み。
- 内部 IIFE で `const ua = daemon.updateAvailable!;` の non-null assertion を使用しており、plan.md §6 の narrowing 方針通り。
- コメント `// Update 通知バナー（T187）— updateAvailable が非 null のときのみ挿入` が plan.md §4 通り保持+追記されている。
- 3 分岐の suffix ロジック（`createdTaskId` / `updateMode === "task"` / それ以外）は保持されており、非 null 時の挙動は従来と等価。

### null 経路

`daemon.updateAvailable` が null/undefined のとき `...[]` で要素自体が配列から消えるため、`ui.column({ gap: 0 }, [...])` 内に空 text 要素が残らない。ヘッダー直下の空白行が解消される構造。修正前の `ui.text("", { dim: true })` による 1 行占有は完全に消滅。

### 型チェック

`cd skills/cmux-team/manager && bunx tsc --noEmit` の結果:

- dashboard.tsx 起因のエラー: **0 件**
- 既存エラー 3 件（`conductor.ts(197,3)` / `daemon.test.ts(3720,9)` / `daemon.ts(1538,22)`）は `git stash` で本修正を退避した状態でも同一内容で検出されるため、T282 以前から存在する別件。本タスクのスコープ外で問題なし。

### 副作用 / 他機能への影響

- 変更は `dashboard.tsx` の 1 箇所のみ。他の UI セクション（Master / Conductors / Tasks / Journal）の描画ロジックは一切触れていない。
- `ui.column` の子要素数が null 時に 1 減るだけで、他セクションのレイアウト前提（`gap: 0` など）には影響しない。
- 追加の lint エラー・runtime エラーは発生しない。

### CLAUDE.md ガイドライン遵守

- プロンプト編集ルール: テンプレート (`skills/cmux-team/templates/*.md`) およびランタイムプロンプト (`.team/prompts/*.md`) への直接編集はなし。
- EventBus / ロギングポリシー: 今回は UI 表示の条件付き描画のみで該当しない。
- コーディング規約: コメントは日本語、識別子は英語、最小差分の原則に従っている。

### 備考（参考情報、NOGO 理由ではない）

- `package-lock.json` に `"version": "4.0.0" → "4.1.0"` の 2 行差分が出ている。これは直前の `033c748 chore: release v4.1.0` に伴う npm install 時の同期で、本タスクとは直接関係しない。コミットに含めるかどうかは Conductor の判断で良い（問題なし）。
- TUI 自動スナップショットテストが存在しないため目視確認は残課題。impl-report.md に記載済み。

## Fix Required (NOGO の場合)

なし（GO 判定）。
