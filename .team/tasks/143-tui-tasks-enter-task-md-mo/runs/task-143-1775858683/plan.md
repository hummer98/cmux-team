# 実装計画: TUI Tasks パネル Enter キーで task.md を開く (T143)

## 現状分析

### 既に実装済みの部分
- **Enter キーハンドラ** (`dashboard.tsx:1082-1098`): Tasks パネルで Enter 押下時に `openArtifactInViewer()` を呼ぶ処理は既存
- **`openArtifactInViewer()`** (`dashboard.tsx:746-783`): TUI 停止 → ビューア起動 → TUI 再開のライフサイクル管理は既存
- **TaskSummary.filePath** (`daemon.ts:33`): task.md のパスが正しく渡されている（`task.ts:138` でディレクトリ型タスクの場合 `{dir}/task.md` のパスが設定される）

### 修正が必要な部分
`resolveMarkdownViewer()` の実装が2箇所で不一致:

| 場所 | 環境変数 | デフォルト | フォールバック |
|------|---------|-----------|--------------|
| `dashboard.tsx:115-124` | `CMUX_MD_VIEWER` | `glow` | `cat` |
| `main.ts:1877-1886` | `CMUX_TEAM_MD_VIEWER` | `mo` | `cat` |
| **タスク仕様** | `CMUX_TEAM_MD_VIEWER` | `mo` | `cat` |

## 実装ステップ

### Step 1: 共通ビューア解決ユーティリティの作成
- `dashboard.tsx` 内の `resolveMarkdownViewer()` を修正して仕様に統一
  - 環境変数: `CMUX_TEAM_MD_VIEWER`
  - デフォルト: `mo`
  - フォールバック: `cat`
- この関数を `export` して `main.ts` から再利用可能にする

### Step 2: `main.ts` のインライン実装を共通関数に置き換え
- `main.ts:1877-1886` のインラインビューア解決ロジックを削除
- `dashboard.tsx` から `resolveMarkdownViewer` を import して使用

### Step 3: ビルド確認
- `bun build` または型チェックで問題がないことを確認

## 変更ファイル
1. `skills/cmux-team/manager/dashboard.tsx` — `resolveMarkdownViewer()` の修正・export
2. `skills/cmux-team/manager/main.ts` — 共通関数の import・使用

## リスク
- なし（既存の Enter キーハンドラは動作済み、ビューア解決ロジックの統一のみ）
