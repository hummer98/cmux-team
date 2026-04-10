---
id: 123
title: spawn-agent で worktree cd 後に direnv allow を実行
priority: high
created_at: 2026-04-10T06:58:27.974Z
---

## タスク
## 背景

T122 で Conductor 起動時の direnv allow 自動化を実装したが、spawn-agent（Agent 起動）側では対応漏れ。worktree 内で .envrc の OAuth トークンが引き継がれない。

## やること

`main.ts` の `cmdSpawnAgent()` 内、worktree への `cd` 後（行961-964）と Claude 起動（行966）の間に `direnv allow` を追加する。

## 対象箇所

`skills/cmux-team/manager/main.ts` 行 960-965 付近:

```typescript
// worktree ディレクトリに移動
if (worktreePath) {
  await cmux.send(surface, \`cd ${worktreePath}\n\`);
  await sleep(500);
  // ← ここに direnv allow を追加
}
```

## 実装

Conductor 側（conductor.ts）の T122 実装と同じパターンで:
- `.envrc` の存在チェックは不要（`direnv allow` は .envrc がなければ no-op）
- `cmux.send(surface, 'direnv allow 2>/dev/null\n')` + `await sleep(500)`
