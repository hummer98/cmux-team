# タスク割り当て

## タスク内容

---
id: 196
title: dashboard: Journal の surface 表記を [surface:53] から [53] に修正
priority: medium
created_at: 2026-04-14T21:39:42.538Z
---

## タスク
# 背景

TUI ダッシュボードの Journal パネルで surface 表記が `[surface:53]` と冗長になっている。他のパネル（Master / Conductors / Agents 行）では全て `[53]` 形式で表示されており、Journal だけ prefix が剥がれていない。

T192 で raw log は `C[53]` 形式に統一されたが、Journal 描画の prefix 剥がし漏れは T082 (`6fb3d0e`, 2026-04-05) で surface 表示を追加した時点からのバグ。T192 で仕様化された表記ポリシー（CLAUDE.md「ロギングポリシー §surface 表記」）と不整合。

## 修正箇所（1 行）

**ファイル**: `skills/cmux-team/manager/dashboard.tsx:668`

**現状**:

```tsx
entry.surface ? ui.text(`[${entry.surface}]`, { dim: true }) : null,
```

**修正後**:

```tsx
entry.surface ? ui.text(`[${entry.surface.replace("surface:", "")}]`, { dim: true }) : null,
```

他の箇所（L405, L442, L453, L461, L476, L504, L515, L541）と同じパターンに揃える。

## 補足: extractSurface() の仕様

`extractSurface()`（L289-295）は後方互換のため内部的に `surface:NNN` 形式を維持している。これは変更しない — 影響範囲を最小にするため。JournalEntry.surface を使う箇所は L668 のみなので、そこだけ prefix を剥がせば済む。

## 受け入れ基準

- `cmux-team start` 起動後、Journal パネルに表示される surface が `[53]` / `[54]` / `[55]` 形式になる（`[surface:53]` ではない）
- Master / Conductors / Agents 行の surface 表記は従来通り `[NN]` 形式のまま（回帰無し）
- 既存テスト green

## テスト

`dashboard.test.ts` もしくは `logger.test.ts` に `extractSurface` と Journal 描画のテストがあれば、冗長 prefix が剥がれていることを確認するアサーションを追加する。無ければ追加しなくてよい（操作が自明すぎて ROI 低い）。

## 参考

- CLAUDE.md「ロギングポリシー §surface 表記」
- T082 (`6fb3d0e`) — 該当行の導入コミット
- T192 (`7ee6ee2`) — surface 表記統一のコミット

## 実装ポリシー（重要）

この修正は **1 行の trivial fix** である:

- **サブエージェントは spawn しない**（Researcher / Planner / Implementer / Inspector いずれも起動しない）
- Conductor 自身で Edit → TypeScript コンパイル確認 → commit → merge
- worktree 内での TDD / Plan / Inspection フェーズは不要
- tsc 通過を軽く確認したら close


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-196-1776202782` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-196-1776202782
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-196-1776202782/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/196-dashboard-journal-surface-surface-53-53/runs/task-196-1776202782
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/196-dashboard-journal-surface-surface-53-53/runs/task-196-1776202782/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
