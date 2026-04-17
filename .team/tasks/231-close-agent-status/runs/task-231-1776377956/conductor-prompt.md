# タスク割り当て

## タスク内容

---
id: 231
title: close-agent コマンド追加と正常完了/強制終了の status 分離
priority: high
created_at: 2026-04-16T22:18:42.902Z
---

## タスク
## 背景

現状 Conductor は Agent 終了に `kill-agent` を一律使用している。これはリカバリ用の乱暴な機能であるため、正常完了後も `agent_done status=crashed` として記録されてしまい、本物のクラッシュと区別できない。

### trace DB で確認した実態

```
SESSION_IDLE → SESSION_ENDED(kill-agent) → agent_done status=crashed  ← 正常完了なのに crashed
```

全 Agent 終了が crashed に見えるため、proxy 瞬断等の本物のクラッシュがログに埋もれている。

## 方針

通常完了と強制終了でシグナルを分離する。

| ケース | コマンド | reason | status |
|--------|---------|--------|--------|
| 正常完了（Agent が idle になった） | **close-agent**（新規） | close-agent | **completed** |
| 強制終了（エラー・リカバリ） | kill-agent（既存） | kill-agent | crashed |

## 変更対象

### S1. `close-agent` サブコマンド追加（`main.ts`）

- `cmdKillAgent`（`main.ts:2055`）をほぼコピーして `cmdCloseAgent` を作成
- 変更点: `reason: "kill-agent"` → `reason: "close-agent"`
- 追加: `case "close-agent": await cmdCloseAgent();`（`main.ts:3618` 付近）
- help 文字列追加（i18n）

### S2. daemon ハンドラを分岐（`daemon.ts:1000`）

```ts
// 変更前
await writeAgentDone(..., { status: "crashed", reason: message.reason ?? "session_end" });

// 変更後
const agentStatus = message.reason === "close-agent" ? "completed" : "crashed";
await writeAgentDone(..., { status: agentStatus, reason: message.reason ?? "session_end" });
```

- `agent_done` ログも `status=completed` / `status=crashed` で分岐して出力

### S3. テンプレート更新（`templates/ja/conductor-role.md`, `templates/en/conductor-role.md`）

現状 `kill-agent` を使っている箇所を用途別に書き換え:

| 用途 | 変更前 | 変更後 |
|------|--------|--------|
| Agent が idle → 正常完了後の終了 | kill-agent | **close-agent** |
| エラー・タイムアウト・異常時の強制終了 | kill-agent | kill-agent（そのまま） |

該当箇所:
- `ja/conductor-role.md:329`（await-agent 後の通常終了）
- `en/conductor-role.md:281`（同上）
- `ja/conductor-role.md:489`, `en/conductor-role.md:441`（禁止事項の説明文） — 「終了は kill-agent」→「正常終了は close-agent、強制終了は kill-agent」に修正

### S4. テンプレート更新（`templates/ja/conductor.md`, `templates/en/conductor.md`）

- `conductor.md:215, 227` の kill-agent を用途に応じて close-agent に変更

### S5. schema.ts

- reason の union 型に `"close-agent"` を追加（SESSION_ENDED の reason）

### S6. 型チェック

`cd skills/cmux-team/manager && bunx tsc --noEmit` でエラーゼロ確認

## 受け入れ条件

- `cmux-team close-agent --surface <s>` が動作する
- Conductor が正常完了した Agent を close-agent で閉じると `agent_done status=completed` がログに出る
- `kill-agent` 経由の終了は引き続き `agent_done status=crashed`
- テンプレート内で通常完了時は close-agent、異常時は kill-agent を使うよう明記されている
- 既存の `kill-agent` 動作は変わらない（後方互換）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-231-1776377956` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-231-1776377956
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-231-1776377956/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/231-close-agent-status/runs/task-231-1776377956
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/231-close-agent-status/runs/task-231-1776377956/summary.md` に書き出す。

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
