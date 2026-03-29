---
id: 010
title: Phase 2: Manager テンプレート — Conductor 監視フォールバックを list-status に置換
priority: medium
created_at: 2026-03-29T06:42:54.306Z
---

## タスク
## 対象ファイル
- skills/cmux-team/templates/manager.md

## 変更内容
§3 Conductor 監視のフォールバック判定を list-status ベースに変更。

現状 Manager は done マーカーが主要判定。read-screen はフォールバック:
```bash
SCREEN=$(cmux read-screen --surface surface:N --lines 10 2>&1)
# ❯ あり AND esc to interrupt なし → 完了（アイドル状態）
```

置換後:
```bash
WS=$(cmux identify --surface surface:N 2>/dev/null | jq -r '.caller.workspace_ref')
STATE=$(cmux list-status --workspace "$WS" | grep '^claude_code=\|^c[0-9]*=' | ...)
```

## 変更量
小規模。フォールバック部分のコードスニペット1箇所のみ。
