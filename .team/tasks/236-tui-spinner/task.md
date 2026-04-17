---
id: 236
title: TUI: サブエージェント行に Spinner を実装する
priority: medium
created_at: 2026-04-17T02:20:18.106Z
---

## タスク
## 目的

TUI ダッシュボードの Agent サブツリー（`dashboard.tsx:489-511` 付近）は、現状 role アイコン（⚙ 📝 🔍 など）を固定表示するだけで、Agent が running か idle か一見わからない。Conductor/Master と同様に Spinner を追加し、稼働状況を視覚的に判別できるようにする。

## 現状

- `buildConductorRow` の `agents` ループでは `ui.text(\`${icon} ${label}\`)` を描画しているだけ（`dashboard.tsx:489-511`）
- Conductor 側は `status === "starting" | "assigning" | "running"` で `SPINNER_FRAMES[spinnerFrame % ...]` を描画している（`dashboard.tsx:361, 396, 407, 477`）
- `AgentState`（`schema.ts:148-156`）には `status` フィールドが存在しない
- Agent の生存追跡は PID ベース + hook（SESSION_STARTED / SESSION_IDLE / SESSION_CLEAR / SESSION_ENDED）で行われている（daemon.ts / conductor.ts を参照）

## 実装方針

1. **AgentState に `status` を追加**
   - 候補: `"starting" | "running" | "idle"`（終了時は state から削除される想定）
   - hook プッシュ（`SESSION_STARTED` / `SESSION_IDLE` / `SESSION_CLEAR`）を受けて daemon 側で更新
   - 既存の Agent ライフサイクル（spawn-agent, kill-agent, PID watcher）と整合させる
2. **dashboard.tsx の Agent 描画を更新**
   - status === "running" のときは role アイコンの代わりに（または隣に）Spinner フレームを描画
   - idle のときは dim 表示、もしくはアイコンのみに戻す
   - `buildConductorsSection` 経由で `spinnerFrame` を `buildConductorRow` → Agent ループまで伝搬する
3. **アニメーション条件を更新**
   - `spinnerInterval` の `needsAnimation` 判定に「稼働中 Agent あり」を追加（現状は Conductor の status のみ見ている想定。実コードを確認すること）

## 調査事項

- 既存の hook push ルート（`daemon.ts:handleMessage` 付近）で Agent surface 向けのシグナルがどう扱われているか確認
- PID watcher が Agent の idle 状態を直接検知しているわけではない点に注意（PID は生きたまま idle になる）
- `cmux-team spawn-agent` / `kill-agent` 経由で Agent が登録・削除されるタイミングと、status 初期値（`starting` で良いか）を確認
- done マーカー（`.team/output/<taskRunId>/done`）を基準にしている Conductor と違い、Agent は completion を明示的に通知しないケースもある — 方針を決める

## 検証

- `cmux-team start` → `cmux-team spawn-agent` で Agent を起動し、running 中は Spinner が回り、idle になると止まること
- Conductor が running 中に Agent も running の場合、両方の Spinner が同期して回ること
- Agent 終了時（kill-agent / SESSION_ENDED）に行が正しく消えること

## 非対象

- Agent の status に基づいたタスク割り当てロジックの変更（TUI 表示のみ）
- Agent の完了検知の根本改修（本タスクでは既存シグナルの範囲で判定する）
