import { relative, resolve } from "node:path";

export type ResolveUnderRootResult = {
  path: string;
  outside: boolean;
};

/**
 * value を root 配下の絶対パスに正規化する。
 * - root の外を指す場合は outside=true。
 * - opts.allowOutside=true なら outside でも path を返す。
 * - opts.allowOutside=false（既定）の場合は呼び出し側が outside をチェックして拒否する。
 */
export function resolveUnderRoot(
  root: string,
  value: string,
  opts?: { allowOutside?: boolean },
): ResolveUnderRootResult {
  const absRoot = resolve(root);
  const absPath = resolve(absRoot, value);
  const rel = relative(absRoot, absPath);
  const outside = rel.startsWith("..") || resolve(absRoot, rel) !== absPath;
  if (outside && !opts?.allowOutside) {
    return { path: absPath, outside: true };
  }
  return { path: absPath, outside };
}
