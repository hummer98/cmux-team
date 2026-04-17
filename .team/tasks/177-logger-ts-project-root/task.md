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

