#!/usr/bin/env bun
/**
 * queue-send CLI — Master / Hook からキューにメッセージを追加する
 *
 * Usage:
 *   bun run cli.ts TASK_CREATED --task-id 035 --task-file .team/tasks/open/035-fix.md
 *   bun run cli.ts TODO --content "git worktree prune"
 *   bun run cli.ts CONDUCTOR_DONE --conductor-id conductor-xxx --surface surface:42
 *   bun run cli.ts SHUTDOWN
 */

import { sendMessage } from "./queue";
import type { QueueMessage } from "./schema";

const args = process.argv.slice(2);
const type = args[0];

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function requireArg(name: string): string {
  const val = getArg(name);
  if (!val) {
    console.error(`Error: --${name} is required for ${type}`);
    process.exit(1);
  }
  return val;
}

const now = new Date().toISOString();

let message: QueueMessage;

switch (type) {
  case "TASK_CREATED":
    message = {
      type: "TASK_CREATED",
      taskId: requireArg("task-id"),
      taskFile: requireArg("task-file"),
      timestamp: now,
    };
    break;

  case "TODO":
    message = {
      type: "TODO",
      content: requireArg("content"),
      timestamp: now,
    };
    break;

  case "CONDUCTOR_DONE":
    message = {
      type: "CONDUCTOR_DONE",
      conductorId: requireArg("conductor-id"),
      surface: requireArg("surface"),
      sessionId: getArg("session-id"),
      transcriptPath: getArg("transcript-path"),
      timestamp: now,
    };
    break;

  case "SHUTDOWN":
    message = {
      type: "SHUTDOWN",
      timestamp: now,
    };
    break;

  default:
    console.error(
      `Usage: cli.ts <TASK_CREATED|TODO|CONDUCTOR_DONE|SHUTDOWN> [options]`
    );
    console.error(`  TASK_CREATED --task-id <id> --task-file <path>`);
    console.error(`  TODO --content <text>`);
    console.error(`  CONDUCTOR_DONE --conductor-id <id> --surface <surface>`);
    console.error(`  SHUTDOWN`);
    process.exit(1);
}

const path = await sendMessage(message);
console.log(`OK ${path}`);
