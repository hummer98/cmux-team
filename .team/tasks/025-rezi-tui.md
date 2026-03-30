---
id: 025
title: Rezi TUI: スクロール実装 + 実動作テスト
priority: high
created_at: 2026-03-29T14:18:19.206Z
---

## タスク
## 目的
dashboard-rezi.tsx にタスク一覧・ジャーナルのマウススクロールを実装し、実際に TUI を表示して動作確認する。

## スコープ

### 1. スクロール実装
- Tasks セクション: タスクが多い場合にマウスホイールでスクロール可能にする
- Journal タブ: ジャーナルエントリのマウスホイールスクロール
- Log タブ: ログ行のマウスホイールスクロール
- Rezi の ui.logsConsole や ui.virtualList 等、スクロール対応ウィジェットを活用

### 2. 実動作テスト
- main.ts の startDashboard import を dashboard-rezi.tsx に差し替えて起動テスト
- `cmux-team stop && cmux-team start` で再起動して TUI が表示されることを確認
- マウスクリックでタブ切替ができることを確認
- マウスホイールでスクロールできることを確認
- 表示が崩れないか確認（日本語タスク名、長いタイトルなど）

### 3. 切り替え方法
main.ts 内で dashboard の import を変更:
```typescript
// 変更前
import { startDashboard, unmountDashboard } from './dashboard';
// 変更後
import { startDashboard, unmountDashboard } from './dashboard-rezi';
```

## 注意
- 既存の dashboard.tsx は削除しない（フォールバック用に残す）
- 動作しない場合は Ink 版に戻して、何が問題だったかレポート
- Rezi のドキュメント（https://rezitui.dev/docs）を参照して正しい API を使うこと
