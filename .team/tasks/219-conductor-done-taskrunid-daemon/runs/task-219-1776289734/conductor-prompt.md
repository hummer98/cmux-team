# タスク割り当て

## タスク内容

---
id: 219
title: CONDUCTOR_DONE に taskRunId を付与し daemon で一致検証する
priority: medium
created_at: 2026-04-15T17:55:37.252Z
---

## 目的

surface ベースでタスクを暗黙的に紐付けている daemon メッセージハンドラに対して、**taskRunId (または sessionId) による一致検証** を導入し、stale signal による誤処理を構造的に遮断する。

現状の daemon は、Conductor surface から `state.conductors` を逆引きして「今その surface にアサインされているタスク」を操作するだけで、メッセージがどのタスクの完了通知かを区別できない。そのため遅延配送・daemon 再起動・二重送信などで、前タスクのシグナルが次タスク時代に届くと誤処理される。

## 背景となる事故（2026-04-16 02:05）

T212 の Conductor が完了プロトコルで CONDUCTOR_DONE を 2 回送る実装になっており（T214 で二重送信自体は解消済み）、2 通目が T213 assigned 後の C[231] に届いた。daemon は T213 の完了と誤認して resetConductor を実行、task-state.json と in-memory daemon state と実体の 3 層が乖離した。

T214 で直接原因は断たれたが、同じ構造問題は他のメッセージ (SESSION_CLEAR / SESSION_STARTED) にも存在している。本タスクで 3 種まとめて防御層を追加する。

## 対象メッセージ (3 箇所)

### ① CONDUCTOR_DONE (`daemon.ts:715-746`)

**問題**: surface から conductor を拾って `handleConductorDone` → `resetConductor` を実行。destructive (worktree 削除 / task close フロー)。

**影響度**: 高。T213 事故の直接原因。

### ② SESSION_CLEAR (`daemon.ts:1117-1155`)

**問題**: `conductor.status === "running"` のとき、`conductor.taskId` を拾って task-state.json を `aborted` に書き換え、`resetConductor` を呼ぶ。CONDUCTOR_DONE と同等の destructive な挙動。

**影響度**: 高。ユーザー手動 /clear の hook が遅延配送されると次タスクが誤って aborted になる。

```typescript
if (conductor && conductor.status === "running") {
  const taskId = conductor.taskId;  // ← surface から拾った「今のタスク」
  if (taskId) {
    ts[taskId] = { ...current, status: "aborted", ... };
  }
  await resetConductor(conductor, ...);
}
```

### ③ SESSION_STARTED T203 branch (`daemon.ts:798-824`)

**問題**: `conductor.taskId` を拾って task-state.json の `sessionId` フィールドを上書きする。stale の場合、前タスクの sessionId が新タスクの task-state に書き込まれる → daemon 再起動時の resume で wrong session を掴む。

**影響度**: 中。resume 系に影響。/clear の hook 遅延は実際に 17 秒程度発生することが観測されている (T213 事故のログ参照)。

```typescript
if (message.sessionId && prevSessionId !== message.sessionId && conductor.taskId) {
  ts[conductor.taskId] = { ...cur, sessionId: message.sessionId };
}
```

## やること

### 1. Schema 追加: `schema.ts`

3 つのメッセージの zod schema に検証用フィールドを optional で追加する（旧クライアント互換のため必須にしない）。

```ts
// ConductorDoneMessage
taskRunId: z.string().optional(),

// SessionClearMessage
taskRunId: z.string().optional(),

// SessionStartedMessage  既に sessionId を持っているので追加変更はなし
// (T203 branch 側の検証は prevSessionId 比較と `source` フィールドを使う)
```

### 2. 送信側: `main.ts` / hook 配布物

#### CONDUCTOR_DONE 送信箇所

`postMessage({ type: "CONDUCTOR_DONE", ... })` を呼ぶ箇所で taskRunId を添付する:

- `close-task` コマンド (`main.ts:2182-2187` 付近): `teamJson.conductors` から該当 conductor を引いて `conductor.taskRunId` を添付
- `abort-task` コマンド (`main.ts:2634-2640` 付近): 同上
- `restart-task` コマンド (`main.ts:2797-2803` 付近): 同上
- `send CONDUCTOR_DONE` サブコマンド (`main.ts:851-` 付近): CLI オプション `--task-run-id` を追加 (optional)。

#### SESSION_CLEAR 送信箇所

`.claude/hooks/` や hook 配布物で SESSION_CLEAR を送信している箇所を特定する。CMUX_TASK_RUN_ID 相当の環境変数が読めるなら付与。
hook スクリプトがプロジェクト直下の `.team/` 以下にある場合は、`cat .team/task-state.json | jq` 相当で現在の taskRunId を引いても良い。hook スクリプト側で取得困難なら T221 (別タスク) で扱う扱いとし、本タスクでは schema と daemon 側の検証ロジックだけ入れる。

#### SESSION_STARTED

現状 sessionId は既に送信されている。T203 branch で使う `prevSessionId !== message.sessionId` の比較は残したまま、**追加で `source` フィールドを活用した race 防御** を検討する。詳細は 3 項で。

### 3. 受信側: `daemon.ts`

#### CONDUCTOR_DONE ハンドラ (`daemon.ts:715-746`)

```ts
case "CONDUCTOR_DONE": {
  const conductor = findConductor(state, message.surface);
  if (!conductor) { ... break; }

  // ★ taskRunId 一致検証
  if (message.taskRunId && conductor.taskRunId && message.taskRunId !== conductor.taskRunId) {
    await log(
      "conductor_done_stale",
      `${formatSurface(conductor.surface, "C")} expected=${conductor.taskRunId} got=${message.taskRunId}`,
    );
    break;
  }

  // 以下既存処理
  await handleConductorDone(state, conductor);
}
```

#### SESSION_CLEAR ハンドラ (`daemon.ts:1117-1155`)

```ts
case "SESSION_CLEAR": {
  const conductor = findConductor(state, message.surface);
  if (conductor && conductor.status === "running") {
    // ★ taskRunId 一致検証
    if (message.taskRunId && conductor.taskRunId && message.taskRunId !== conductor.taskRunId) {
      await log(
        "session_clear_stale",
        `${formatSurface(conductor.surface, "C")} expected=${conductor.taskRunId} got=${message.taskRunId}`,
      );
      break;
    }
    // 以下既存処理 (task abort + resetConductor)
    ...
  }
}
```

hook 側で taskRunId を付与できない場合は、既存の `conductor.status === "running"` ガードのみで従来通り動く (検証は message.taskRunId があるときだけ有効化する)。

#### SESSION_STARTED T203 branch (`daemon.ts:798-824`)

sessionId 自体が race 検証の主キーになっているので、追加すべきは **task-state.json に書く前の二重チェック**:

```ts
// 既存: prevSessionId !== message.sessionId で上書き
if (message.sessionId && prevSessionId !== message.sessionId && conductor.taskId) {
  const ts = await loadTaskState(state.projectRoot);
  const cur = ts[conductor.taskId];
  // ★ task-state 側の assignedAt と conductor.startedAt が一致するか確認
  //   不一致ならこの SESSION_STARTED は別 run のもの → 書き込まない
  if (cur && cur.status === "assigned" && cur.taskRunId === conductor.taskRunId) {
    ts[conductor.taskId] = { ...cur, sessionId: message.sessionId };
    ...
  } else {
    await log(
      "task_session_update_skipped",
      `${formatSurface(message.surface, "C")} reason=taskRunId_mismatch task_id=${conductor.taskId} expected=${conductor.taskRunId} got=${cur?.taskRunId ?? "-"}`
    );
  }
}
```

### 4. 動作確認

- 通常フロー (close-task → CONDUCTOR_DONE → reset) が変わらず動くこと
- 通常フロー (assignTask → /clear → SESSION_STARTED source=clear → sessionId 更新) が変わらず動くこと
- 擬似 stale を仕込む手段があれば検証。なければ logic review のみで可
- 既存の正常系が `*_stale` ログで全て弾かれないこと (taskRunId 未添付ケースで互換維持)

## やらないこと

- `resetConductor` が Conductor Claude の実体を止めない問題（別タスク / 構造見直しが必要）
- T213 の事故復旧（別タスク / 人間判断）
- SESSION_CLEAR を送る hook スクリプト本体の改修（本タスクで触れるのは send 側の CLI / TypeScript 箇所のみ。hook スクリプトで taskRunId を取得困難なら別タスク）
- 全メッセージ共通の「stale 検証ミドルウェア」化リファクタ（将来検討）

## 完了条件

- [ ] `schema.ts` に CONDUCTOR_DONE / SESSION_CLEAR の taskRunId フィールド追加
- [ ] `main.ts` の close-task / abort-task / restart-task / send CONDUCTOR_DONE で taskRunId 添付
- [ ] `daemon.ts` の 3 つのハンドラで一致検証ロジック追加 (CONDUCTOR_DONE / SESSION_CLEAR / SESSION_STARTED T203 branch)
- [ ] 既存の正常系が壊れないこと (taskRunId 未添付メッセージが stale 扱いされない互換性)
- [ ] log フォーマット `conductor_done_stale` / `session_clear_stale` / `task_session_update_skipped` が出ること
- [ ] 実装後に PR or ローカルマージ完了


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-219-1776289734` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-219-1776289734
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-219-1776289734/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/219-conductor-done-taskrunid-daemon/runs/task-219-1776289734
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/219-conductor-done-taskrunid-daemon/runs/task-219-1776289734/summary.md` に書き出す。

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
