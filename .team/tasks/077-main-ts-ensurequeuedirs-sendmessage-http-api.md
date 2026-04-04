---
id: 077
title: main.ts の ensureQueueDirs/sendMessage 残存参照を HTTP API に移行
priority: medium
created_at: 2026-04-04T13:50:44.999Z
---

## タスク
## バグ

T070（ファイルベース IPC → HTTP API 移行）で queue.ts が削除され ensureQueueDirs と sendMessage の関数定義が消えたが、main.ts の6箇所に呼び出しが残っている。

--status ready でのタスク作成や update-task --status ready がクラッシュする:
  ReferenceError: ensureQueueDirs is not defined

## 影響箇所（main.ts）

- L778-779: cmdSpawnConductor 内
- L924-925: cmdSpawnAgent 内
- L997: cmdKillAgent 内
- L1092-1093: cmdCreateTask 内（status=ready 時）
- L1180-1181: cmdUpdateTask 内（status=ready 時）
- L1345-1346: cmdCloseTask 内
- L1497-1498: cmdAbortTask 内

## 修正方法

ensureQueueDirs を削除し、sendMessage を HTTP API（POST /api/messages）に置換する。既に cmdSend (L524-548) に同じパターンの実装がある。proxy-port ファイルからポートを読み、fetch で POST する。

ヘルパー関数を抽出するのが良い:

async function postMessage(msg: QueueMessage): Promise<void> {
  const portFile = join(PROJECT_ROOT, ".team/proxy-port");
  if (!existsSync(portFile)) return; // daemon 未起動時はスキップ
  const port = (await readFile(portFile, "utf-8")).trim();
  await fetch(http://localhost:PORT/api/messages, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg) });
}
