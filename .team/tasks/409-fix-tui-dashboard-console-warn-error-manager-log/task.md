---
id: 409
title: fix(tui): dashboard モードで console.warn/error を manager.log にリダイレクト
priority: medium
created_at: 2026-05-01T05:30:46.137Z
---

## タスク
## 背景

Manager TUI (dashboard.tsx, ink-based) が描画している裏で daemon hot path から console.warn/error が呼ばれると stderr に直書きされ、TUI の描画バッファを貫通して画面の任意の行に残骸として現れる。

実際に観測された症状 (surface:6 Manager TUI):
```
○ [584] idle [    e     e             _          u       type=POST_TOOL_USE size=174044
```

`type=POST_TOOL_USE size=174044` は trace-store.ts:480 の hook_signal_payload_truncated warn の出力そのもの。Conductor 行のレンダリング自体は dashboard.tsx:729-736 で `○ [584] idle` のみ描画しているはずが、後ろに stderr 経由の warn が混入している。

console.warn / console.error は本リポジトリ内に 130 箇所あり、新規追加されたものが TUI を汚す regression を再生産しないよう、根本的に dashboard モードで redirect する方針 (C 案) で対応する。

A 案 (個別書き換え) と B 案 (stderr 全 redirect) は採らない。理由:
- A: 将来追加される console.warn を漏らすリスクが高い
- B: 開発時の stderr デバッグが完全に潰れる

## スコープ

### 1. logger.ts に warn / error を追加

```ts
export async function warn(event: string, detail: string = ""): Promise<void>
export async function error(event: string, detail: string = ""): Promise<void>
```

- 既存 `log()` と同形式で manager.log に append
- 行頭タグで区別: `[warn]` / `[error]` prefix を timestamp の後に挿入
- log() / warn() / error() の三者が同じ append 経路 (mkdir + appendFile) を共有 — できれば内部 helper にリファクタ

### 2. dashboard 起動時に console をすり替え

dashboard.tsx の startDashboard 等のエントリーポイントで:

```ts
const origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  void logger.warn("console_warn", args.map(String).join(" "));
};
const origError = console.error;
console.error = (...args: unknown[]) => {
  void logger.error("console_error", args.map(String).join(" "));
};
```

- すり替え解除は不要 (dashboard プロセスは exit 時に消える)
- すり替えタイミングは ink renderer 起動 **直前** (renderer 起動後に呼ばれた warn が漏れないよう)
- すり替え範囲は dashboard モード (cmux-team status の TUI モード) のみ — CLI 一発呼び出し系は従来通り stderr 出力を維持

### 3. すり替え対象の確認

- 130 箇所の console.warn / console.error が現状の挙動 (stderr 出力) ではなく manager.log への追記に切り替わることをテストで担保
- 特に hot path の以下が dashboard モードで manager.log に出ることを確認:
  - trace-store.ts:480 hook_signal_payload_truncated
  - trace-store.ts:246 / 295 / 333 / 369 各 _migrated 系

### 4. テスト

- dashboard 起動状態で `console.warn("test")` を呼び、manager.log に [warn] 行が追記されることを確認
- 同条件で stderr が空であることを確認 (capture stream で検証)
- CLI 一発呼び出し (token list 等の非 dashboard モード) では従来通り stderr に warn が出ることを確認 (regression)

### 5. スコープ外

- 130 箇所の console.* を個別に logger.warn() / logger.error() に書き換える作業 — monkey-patch で十分なので不要
- log() / warn() / error() の serialization 順序保証 (現状の log() も非同期 append なので保証なし、既存挙動維持)

## 受け入れ条件

- Manager TUI で大きな payload の hook 受信時に `type=POST_TOOL_USE size=NNNN` が画面に残骸として現れない (T407 follow-up の TUI で再現確認)
- manager.log に [warn] / [error] prefix の行が追記される (truncate イベント等で実測確認)
- 既存の log() の挙動は変更されない (regression: 既存 manager.log 行のフォーマット維持)
- CLI 一発呼び出しモードでは console.warn が従来通り stderr に出る (token / metrics / trace-task 等)

## 関連

- T407 (b3d4734): 当該 TUI 残骸を発見した親作業 (Conductor 行に warn 文字列が混入)
