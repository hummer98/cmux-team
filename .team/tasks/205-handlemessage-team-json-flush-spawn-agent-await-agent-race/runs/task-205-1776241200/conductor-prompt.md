# タスク割り当て

## タスク内容

---
id: 205
title: handleMessage 後に team.json を同期 flush して spawn-agent→await-agent race を解消
priority: medium
created_at: 2026-04-15T06:58:05.412Z
---

## タスク
## 背景

`cmux-team spawn-agent` 直後に Conductor が `cmux-team await-agent --surface <agent-surface>` を実行すると、`Error: agent surface surface:NNN not registered in team.json` で exit 1 することがある。

### 発生フロー

```
spawn-agent CLI
 ├─ POST /api/messages {AGENT_SPAWNED}
 │   └─ daemon: handleMessage → state.conductors[i].agents.push(...)
 │       ※ updateTeamJson は呼ばない
 ├─ 200 OK → CLI 出力 SURFACE=surface:NNN
Conductor 即座に
 └─ await-agent --surface surface:NNN
     └─ team.json を read → conductors[].agents に入ってない → Error
                                         ↓
                   （この後の tick で updateTeamJson が走り反映される）
```

原因:
- `daemon.ts:640-663` の `tick()` は `updateTeamJson` を呼ばない
- `main.ts:649` のメインループが tick 後に `updateTeamJson` を呼ぶだけ
- したがって handleMessage 内で state を変えても team.json への flush は次ループまで遅延する
- `proxy.ts:229` で `onMessage` が完了すると即 200 OK を返すため、CLI 側から見ると「OK が返ったのに team.json が古い」状態が発生する

### 実例（2026-04-15 C[133] / KDG のレース再現）

- `15:37:08 agent_spawned C[133]>A[172]` （manager.log）
- ほぼ同タイミングで Conductor が `cmux-team await-agent --surface surface:172` 実行
- `EC=1 Error: agent surface surface:172 not registered in team.json`
- 以降 planner が回復不能になり 16 分以上 Photosynthesizing に張り付く

## やること

### main.ts の onMessage 直後に team.json を同期 flush

`skills/cmux-team/manager/main.ts:343` 付近（`startProxy` の `onMessage` オプション）を変更:

```typescript
onMessage: async (msg) => {
  await handleMessage(state, msg);
  await updateTeamJson(state);   // ← 追加
},
```

これにより不変条件 **「`cmux-team send X` が 200 OK を返した時点で team.json は最新」** が成立する。

### 確認ポイント

- tick ループの `updateTeamJson`（main.ts:649）は残して良い（冗長だが定期再同期として機能）
- `handleMessage` 内の個別 `notifyStateChanged(...)` は TUI refresh 用なので触らない
- `updateTeamJson` は `daemon.ts:1556` で export 済み・`main.ts:30` で import 済みのため追加 import 不要
- 書き込み先は `.team/team.json`。hook/CLI メッセージ頻度は低いので fsync コストは無視できる

## やらないこと

- `daemon.ts` の tick() 内に `updateTeamJson` を追加するような多重化はしない（onMessage 後で十分）
- `await-agent` 側のリトライ実装（A が入れば不要）
- `/api/agents/:surface` のような新規 HTTP endpoint 追加（過剰）
- team.json の廃止・状態を全部 HTTP 化（過剰、射程外）

## テスト計画

1. **ユニット相当の手動確認**
   - `cmux-team start` で daemon 起動
   - Conductor 内から `cmux-team spawn-agent --conductor-surface <self> --role planner --prompt "echo test"` を実行
   - 直後に `jq '.conductors[].agents' .team/team.json` で agent が即座に反映されていることを確認
   - 続けて `cmux-team await-agent --surface <spawned-surface> --timeout 60` が `not registered` エラーにならないこと

2. **E2E**
   - KDG リポで T203 や通常タスクを流し、C[x] が planner/impl Agent を spawn → await-agent が成功することを確認
   - manager.log に `agent_spawned` と同時刻に `cmux-team await-agent` 実行しても失敗しないこと

3. **リグレッション**
   - `cmux-team status` / `cmux-team resume` / `cmux-team restart-task` など team.json を読む系 CLI が従来通り動作すること
   - TUI ダッシュボードの更新タイミングに変化がないこと（notifyStateChanged 経路は無変更）

## 参考ファイル

- `skills/cmux-team/manager/main.ts:343` — onMessage ハンドラ（変更箇所）
- `skills/cmux-team/manager/main.ts:649` — tick ループの updateTeamJson（残す）
- `skills/cmux-team/manager/daemon.ts:665` — handleMessage 本体
- `skills/cmux-team/manager/daemon.ts:724-740` — AGENT_SPAWNED case
- `skills/cmux-team/manager/daemon.ts:1556` — updateTeamJson 定義
- `skills/cmux-team/manager/proxy.ts:222-234` — onMessage 呼び出し（200 OK 返却点）
- `skills/cmux-team/manager/main.ts:2163-2200 cmdAwaitAgent` — race の被害側
- `skills/cmux-team/manager/main.ts:2285 findConductorSurfaceForAgent` — team.json を read する箇所


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-205-1776241200` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-205-1776241200
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-205-1776241200/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/205-handlemessage-team-json-flush-spawn-agent-await-agent-race/runs/task-205-1776241200
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/205-handlemessage-team-json-flush-spawn-agent-await-agent-race/runs/task-205-1776241200/summary.md` に書き出す。

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
