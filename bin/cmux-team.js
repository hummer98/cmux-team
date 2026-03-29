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
try {
  execFileSync("bun", ["run", mainTs, ...args], { stdio: "inherit" });
} catch (e) {
  process.exit(e.status ?? 1);
}
