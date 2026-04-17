# タスク割り当て

## タスク内容

---
id: 177
title: logger.ts の PROJECT_ROOT 評価タイミングを修正しテスト漏出を防ぐ
priority: high
created_at: 2026-04-13T10:21:08.217Z
---

## タスク
## 問題

`daemon.test.ts` のテストフィクスチャ（`taskRunId=task-010-1712345678` / 架空の `surface:71` / T010 journal-generator）が実プロジェクトの `.team/logs/manager.log` に継続的に書き込まれている。具体的には以下のループ:

```
conductor_disconnected surface=surface:71 taskRunId=task-010-1712345678
task_completed task_id=010 title=journal-generator
conductor_disconnect_timeout elapsed=600s
task_aborted task_id=10 reason=disconnect_timeout
conductor_recovered surface=surface:71 via=SESSION_IDLE
```

T010 自体は 2026-03-29 に closed 済みで `task-state.json` に実害はないが、ログが汚染されて解析の邪魔になる。

## 原因

`skills/cmux-team/manager/logger.ts:4`:

```ts
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const LOG_DIR = join(PROJECT_ROOT, ".team/logs");
const LOG_FILE = join(LOG_DIR, "manager.log");
```

これらは **モジュール load 時に 1 回だけ評価** される。`daemon.test.ts` の beforeEach で `process.env.PROJECT_ROOT = testDir` を設定しても、logger.ts が先に import 済みだと `LOG_FILE` は既に実プロジェクトのパスで固定されている。結果としてテスト中の `log()` 呼び出しが実プロジェクトの manager.log に追記される。

## 修正方針

`logger.ts` の `log()` 内で PROJECT_ROOT を都度評価する:

```ts
export async function log(event: string, detail: string = ""): Promise<void> {
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const logDir = join(projectRoot, ".team/logs");
  const logFile = join(logDir, "manager.log");
  await mkdir(logDir, { recursive: true });
  const timestamp = localISOString();
  const line = `[${timestamp}] ${event} ${detail}`.trimEnd() + "\n";
  await appendFile(logFile, line);
}
```

副作用: 実行時のオーバーヘッドはほぼ無視できる（環境変数参照のみ）。

## 検証手順

1. `cd skills/cmux-team/manager && bun test daemon.test.ts` を実行
2. 実プロジェクトの `.team/logs/manager.log` に T010 / surface:71 / task-010-1712345678 が**追記されないこと**を確認
3. テスト用 tmpdir 側の manager.log にログが書かれていること（fixture として期待される挙動）を確認

## 補足

- 既存ログから漏出分を削除するかは別判断（履歴として残しても良い）
- 同様のパターンが他モジュールにないか簡易調査（`grep -n 'process.env.PROJECT_ROOT || process.cwd()' skills/cmux-team/manager/*.ts` で module-level 定数を検出）



## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-177-1776075706` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-177-1776075706
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-177-1776075706/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/177-logger-ts-project-root/runs/task-177-1776075706
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/177-logger-ts-project-root/runs/task-177-1776075706/summary.md` に書き出す。

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
