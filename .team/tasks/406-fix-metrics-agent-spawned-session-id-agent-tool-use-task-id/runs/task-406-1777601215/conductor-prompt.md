# タスク割り当て

## タスク内容

---
id: 406
title: fix(metrics): agent_spawned の session_id 空で Agent 由来 tool_use が task_id 未解決
priority: medium
created_at: 2026-05-01T02:06:55.201Z
---

## タスク
## 背景

issue #48 (denormalised tool_uses table in traceDB) の起票前事前調査で発見した、T379 由来の **既存バグ**。issue #48 本体（denorm 化）に取り掛かる前に、session→task 解決経路を信頼できる状態にしておくため先行で修正する。

調査詳細は本会話のサブエージェント調査結果（後で artifact 化予定）参照。

## 事実

- `task_sessions` の `event='agent_spawned'` 行は `session_id=""` で書かれ、後追い update も行われない (`skills/cmux-team/manager/main.ts:3068` 付近、`agent_spawned` 597 件すべて session_id 空を実測)
- ただし `agent_spawned` 行の `task_id` 列自体は埋まっている (`main.ts:3066`)
- Agent 自身は SESSION_STARTED hook で session_id を確定させているが、その値はどの `task_sessions` 行とも紐付かない

## 影響

`trace-store.ts` の以下 3 関数の集計から **Agent 由来の tool_use が全件抜ける**（task_id=NULL に倒れて unattached 扱い）：

- `countToolCallsByTask`
- `firstEditPerTask`
- `failureRateByTask`

共通する `WITH session_to_task AS (... WHERE event='assigned' AND task_id IS NOT NULL)` CTE が Conductor の assigned 行しか拾えていないのが直接原因。

## 修正方針の選択肢

事前調査で出した 3 案：

- **(i)** Agent SESSION_STARTED 受信時に対応する agent_spawned 行を update して session_id を埋める。CTE 条件を `event IN ('assigned','agent_spawned')` に拡張
- **(ii)** hook 受信時に `surface → state.conductors → taskId` 直接 lookup helper を切り出して `task_uses` 等の denorm 列に書き込む（T403 と共通化）
- **(iii)** daemon tick で backfill ジョブ

**推奨**: (i) + (ii) のハイブリッド。
- (i) は task_sessions のセマンティクスを正常化し、既存 3 関数の bug を最小差分で fix できる
- (ii) は T403 (api_usage.task_id 全件 NULL) と共通の `resolveTaskIdBySurface(state, surface, role)` 系 pure read helper を切り出し、issue #48 (T404 候補) で再利用可能にする

## スコープ

1. `agent_spawned` 行への session_id 書き込み経路を main.ts に追加（SESSION_STARTED ハンドラから対応する agent_spawned 行を UPDATE）
2. `trace-store.ts` の `WITH session_to_task` CTE 3 箇所を `event IN ('assigned','agent_spawned')` に拡張
3. 既存データに対する一回限りの backfill（fresh DB では不要だが、稼働中 DB では fresh hook 到来時から正しく解決されるので backfill 必須ではない — judgment 任せ）
4. 上記 3 関数のテストに Agent 由来 tool_use のフィクスチャを追加

T403 との共通 helper（`resolveTaskIdBySurface`）の切り出しは **本タスクスコープ外**。本タスクは task_sessions の正常化だけに閉じる。共通 helper は T403 / issue #48 タスクで扱う。

## 関連

- issue #48: https://github.com/.../issues/48 (denormalised tool_uses table)
- T403: api_usage.task_id 全件 NULL の調査・修正（症状は別だが解決経路で helper 共有しうる）
- T379: 当該 3 関数を追加した親タスク

## 受け入れ条件

- 新規 hook 到来時、Agent 由来 tool_use の task_id が `countToolCallsByTask` で解決される
- `task_sessions` の `agent_spawned` 行に session_id が必ず埋まる（テストで担保）
- 既存 3 関数のテストが Agent 由来フィクスチャを含み green


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-406-1777601215` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-406-1777601215
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-406-1777601215/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/406-fix-metrics-agent-spawned-session-id-agent-tool-use-task-id/runs/task-406-1777601215
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/406-fix-metrics-agent-spawned-session-id-agent-tool-use-task-id/runs/task-406-1777601215/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
