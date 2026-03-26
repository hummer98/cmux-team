#!/usr/bin/env bun
/**
 * Manager — 決定論的イベントループ
 *
 * 1. キューからメッセージを読む
 * 2. タスクスキャン（ready なタスクを検出）
 * 3. Conductor を起動・監視
 * 4. 完了した Conductor の結果を回収
 * 5. ログを記録
 *
 * AI 判断が必要な場合のみ claude --print でワンショット実行
 */

import { readdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { mkdir } from "fs/promises";
import { readQueue, markProcessed, ensureQueueDirs } from "./queue";
import {
  spawnConductor,
  checkConductorStatus,
  collectResults,
} from "./conductor";
import { log } from "./logger";
import type { ConductorState } from "./schema";

// --- プロジェクトルート検出 ---
const scriptDir = import.meta.dir;
if (!process.env.PROJECT_ROOT && scriptDir.includes(".team/manager")) {
  process.env.PROJECT_ROOT = join(scriptDir, "../..");
}

// --- 設定 ---
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const POLL_INTERVAL = Number(process.env.CMUX_TEAM_POLL_INTERVAL ?? 15_000); // 15秒
const MAX_CONDUCTORS = Number(process.env.CMUX_TEAM_MAX_CONDUCTORS ?? 3);

// --- 状態 ---
const conductors: Map<string, ConductorState> = new Map();
let running = true;

// --- メインループ ---
async function main(): Promise<void> {
  await ensureQueueDirs();
  await log("manager_started", `pid=${process.pid} poll=${POLL_INTERVAL}ms max_conductors=${MAX_CONDUCTORS}`);

  while (running) {
    try {
      await processQueue();
      await scanTasks();
      await monitorConductors();
    } catch (e: any) {
      await log("error", `loop error: ${e.message}`);
    }

    await sleep(POLL_INTERVAL);
  }

  await log("manager_stopped");
}

// --- 1. キュー処理 ---
async function processQueue(): Promise<void> {
  const messages = await readQueue();

  for (const { path, message } of messages) {
    switch (message.type) {
      case "TASK_CREATED":
        await log("task_received", `task_id=${message.taskId}`);
        // タスクスキャンで拾われるので、ここでは通知を記録するだけ
        break;

      case "TODO":
        await log("todo_received", `content=${message.content.slice(0, 50)}`);
        await handleTodo(message.content);
        break;

      case "CONDUCTOR_DONE":
        await log(
          "conductor_done_signal",
          `conductor_id=${message.conductorId}`
        );
        // monitorConductors で処理されるが、即座に回収を試みる
        const conductor = conductors.get(message.conductorId);
        if (conductor) {
          await handleConductorDone(conductor);
        }
        break;

      case "SHUTDOWN":
        await log("shutdown_requested");
        running = false;
        break;
    }

    await markProcessed(path);
  }
}

// --- 2. タスクスキャン ---
async function scanTasks(): Promise<void> {
  const tasksDir = join(PROJECT_ROOT, ".team/tasks/open");
  if (!existsSync(tasksDir)) return;

  const files = await readdir(tasksDir);
  const taskFiles = files.filter((f) => f.endsWith(".md"));

  for (const file of taskFiles) {
    const taskId = file.match(/^(\d+)/)?.[1];
    if (!taskId) continue;

    // 既に Conductor が稼働中のタスクはスキップ
    const alreadyAssigned = [...conductors.values()].some(
      (c) => c.taskId === taskId
    );
    if (alreadyAssigned) continue;

    // status: ready かチェック
    const content = await readFile(join(tasksDir, file), "utf-8");
    const statusMatch = content.match(/^status:\s*(.+)$/m);
    const status = statusMatch?.[1]?.trim() ?? "ready"; // フィールドなし → ready（後方互換）

    if (status !== "ready") continue;

    // 同時実行数チェック
    if (conductors.size >= MAX_CONDUCTORS) {
      await log("throttled", `task_id=${taskId} conductors=${conductors.size}/${MAX_CONDUCTORS}`);
      break;
    }

    // Conductor 起動
    const conductor = await spawnConductor(taskId, PROJECT_ROOT);
    if (conductor) {
      conductors.set(conductor.conductorId, conductor);
    }
  }
}

// --- 3. Conductor 監視 ---
async function monitorConductors(): Promise<void> {
  for (const [id, conductor] of conductors) {
    const status = await checkConductorStatus(conductor.surface);

    switch (status) {
      case "done":
        await handleConductorDone(conductor);
        break;
      case "crashed":
        await log(
          "conductor_crashed",
          `conductor_id=${id} surface=${conductor.surface}`
        );
        conductors.delete(id);
        break;
      case "running":
        // 何もしない、次のサイクルで再チェック
        break;
    }
  }
}

// --- 4. 結果回収 ---
async function handleConductorDone(
  conductor: ConductorState
): Promise<void> {
  const { sessionId, mergeCommit } = await collectResults(
    conductor,
    PROJECT_ROOT
  );

  // タスクファイルを closed に移動
  const tasksDir = join(PROJECT_ROOT, ".team/tasks/open");
  const closedDir = join(PROJECT_ROOT, ".team/tasks/closed");

  try {
    const files = await readdir(tasksDir);
    const taskFile = files.find((f) => f.startsWith(conductor.taskId));
    if (taskFile) {
      const { rename } = await import("fs/promises");
      await rename(join(tasksDir, taskFile), join(closedDir, taskFile));
    }
  } catch {
    // タスクファイルの移動に失敗しても続行
  }

  await log(
    "task_completed",
    `task_id=${conductor.taskId} conductor_id=${conductor.conductorId}${
      sessionId ? ` session=${sessionId}` : ""
    }${mergeCommit ? ` merged=${mergeCommit}` : ""}`
  );

  conductors.delete(conductor.conductorId);
}

// --- TODO 処理 ---
async function handleTodo(content: string): Promise<void> {
  // TODO 用の一時タスクファイルを作成
  const taskId = String(Math.floor(Date.now() / 1000));
  const taskFile = join(
    PROJECT_ROOT,
    `.team/tasks/open/${taskId}-todo.md`
  );
  const { writeFile } = await import("fs/promises");
  await writeFile(
    taskFile,
    `---
id: ${taskId}
title: ${content.slice(0, 80)}
priority: medium
status: ready
created_at: ${new Date().toISOString()}
---

## タスク
${content}

## 完了条件
- 指示された作業が完了すること
`
  );
  await log("todo_task_created", `task_id=${taskId}`);
  // 次のスキャンサイクルで拾われる
}

// --- ユーティリティ ---
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- シグナルハンドリング ---
process.on("SIGINT", async () => {
  await log("shutdown", "SIGINT received");
  running = false;
});

process.on("SIGTERM", async () => {
  await log("shutdown", "SIGTERM received");
  running = false;
});

// --- 起動 ---
main().catch(async (e) => {
  await log("fatal", e.message);
  process.exit(1);
});
