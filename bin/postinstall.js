#!/usr/bin/env node

// npm postinstall スクリプト
// manager/ の依存を bun install で解決

import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

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

// Claude Code plugin をインストール
try {
  execFileSync("which", ["claude"], { stdio: "ignore" });
  console.log("cmux-team: Claude Code plugin をインストール中...");
  execFileSync("claude", ["plugin", "add", "hummer98/cmux-team"], { stdio: "inherit" });
} catch {
  console.warn("cmux-team: claude が見つかりません。手動で実行してください:");
  console.warn("  claude plugin add hummer98/cmux-team");
}

// statusline.sh をインストール
const statuslineSrc = join(__dirname, "..", "skills", "cmux-team", "manager", "statusline.sh");
const statuslineDst = join(homedir(), ".claude", "statusline.sh");
try {
  copyFileSync(statuslineSrc, statuslineDst);
  chmodSync(statuslineDst, 0o755);
  console.log("cmux-team: statusline.sh をインストールしました");
} catch (e) {
  console.warn(`cmux-team: statusline.sh のインストールに失敗しました: ${e.message}`);
}

console.log("cmux-team: インストール完了");
