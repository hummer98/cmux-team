/**
 * T435: dashboard キーバインドの単一ソース (SSOT) 化。
 *
 * binding 定義 / status bar / help overlay を `DASHBOARD_BINDINGS` registry から
 * 自動派生させる。各 BindingSpec は scope (global / focus / tab) と category を
 * 持ち、`buildAppKeys` が `app.keys()` 用 `BindingMap` に展開、
 * `buildStatusBarItems` が現在の focus/tab に応じた hint を抽出する。
 *
 * rezi-ui 制約 (chordMatcher.js / createApp.js より):
 *   - C2: letter codepoint は uppercase 正規化される (a-z と A-Z は同 trie key)
 *   - C5: 同一 prefix の単発と chord は共存できない（単発が即発火し chord 失活）
 *   - C6: overlay 中 printable text は keybinding に流れない
 *
 * 詳細は plan.md §1.4 / §2.1 を参照。
 */

import type { BindingMap, KeyContext } from "@rezi-ui/core";
import { parseKeySequence } from "@rezi-ui/core";
import { t } from "./i18n";
import type { AppState } from "./dashboard";

/**
 * T439: c c chord binding の id 定数。`withChordCancellation` の自身判定で
 * 文字列リテラル一致のミス（typo で silent に handler 直通）を防ぐため
 * 定数として共有する（design-review m_new1 反映）。
 */
export const COPY_CHORD_BINDING_ID = "artifacts.copy-path";

// ─────────────────────────────────────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────────────────────────────────────

type FocusedArea = AppState["focusedArea"];
type TabId = AppState["activeTab"];

export type BindingScope =
  | { kind: "global" }
  | { kind: "focus"; areas: ReadonlyArray<FocusedArea> }
  | { kind: "tab"; tabs: ReadonlyArray<TabId> };

export type BindingCategory =
  | "system"
  | "navigation"
  | "tab"
  | "open"
  | "action";

export type BindingHandler = (ctx: KeyContext<AppState>) => void;

export type BindingSpec = Readonly<{
  /** 一意 ID。例: "nav.down", "tab.next" */
  id: string;
  /** 登録するキー文字列。chord は "g g" 形式 */
  keys: ReadonlyArray<string>;
  /** scope: 発火を許可する条件 */
  scope: BindingScope;
  /** カテゴリ: help overlay のグルーピング用 */
  category: BindingCategory;
  /** i18n key (status bar / help overlay の説明文) */
  description: string;
  /** status bar に表示する短いキー表記。省略時は keys[0] */
  statusBarKey?: string;
  /** 単発 binding 限定の追加 guard。通常は scope で表現するが modal 等で必要 */
  when?: (state: Readonly<AppState>) => boolean;
  /** 実行ハンドラ */
  handler: BindingHandler;
  /**
   * 廃止予定 alias。help overlay や status bar では非表示にし、発火時に
   * `deprecatedReplacement` を hint として状態に書き込むことを推奨。
   */
  deprecated?: true;
  /** deprecated alias の代替キー (hint 表示に使う) */
  deprecatedReplacement?: string;
  /** status bar に表示するか (false の時は help overlay のみ) */
  showInStatusBar?: boolean;
}>;

// ─────────────────────────────────────────────────────────────────────────────
// Registry (依存注入 factory)
// ─────────────────────────────────────────────────────────────────────────────

export type KeymapDeps = Readonly<{
  switchTab: (tab: TabId) => void;
  syncIssuesFromGh: () => Promise<void>;
  openSelectedIssueInViewer: (state: AppState) => Promise<void>;
  openTaskInViewer: (state: AppState) => void;
  openSettingsItemInViewer: (state: AppState) => void;
  openSelectedArtifactInViewer: (state: AppState) => void;
  openMetricsDashboardInBrowser: (state: AppState) => void;
  openSelectedIssueInBrowser: (state: AppState) => void;
  navigateUp: (state: AppState) => AppState;
  navigateDown: (state: AppState) => AppState;
  navigateTop: (state: AppState) => AppState;
  navigateBottom: (state: AppState) => AppState;
  navigateHalfPageDown: (state: AppState) => AppState;
  navigateHalfPageUp: (state: AppState) => AppState;
  cycleArtifactSort: (state: AppState) => AppState;
  cycleArtifactFilter: (state: AppState) => AppState;
  reload: () => void;
  quit: () => void;
  /** "Y" 確定時に呼ばれる。state.confirmingFullQuit が true の前提 */
  fullQuit: () => void;
  log: (event: string, detail: string) => void;
  /**
   * T439: c c chord 用の handler（artifacts.copy-path binding 専用）。
   * 1 回目: cChordPending を立て、500ms の auto-clear schedule。
   * 2 回目: pending クリア + 該当 timer cancel + clipboard コピー実行。
   */
  handleCopyChord: (ctx: KeyContext<AppState>) => void;
  /**
   * T439: chord 待機中に別キーが押されたとき、または timeout / tab 切替時に呼ぶ。
   * pending クリア + timer cancel を行う。
   */
  cancelChord: (ctx: KeyContext<AppState>) => void;
  /**
   * T439: setTimeout を testable にするための DI。
   * 戻り値の cancel 関数を呼ぶと予約された cb は実行されない。
   * chord auto-clear と toast auto-clear で共用する単一 IF。
   */
  schedule: (ms: number, cb: () => void) => () => void;
}>;

export function createDashboardBindings(deps: KeymapDeps): ReadonlyArray<BindingSpec> {
  const bindings: BindingSpec[] = [];

  // ── System (global) ──────────────────────────────────────────────────────
  bindings.push({
    id: "sys.help",
    keys: ["?"],
    scope: { kind: "global" },
    category: "system",
    description: "key_help",
    statusBarKey: "?",
    handler: (ctx) => {
      ctx.update((s) => ({ ...s, showHelp: !s.showHelp }));
    },
  });
  bindings.push({
    id: "sys.cancel",
    keys: ["Escape"],
    scope: { kind: "global" },
    category: "system",
    description: "key_cancel",
    statusBarKey: "Esc",
    handler: (ctx) => {
      ctx.update((s) => ({
        ...s,
        confirmingFullQuit: false,
        focusedArea: "global",
        showHelp: false,
      }));
    },
  });
  bindings.push({
    id: "sys.reload",
    keys: ["ctrl+r"],
    scope: { kind: "focus", areas: ["global"] },
    category: "system",
    description: "key_reload",
    statusBarKey: "Ctrl+r",
    handler: () => deps.reload(),
  });
  bindings.push({
    id: "sys.quit",
    keys: ["q"],
    scope: { kind: "focus", areas: ["global"] },
    category: "system",
    description: "key_quit",
    when: (s) => !s.confirmingFullQuit && !s.showHelp,
    handler: () => deps.quit(),
  });
  bindings.push({
    id: "sys.full-quit",
    keys: ["ctrl+q"],
    scope: { kind: "focus", areas: ["global"] },
    category: "system",
    description: "key_full_quit",
    statusBarKey: "Ctrl+q",
    handler: (ctx) => {
      ctx.update((s) => ({ ...s, confirmingFullQuit: true }));
    },
  });

  // ── Tab jump (1-6 / Tab / gt / gp) ────────────────────────────────────────
  const TAB_ORDER: ReadonlyArray<TabId> = [
    "journal", "artifacts", "log", "settings", "issues", "metrics",
  ];
  const TAB_DESC_KEYS: Readonly<Record<TabId, string>> = {
    journal: "key_tab_journal",
    artifacts: "key_tab_artifacts",
    log: "key_tab_log",
    settings: "key_tab_settings",
    issues: "key_tab_issues",
    metrics: "key_tab_metrics",
  };
  TAB_ORDER.forEach((tab, i) => {
    const num = String(i + 1);
    bindings.push({
      id: `tab.jump.${tab}`,
      keys: [num],
      scope: { kind: "global" },
      category: "tab",
      description: TAB_DESC_KEYS[tab],
      statusBarKey: num,
      handler: () => deps.switchTab(tab),
      // status bar には "1-6" のような集約表示を別途出すので個別表示は省略
      showInStatusBar: false,
    });
  });
  // Tab (cycle next)
  bindings.push({
    id: "tab.next",
    keys: ["Tab"],
    scope: { kind: "global" },
    category: "tab",
    description: "key_tab_next",
    statusBarKey: "Tab",
    handler: (ctx) => {
      const idx = TAB_ORDER.indexOf(ctx.state.activeTab);
      const next = TAB_ORDER[(idx + 1) % TAB_ORDER.length]!;
      deps.switchTab(next);
    },
  });
  // gt / gp (Vim chord, C5 制約により単発 g は登録不可)
  bindings.push({
    id: "tab.next.chord",
    keys: ["g t"],
    scope: { kind: "global" },
    category: "tab",
    description: "key_tab_next",
    statusBarKey: "gt",
    showInStatusBar: false,
    handler: (ctx) => {
      const idx = TAB_ORDER.indexOf(ctx.state.activeTab);
      const next = TAB_ORDER[(idx + 1) % TAB_ORDER.length]!;
      deps.switchTab(next);
    },
  });
  bindings.push({
    id: "tab.prev.chord",
    keys: ["g p"],
    scope: { kind: "global" },
    category: "tab",
    description: "key_tab_prev",
    statusBarKey: "gp",
    handler: (ctx) => {
      const idx = TAB_ORDER.indexOf(ctx.state.activeTab);
      const prev = TAB_ORDER[(idx - 1 + TAB_ORDER.length) % TAB_ORDER.length]!;
      deps.switchTab(prev);
    },
  });

  // ── Navigation (focus 内) ─────────────────────────────────────────────────
  // F2 (a): 単一 binding の handler 内で focusedArea で分岐する純粋関数を呼ぶ
  bindings.push({
    id: "nav.up",
    keys: ["k", "Up"],
    scope: { kind: "global" },
    category: "navigation",
    description: "key_nav_up",
    statusBarKey: "↑/k",
    showInStatusBar: false,
    handler: (ctx) => ctx.update((s) => deps.navigateUp(s)),
  });
  bindings.push({
    id: "nav.down",
    keys: ["j", "Down"],
    scope: { kind: "global" },
    category: "navigation",
    description: "key_nav_down",
    statusBarKey: "↓/j",
    showInStatusBar: false,
    handler: (ctx) => ctx.update((s) => deps.navigateDown(s)),
  });
  bindings.push({
    id: "nav.top",
    keys: ["g g"],
    scope: { kind: "focus", areas: ["journal", "log", "metrics"] },
    category: "navigation",
    description: "key_nav_top",
    statusBarKey: "gg",
    handler: (ctx) => ctx.update((s) => deps.navigateTop(s)),
  });
  bindings.push({
    id: "nav.bottom",
    keys: ["g e"],
    scope: { kind: "focus", areas: ["journal", "log", "metrics"] },
    category: "navigation",
    description: "key_nav_bottom",
    statusBarKey: "ge",
    handler: (ctx) => ctx.update((s) => deps.navigateBottom(s)),
  });
  bindings.push({
    id: "nav.half-page-down",
    keys: ["ctrl+d"],
    scope: { kind: "focus", areas: ["journal", "log", "metrics"] },
    category: "navigation",
    description: "key_nav_half_page_down",
    statusBarKey: "Ctrl+d",
    showInStatusBar: false,
    handler: (ctx) => ctx.update((s) => deps.navigateHalfPageDown(s)),
  });
  bindings.push({
    id: "nav.half-page-up",
    keys: ["ctrl+u"],
    scope: { kind: "focus", areas: ["journal", "log", "metrics"] },
    category: "navigation",
    description: "key_nav_half_page_up",
    statusBarKey: "Ctrl+u",
    showInStatusBar: false,
    handler: (ctx) => ctx.update((s) => deps.navigateHalfPageUp(s)),
  });

  // ── Open ─────────────────────────────────────────────────────────────────
  // Enter / o は同じ handler を呼ぶ。activeTab/focusedArea で分岐
  const openPrimaryHandler: BindingHandler = (ctx) => {
    const s = ctx.state;
    if (s.focusedArea === "tasks") return deps.openTaskInViewer(s);
    if (s.focusedArea === "settings") return deps.openSettingsItemInViewer(s);
    if (s.focusedArea === "issues") {
      void deps.openSelectedIssueInViewer(s).catch((e: any) => {
        deps.log("viewer_error", e?.message ?? String(e));
      });
      return;
    }
    if (s.focusedArea === "artifacts") return deps.openSelectedArtifactInViewer(s);
  };
  bindings.push({
    id: "open.primary",
    keys: ["Enter", "o"],
    scope: { kind: "focus", areas: ["tasks", "settings", "issues", "artifacts"] },
    category: "open",
    description: "key_open_primary",
    statusBarKey: "Enter/o",
    handler: openPrimaryHandler,
  });
  bindings.push({
    id: "open.browser",
    keys: ["ctrl+o"],
    scope: { kind: "tab", tabs: ["issues", "metrics"] },
    category: "open",
    description: "key_open_browser",
    statusBarKey: "Ctrl+o",
    handler: (ctx) => {
      const s = ctx.state;
      if (s.activeTab === "issues") return deps.openSelectedIssueInBrowser(s);
      if (s.activeTab === "metrics") return deps.openMetricsDashboardInBrowser(s);
    },
  });

  // ── Tab-local actions ────────────────────────────────────────────────────
  bindings.push({
    id: "artifacts.cycle-sort",
    keys: ["s"],
    scope: { kind: "focus", areas: ["artifacts"] },
    category: "action",
    description: "key_artifact_sort",
    handler: (ctx) => ctx.update((s) => deps.cycleArtifactSort(s)),
  });
  bindings.push({
    id: "artifacts.cycle-filter",
    keys: ["f"],
    scope: { kind: "focus", areas: ["artifacts"] },
    category: "action",
    description: "key_artifact_filter",
    handler: (ctx) => ctx.update((s) => deps.cycleArtifactFilter(s)),
  });
  // /  は予約のみ（D10）。handler は no-op + 注記
  bindings.push({
    id: "artifacts.search",
    keys: ["/"],
    scope: { kind: "focus", areas: ["artifacts"] },
    category: "action",
    description: "key_artifact_search",
    showInStatusBar: false,
    handler: () => {
      // T435 D10: binding 予約のみ。handler 実装は別タスクに切り出し
    },
  });
  // T439: c c chord で artifact 絶対パスを clipboard コピー
  // statusBarKey: "cc" は通常時の表示。dashboard.tsx の status bar 描画で
  // state.cChordPending != null のとき "c-" indicator に置換する（D8）
  bindings.push({
    id: COPY_CHORD_BINDING_ID,
    keys: ["c"],
    scope: { kind: "focus", areas: ["artifacts"] },
    category: "action",
    description: "key_artifact_copy_path",
    statusBarKey: "cc",
    handler: (ctx) => deps.handleCopyChord(ctx),
  });
  bindings.push({
    id: "issues.sync",
    keys: ["ctrl+s"],
    scope: { kind: "tab", tabs: ["issues"] },
    category: "action",
    description: "key_issues_sync",
    statusBarKey: "Ctrl+s",
    handler: () => {
      void deps.syncIssuesFromGh().catch((e: any) => {
        deps.log("issues_sync_error", e?.message ?? String(e));
      });
    },
  });

  // ── Confirm modal (full quit) ────────────────────────────────────────────
  // C2: y/Y, n/N は同じ trie key になる。確定する際は state guard で判定
  bindings.push({
    id: "modal.confirm",
    keys: ["y"],
    scope: { kind: "global" },
    category: "system",
    description: "key_modal_confirm",
    showInStatusBar: false,
    when: (s) => s.confirmingFullQuit === true,
    handler: () => deps.fullQuit(),
  });
  bindings.push({
    id: "modal.cancel",
    keys: ["n"],
    scope: { kind: "global" },
    category: "system",
    description: "key_modal_cancel",
    showInStatusBar: false,
    when: (s) => s.confirmingFullQuit === true,
    handler: (ctx) => {
      ctx.update((s) => ({ ...s, confirmingFullQuit: false }));
    },
  });

  // ── Deprecated alias (Conductor 指示: 1 リリース残置) ──────────────────────
  // T = focus tasks
  bindings.push({
    id: "deprecated.focus-tasks",
    keys: ["T"],
    scope: { kind: "global" },
    category: "navigation",
    description: "key_tab_journal",
    deprecated: true,
    deprecatedReplacement: "Tab+↑/↓",
    showInStatusBar: false,
    handler: (ctx) => {
      ctx.update((s) => ({ ...s, focusedArea: "tasks" }));
      deps.log(
        "deprecated_key_used",
        `id=deprecated.focus-tasks key=T replacement=Tab`,
      );
    },
  });
  const TAB_ALIAS: ReadonlyArray<readonly [string, TabId]> = [
    ["J", "journal"],
    ["L", "log"],
    ["A", "artifacts"],
    ["I", "issues"],
    ["M", "metrics"],
  ];
  for (const [key, tab] of TAB_ALIAS) {
    bindings.push({
      id: `deprecated.tab.${tab}`,
      keys: [key],
      scope: { kind: "global" },
      category: "tab",
      description: TAB_DESC_KEYS[tab],
      deprecated: true,
      deprecatedReplacement: String(TAB_ORDER.indexOf(tab) + 1),
      showInStatusBar: false,
      handler: () => {
        deps.switchTab(tab);
        deps.log(
          "deprecated_key_used",
          `id=deprecated.tab.${tab} key=${key} replacement=${TAB_ORDER.indexOf(tab) + 1}`,
        );
      },
    });
  }
  // B = issues→browser  (現 Ctrl+o)
  bindings.push({
    id: "deprecated.issues-browser",
    keys: ["B"],
    scope: { kind: "tab", tabs: ["issues"] },
    category: "open",
    description: "key_open_browser",
    deprecated: true,
    deprecatedReplacement: "Ctrl+o",
    showInStatusBar: false,
    handler: (ctx) => {
      deps.openSelectedIssueInBrowser(ctx.state);
      deps.log(
        "deprecated_key_used",
        `id=deprecated.issues-browser key=B replacement=Ctrl+o`,
      );
    },
  });
  // O = issues→viewer / metrics→browser (現 Enter/o for viewer, Ctrl+o for browser)
  bindings.push({
    id: "deprecated.O",
    keys: ["O"],
    scope: { kind: "tab", tabs: ["issues", "metrics"] },
    category: "open",
    description: "key_open_primary",
    deprecated: true,
    deprecatedReplacement: "Enter/o or Ctrl+o",
    showInStatusBar: false,
    handler: (ctx) => {
      const s = ctx.state;
      if (s.activeTab === "issues") {
        void deps.openSelectedIssueInViewer(s).catch(() => {});
        deps.log(
          "deprecated_key_used",
          `id=deprecated.O key=O replacement=Enter/o`,
        );
        return;
      }
      if (s.activeTab === "metrics") {
        deps.openMetricsDashboardInBrowser(s);
        deps.log(
          "deprecated_key_used",
          `id=deprecated.O key=O replacement=Ctrl+o`,
        );
      }
    },
  });

  // T439: 全 binding を withChordCancellation で wrap して、c chord 待機中に
  // 別キーが押されたら pending クリア + timer cancel が走るようにする（C1 採用案）。
  // copy chord 自身は wrap 内で noop とし、handleCopyChord 側で pending を進める。
  return bindings.map((b) => ({
    ...b,
    handler: withChordCancellation(b.handler, b, deps),
  }));
}

/**
 * T439: handler を chord cancel 機能つきにラップする純粋関数。
 *
 * 仕様:
 *   - 自分が copy chord binding (`COPY_CHORD_BINDING_ID`) → noop（handler に直通）
 *   - その他 binding で `state.cChordPending != null` → `deps.cancelChord(ctx)` 呼んでから handler 実行
 *
 * これにより chord 待機中の別キー押下で pending が確実にクリアされる
 * （focus=artifacts 内の j/k/Enter/s/f、tab 切替、help 等すべて）。
 */
export function withChordCancellation<H extends BindingHandler>(
  handler: H,
  binding: BindingSpec,
  deps: Pick<KeymapDeps, "cancelChord">,
): H {
  return ((ctx: KeyContext<AppState>) => {
    if (binding.id !== COPY_CHORD_BINDING_ID && ctx.state.cChordPending != null) {
      deps.cancelChord(ctx);
    }
    return handler(ctx);
  }) as H;
}

// ─────────────────────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 与えられた binding が現在の state で active かを判定する。
 * scope と when の両方を合成する。
 */
function isBindingActive(spec: BindingSpec, state: Readonly<AppState>): boolean {
  if (spec.when && !spec.when(state)) return false;
  switch (spec.scope.kind) {
    case "global":
      return true;
    case "focus":
      return spec.scope.areas.includes(state.focusedArea);
    case "tab":
      return spec.scope.tabs.includes(state.activeTab);
  }
}

/**
 * registry から `app.keys()` 用の BindingMap を生成する。
 *
 * 同じ key 文字列に対する複数 binding の解決:
 *   rezi-ui の registerBindings は同 key を新しい binding で上書きする。
 *   そのため、同じ key (e.g. "Enter") が複数の BindingSpec に登場する場合は
 *   handler 内で実行時に scope/when を判定して適切なものに dispatch する。
 *   ここでは key ごとに「マッチする binding 候補」を集め、handler を 1 つに合成。
 */
export function buildAppKeys(
  bindings: ReadonlyArray<BindingSpec>,
): BindingMap<KeyContext<AppState>> {
  // key -> list of binding specs (登録順を保持)
  const byKey = new Map<string, BindingSpec[]>();
  for (const b of bindings) {
    for (const k of b.keys) {
      const list = byKey.get(k);
      if (list) list.push(b);
      else byKey.set(k, [b]);
    }
  }

  const map: Record<string, (ctx: KeyContext<AppState>) => void> = {};
  for (const [key, specs] of byKey) {
    const handler = (ctx: KeyContext<AppState>) => {
      // active な binding を順に探して最初の 1 件を実行
      for (const spec of specs) {
        if (isBindingActive(spec, ctx.state)) {
          spec.handler(ctx);
          return;
        }
      }
    };
    map[key] = handler;
  }
  return map as BindingMap<KeyContext<AppState>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status bar
// ─────────────────────────────────────────────────────────────────────────────

export type StatusBarItem = Readonly<{
  /** 表示するキーラベル (e.g. "Enter", "Ctrl+r") */
  key: string;
  /** 表示する説明 (i18n 展開後) */
  text: string;
}>;

/**
 * 現在の state で status bar に表示すべき hint 一覧を返す。
 *
 * 表示順:
 *   1. global なナビゲーション (↑/↓ scroll など) — 集約表示
 *   2. tab 切替 (1-6 集約 + Tab)
 *   3. focus / tab 専用アクション (open / sort / filter / sync など)
 *   4. system (q / Ctrl+q / ? help)
 */
export function buildStatusBarItems(
  bindings: ReadonlyArray<BindingSpec>,
  state: Readonly<AppState>,
): ReadonlyArray<StatusBarItem> {
  const items: StatusBarItem[] = [];

  // 1. ナビゲーション集約: nav.up + nav.down が両方 active なら "↑/↓"
  const navUp = bindings.find((b) => b.id === "nav.up");
  const navDown = bindings.find((b) => b.id === "nav.down");
  const navActive =
    state.focusedArea !== "global" &&
    !!navUp && !!navDown &&
    isBindingActive(navUp, state) && isBindingActive(navDown, state);
  if (navActive) {
    const isSelectArea =
      state.focusedArea === "tasks" ||
      state.focusedArea === "artifacts" ||
      state.focusedArea === "settings" ||
      state.focusedArea === "issues";
    items.push({ key: "↑/↓", text: t(isSelectArea ? "key_nav_select" : "key_nav_scroll" as any) });
  }

  // 2. nav top/bottom (focus journal/log/metrics 時)
  const navTop = bindings.find((b) => b.id === "nav.top");
  if (navTop && isBindingActive(navTop, state)) {
    items.push({ key: "gg/ge", text: `${t("key_nav_top" as any)}/${t("key_nav_bottom" as any)}` });
  }

  // 3. tab 切替: 1-6 + Tab (どの focus でも有効)
  items.push({ key: "1-6", text: t("key_tab_next" as any) });

  // 4. focus / tab 専用アクション (showInStatusBar !== false かつ deprecated でない)
  for (const b of bindings) {
    if (b.deprecated) continue;
    if (b.showInStatusBar === false) continue;
    // global system は最後にまとめる
    if (b.category === "system") continue;
    // 既に上で集約した nav は除外
    if (b.id === "nav.up" || b.id === "nav.down") continue;
    if (b.id === "nav.top" || b.id === "nav.bottom") continue;
    if (b.id === "nav.half-page-down" || b.id === "nav.half-page-up") continue;
    // tab.jump.* は "1-6" に集約済み、tab.next も Tab を上で出している
    if (b.id.startsWith("tab.jump.")) continue;
    if (b.id === "tab.next" || b.id === "tab.next.chord" || b.id === "tab.prev.chord") continue;
    if (!isBindingActive(b, state)) continue;
    items.push({
      key: b.statusBarKey ?? b.keys[0] ?? "",
      text: t(b.description as any),
    });
  }

  // 5. system: ?, Esc, q, Ctrl+q
  // help は常に
  const help = bindings.find((b) => b.id === "sys.help");
  if (help && isBindingActive(help, state)) {
    items.push({ key: "?", text: t("key_help" as any) });
  }
  // Esc は global / 任意 focus で表示（globalまたは tasks/journal/log/artifacts/settings/issues/metrics のすべて）
  items.push({ key: "Esc", text: t("key_cancel" as any) });
  // global focus 時のみ q / Ctrl+q / Ctrl+r
  if (state.focusedArea === "global") {
    items.push({ key: "q", text: t("key_quit" as any) });
    items.push({ key: "Ctrl+q", text: t("key_full_quit" as any) });
    items.push({ key: "Ctrl+r", text: t("key_reload" as any) });
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Help overlay rows
// ─────────────────────────────────────────────────────────────────────────────

export type HelpRow = Readonly<{
  category: BindingCategory;
  /** 表示用キー文字列 (status bar と同じく statusBarKey 優先) */
  key: string;
  /** scope を表すラベル (e.g. "global" / "journal/log/metrics" / "issues/metrics") */
  scopeLabel: string;
  /** i18n 展開後の説明 */
  text: string;
  /** deprecated alias の場合 */
  deprecated?: boolean;
  /** deprecated の代替キー */
  replacement?: string;
}>;

function describeScope(scope: BindingScope): string {
  switch (scope.kind) {
    case "global":
      return "global";
    case "focus":
      return scope.areas.join("/");
    case "tab":
      return scope.tabs.join("/");
  }
}

/**
 * help overlay 用の行配列を category 順で返す。
 * deprecated 行も末尾に含める（"Deprecated" セクションとして扱える）。
 */
export function buildHelpOverlayRows(
  bindings: ReadonlyArray<BindingSpec>,
): ReadonlyArray<HelpRow> {
  const ORDER: ReadonlyArray<BindingCategory> = [
    "system", "navigation", "tab", "open", "action",
  ];
  const rows: HelpRow[] = [];
  for (const cat of ORDER) {
    for (const b of bindings) {
      if (b.category !== cat) continue;
      if (b.deprecated) continue;
      rows.push({
        category: cat,
        key: b.statusBarKey ?? b.keys.join("/"),
        scopeLabel: describeScope(b.scope),
        text: t(b.description as any),
      });
    }
  }
  // Deprecated を最後にまとめる
  for (const b of bindings) {
    if (!b.deprecated) continue;
    rows.push({
      category: b.category,
      key: b.statusBarKey ?? b.keys.join("/"),
      scopeLabel: describeScope(b.scope),
      text: t(b.description as any),
      deprecated: true,
      replacement: b.deprecatedReplacement,
    });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation (起動時に呼ぶ)
// ─────────────────────────────────────────────────────────────────────────────

export type RegistryValidationError = Readonly<{
  code:
    | "DUPLICATE_ID"
    | "INVALID_KEY"
    | "CHORD_PREFIX_CONFLICT"
    | "WHEN_AND_CHORD_CONFLICT";
  detail: string;
}>;

/**
 * registry の整合性をチェックする。
 *
 * チェック項目:
 *   - id が一意
 *   - 各 keys が parseKeySequence で valid
 *   - C5 (chord prefix conflict): chord ("g g") と単発 ("g") の prefix が衝突しないこと
 *
 * 違反があれば最初の 1 件を throw する。
 */
export function validateRegistry(bindings: ReadonlyArray<BindingSpec>): void {
  // 1. id 一意
  const seenIds = new Set<string>();
  for (const b of bindings) {
    if (seenIds.has(b.id)) {
      throwError({
        code: "DUPLICATE_ID",
        detail: `binding id "${b.id}" is duplicated`,
      });
    }
    seenIds.add(b.id);
  }

  // 2. parseKeySequence で valid
  // 同時に prefix conflict を検出するため key 文字列を ParsedKey 列に正規化
  type Parsed = { id: string; key: string; tokens: string[] };
  const parsed: Parsed[] = [];
  for (const b of bindings) {
    for (const k of b.keys) {
      const r = parseKeySequence(k);
      if (!r.ok) {
        throwError({
          code: "INVALID_KEY",
          detail: `binding "${b.id}" has invalid key "${k}": ${r.error.detail}`,
        });
      }
      // 文字列レベルで token 列を作る（"g g" → ["g","g"], "ctrl+r" → ["ctrl+r"]）
      const tokens = k.split(/\s+/).filter(Boolean);
      parsed.push({ id: b.id, key: k, tokens });
    }
  }

  // 3. chord prefix conflict (C5)
  //    単発 ["g"] と chord ["g","g"] のように、ある entry の tokens 列が
  //    別 entry の strict prefix になっていたら違反。
  //    ただし全く同じ key 列の重複は buildAppKeys で「順次 dispatch」する設計
  //    なので許容する (同 key 衝突は scope/when で出し分け)。
  for (const a of parsed) {
    for (const b of parsed) {
      if (a === b) continue;
      if (a.tokens.length >= b.tokens.length) continue;
      let isPrefix = true;
      for (let i = 0; i < a.tokens.length; i++) {
        if (a.tokens[i] !== b.tokens[i]) {
          isPrefix = false;
          break;
        }
      }
      if (isPrefix) {
        throwError({
          code: "CHORD_PREFIX_CONFLICT",
          detail:
            `single key "${a.key}" (${a.id}) is a prefix of chord "${b.key}" (${b.id}). ` +
            `Per rezi-ui chordMatcher (C5), the single key fires first and the chord never matches.`,
        });
      }
    }
  }
}

function throwError(err: RegistryValidationError): never {
  const e = new Error(`[dashboard-keymap] ${err.code}: ${err.detail}`);
  (e as any).validationError = err;
  throw e;
}
