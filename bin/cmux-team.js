#!/usr/bin/env node

// cmux-team CLI ラッパー
// bun で skills/cmux-team/manager/main.ts を実行する

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const mainTs = join(__dirname, "..", "skills", "cmux-team", "manager", "main.ts");

// bun の存在確認
try {
  execFileSync("which", ["bun"], { stdio: "ignore" });
} catch {
  console.error("エラー: bun がインストールされていません。");
  console.error("インストール: https://bun.sh/docs/installation");
  process.exit(1);
}

// 引数を透過して bun run で実行
const args = process.argv.slice(2);

if (args[0] === "start") {
  // start コマンド: exit code 42 で自動再起動
  let restarts = 0;
  const MAX_RESTARTS = 10;
  while (restarts < MAX_RESTARTS) {
    try {
      execFileSync("bun", ["run", mainTs, ...args], { stdio: "inherit" });
      break; // 正常終了
    } catch (e) {
      if (e.status === 42) {
        restarts++;
        console.log(`♻ daemon auto-restart (${restarts}/${MAX_RESTARTS})`);
        execFileSync("sleep", ["1"]);
        continue;
      }
      process.exit(e.status ?? 1);
    }
  }
  if (restarts >= MAX_RESTARTS) {
    console.error("Error: daemon restart limit reached");
    process.exit(1);
  }
} else {
  try {
    execFileSync("bun", ["run", mainTs, ...args], { stdio: "inherit" });
  } catch (e) {
    process.exit(e.status ?? 1);
  }
}
