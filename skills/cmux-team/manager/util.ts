/**
 * Manager 共通ヘルパー。
 */

import { isAbsolute } from "node:path";

/**
 * POSIX shell 用の single-quote 防御 wrap。
 * 内部の `'` を `'\''` で escape して全体を single-quote で包む。
 *
 * 呼び出し元で metacharacter を事前 reject していても、`cmux send` 経由で shell
 * に投入する文字列は防御的に quote しておく。
 *
 * 例: shellQuote("/path/to/file.md") === "'/path/to/file.md'"
 *     shellQuote("a'b")             === "'a'\\''b'"
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Master/Conductor を spawn するために shell に投入する複合コマンドを組み立てる。
 *
 * `cd 'PROJECT_ROOT' && <command>` の形に正規化することで、ペイン shell の
 * 現在 cwd / direnv 状態に依らず project root から `cmux-team spawn-*` が
 * 実行されることを保証する（task 446）。
 *
 * @param projectRoot - 絶対パス
 * @param command - "cmux-team spawn-master" / "cmux-team spawn-conductor [...]"
 * @returns "cd '<root>' && <command>" — 末尾改行は付けない
 * @throws projectRoot が絶対パスでない場合
 */
export function buildLaunchCommand(projectRoot: string, command: string): string {
  if (!isAbsolute(projectRoot)) {
    throw new Error(`buildLaunchCommand: projectRoot must be absolute, got: ${projectRoot}`);
  }
  return `cd ${shellQuote(projectRoot)} && ${command}`;
}
