/**
 * Manager 共通ヘルパー。
 */

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
