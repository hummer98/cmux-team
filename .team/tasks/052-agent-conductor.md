---
id: 052
title: Agent完了時にConductorツリーから削除されない問題の修正
priority: high
created_at: 2026-04-03T02:16:04.776Z
---

## タスク
## 概要

サブエージェントが完了（SESSION_ENDED）またはsurface closeされても、ConductorのTUIツリーから削除されない。

## 原因

`cmux-team kill-agent` の `cmdKillAgent()` は `cmux.closeSurface()` でsurfaceをkillするだけで、daemon に SESSION_ENDED を通知していない。コメントには「SESSION_ENDED が自動発火し daemon が agents から削除する」と書いてあるが実装されていない。

### 該当コード

`main.ts:694`:
```typescript
async function cmdKillAgent(): Promise<void> {
  const surface = requireArg('surface');
  // surface を閉じる（SESSION_ENDED が自動発火し daemon が agents から削除する）
  await cmux.closeSurface(surface);  // ← SESSION_ENDED を送信していない
}
```

`cmux.ts:72`:
```typescript
export async function closeSurface(surface: string): Promise<void> {
  await execFile('cmux', ['close-surface', '--surface', surface]).catch(() => {});
  // SESSION_ENDED を送信しない
}
```

## 修正方針（2層防御）

### 1. cmdKillAgent で SESSION_ENDED を daemon に通知（push型）

`cmdKillAgent()` 内で closeSurface 後に SESSION_ENDED メッセージを daemon のキューに送信する。これにより `cmux-team kill-agent` 経由の正常系は即座に削除される。

### 2. Agent surface の定期生存チェック（pull型）

`monitorConductors()` 内で agent surface の `validateSurface()` を定期チェック。消失したら `conductor.agents` から削除する。これにより surface が外部から閉じられた場合（tmux quit等）にも対応。

設計原則「上位が下位を監視する（pull型）」に合致。

### 対象ファイル

- `skills/cmux-team/manager/main.ts` — cmdKillAgent() に SESSION_ENDED 送信追加
- `skills/cmux-team/manager/daemon.ts` — monitorConductors() に agent surface 生存チェック追加
- `skills/cmux-team/manager/cmux.ts` — closeSurface のコメント修正（自動発火しないことを明記）
