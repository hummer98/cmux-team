#!/usr/bin/env node

// npm postinstall スクリプト
// manager/ の依存を bun install で解決

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const managerDir = join(__dirname, "..", "skills", "cmux-team", "manager");

// bun install（manager/ の依存解決）
try {
  execFileSync("which", ["bun"], { stdio: "ignore" });
  console.log("cmux-team: bun install を実行中...");
  execFileSync("bun", ["install"], { cwd: managerDir, stdio: "inherit" });
} catch {
  console.warn("cmux-team: bun が見つかりません。手動で以下を実行してください:");
  console.warn(`  cd ${managerDir} && bun install`);
}

// インストール完了メッセージ
console.log("cmux-team: インストール完了");
console.log("  Plugin としても使う場合: claude plugin add hummer98/cmux-team");
