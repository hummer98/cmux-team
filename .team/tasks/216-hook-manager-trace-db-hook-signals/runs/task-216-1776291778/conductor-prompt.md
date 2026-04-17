# タスク割り当て

## タスク内容

---
id: 216
title: hook全送信設計への統合: CLAUDE.md更新 + Managerフィルタ移設 + trace DB hook_signals
priority: medium
created_at: 2026-04-15T17:42:37.411Z
---

## 背景
hookシグナルはすべてManagerに送信し、フィルタリングはManager側で行う設計思想が実装と乖離している。
現状：Conductorのhookが SessionEnd "other" を送信していない（hook側でフィルタ）。

本タスクでは **設計思想のドキュメント化と実装を 1 PR にまとめる**。分離すると merge 順序で docs と実装が一時乖離するため統合（T215 を畳んだ）。

## やること（セット実装 — 全部 1 PR）

### 0. CLAUDE.md 更新（旧 T215）
- 「hookは全イベントをManagerに転送する。フィルタリングはManager側でのみ行う」を明記
- 衝突する既存の文言（hookのmatcher設計など）があれば削除
- 対象セクション：「Manager プロトコル」「通信プロトコル」あたり
- 実装（下記 1-4）と同じコミット or 同じ PR に含めること

### 1. Conductor settings.json の修正（main.ts: generateConductorSettings）
SessionEnd に "other" matcherを追加し SESSION_ENDED を送信するようにする:
```
{ matcher: "logout|prompt_input_exit|other", ... → SESSION_ENDED }
```
※ 現在 "clear" は SESSION_CLEAR を送っているので分離維持

### 2. trace DB に hook_signals テーブル追加（trace-store.ts）
handleMessage の入口（フィルタ前）で全シグナルを記録するテーブル:
- id, timestamp, type, surface, pid, reason, source, question, payload_json（その他フィールドをJSONで保存）

### 3. daemon.ts handleMessage の入口で全シグナルを記録
handleMessageの先頭で insertHookSignal を呼ぶ（caseに入る前）

### 4. Manager側の "other" 処理
SESSION_ENDED case で reason=other を受け取ったとき state更新はしない（記録だけして return/break）

## 依存
なし（独立タスク）

## 備考
- 旧 T215（CLAUDE.md のみ）はこのタスクに畳み込み、削除済み
- 後続 T217（trace-hooks CLI）と T218（investigate スキル）は本タスク完了後に実行


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-216-1776291778` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-216-1776291778
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-216-1776291778/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/216-hook-manager-trace-db-hook-signals/runs/task-216-1776291778
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/216-hook-manager-trace-db-hook-signals/runs/task-216-1776291778/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
