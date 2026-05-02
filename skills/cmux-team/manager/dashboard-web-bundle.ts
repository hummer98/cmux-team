/**
 * T414: dashboard-web/{index.html, style.css, vendor/uplot.min.js, vendor/uplot.min.css, app.js}
 *        を 1 つの HTML 文字列に連結する。
 *
 * dev iteration: 起動時に 1 度だけ読み込んで cache する（再読込は daemon 再起動で）。
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

let cachedHtml: string | null = null;

function webRoot(): string {
  // import.meta.url からファイル所在ディレクトリ + dashboard-web/
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "dashboard-web");
}

export function getDashboardHtml(): string {
  if (cachedHtml !== null) return cachedHtml;
  const root = webRoot();
  const html = readFileSync(join(root, "index.html"), "utf-8");
  const css = readFileSync(join(root, "style.css"), "utf-8");
  const uplotCss = readFileSync(join(root, "vendor/uplot.min.css"), "utf-8");
  const uplotJs = readFileSync(join(root, "vendor/uplot.min.js"), "utf-8");
  const app = readFileSync(join(root, "app.js"), "utf-8");
  cachedHtml = html
    .replace("/*__INLINE_UPLOT_CSS__*/", () => uplotCss)
    .replace("/*__INLINE_CSS__*/", () => css)
    .replace("/*__INLINE_UPLOT__*/", () => uplotJs)
    .replace("/*__INLINE_APP__*/", () => app);
  return cachedHtml;
}

/** テスト用: cache を破棄する */
export function _resetDashboardHtmlCache(): void {
  cachedHtml = null;
}
