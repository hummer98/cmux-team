---
id: 139
title: spawn-master に CMUX_CLAUDE_HOOKS_DISABLED=1 を追加
priority: high
created_at: 2026-04-10T19:55:10.654Z
---

## タスク
## 問題

`cmdLaunchMaster()` (main.ts L1006) で `CMUX_CLAUDE_HOOKS_DISABLED=1` が設定されていないため、Master の claude プロセスが cmux ラッパー経由で起動された際に Notification hooks が注入され、cmux 通知がバンバン飛ぶ。

Conductor（L886）、resume（L970）、spawn-agent（L1117）には設定済みだが、spawn-master だけ漏れている。

## 修正

main.ts の `cmdLaunchMaster()` 内、L1014 の後に1行追加:

```typescript
process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1";
```

他の起動コマンド（conductor, resume, spawn-agent）と同じパターンに揃える。
