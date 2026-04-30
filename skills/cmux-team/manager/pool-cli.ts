/**
 * pool-cli.ts (T323)
 *
 * `cmux-team pool status` サブコマンド。token pool 全アカウントの一覧を表示する。
 *
 * `token-format.ts` を共有して `cmux-team token list` と同じフォーマッタを利用する（DRY）。
 * pool 機能 OFF（CMUX_TEAM_TOKEN_POOL=0 / config / global yaml で無効）なら
 * 1 行メッセージで exit 0。
 */
import { isTokenPoolEnabled } from "./config";
import {
  initTokenDB,
  listTokens,
  getLatestUsageSnapshot,
  computePoolCapacity,
  type TokenForCapacity,
} from "./token-store";
import { formatReset, formatSelectable, formatPerHandleUtilCell } from "./token-format";

/** `cmux-team pool status` 本体。引数なしで呼ばれる。 */
export async function cmdPoolStatus(projectRoot: string): Promise<void> {
  let decision: { enabled: boolean; source: string };
  try {
    decision = (await isTokenPoolEnabled(projectRoot)) as any;
  } catch (e: any) {
    console.error(`Error: ${e?.message ?? e}`);
    process.exit(1);
  }
  if (!decision.enabled) {
    console.log(
      "pool 機能は無効です（CMUX_TEAM_TOKEN_POOL=1 / config / global yaml で有効化してください）。",
    );
    return;
  }

  const db = initTokenDB();
  const tokens = listTokens(db);

  if (tokens.length === 0) {
    console.log("(no tokens registered)");
    db.close();
    return;
  }

  // CAP の計算（全 token を一括で computePoolCapacity に渡す）
  const forCap: TokenForCapacity[] = tokens.map((t) => {
    const snap = getLatestUsageSnapshot(db, t.id);
    return {
      handle: t.handle,
      plan_ratio: t.plan_ratio,
      util_5h: snap?.util_5h ?? null,
      util_7d: snap?.util_7d ?? null,
      reset_5h_at: snap?.reset_5h_at ?? null,
      reset_7d_at: snap?.reset_7d_at ?? null,
    };
  });
  const cap = computePoolCapacity(forCap);
  const capByHandle = new Map(cap.per_token.map((p) => [p.handle, p.cap_pct]));

  // ヘッダー（T390: 行末に独立した MARK 列を置き、5H/7D と reset 通過マーカーを混同しないようにする）
  const header = [
    "HANDLE  ",
    "PLAN    ",
    "TAGS      ",
    "SEL  ",
    "CAP   ",
    "5H USE",
    "7D USE",
    "NEXT_RESET    ",
    "MARK",
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));

  // T390: marker 凡例を出すかの判定用。ループ内で 1 つでも marker が出れば true。
  const nowMs = Date.now();
  let anyMarker = false;

  for (const tok of tokens) {
    const snap = getLatestUsageSnapshot(db, tok.id);
    const sel = formatSelectable(tok, snap);
    const capPct = capByHandle.get(tok.handle);
    const capStr = capPct == null ? "--" : `${Math.round(capPct)}%`;

    // NEXT_RESET: 5h / 7d で先に到来する方
    const candidates: Array<{ label: string; ms: number }> = [];
    if (snap?.reset_5h_at) {
      const t = new Date(snap.reset_5h_at).getTime() - nowMs;
      if (t > 0) candidates.push({ label: `5h ${formatReset(snap.reset_5h_at)}`, ms: t });
    }
    if (snap?.reset_7d_at) {
      const t = new Date(snap.reset_7d_at).getTime() - nowMs;
      if (t > 0) candidates.push({ label: `7d ${formatReset(snap.reset_7d_at)}`, ms: t });
    }
    candidates.sort((a, b) => a.ms - b.ms);
    const nextReset = candidates[0]?.label ?? "--";

    // T390: per-handle 行は effUtil 表示。reset 通過済み stale token は MARK 列に "*"。
    const fmt = formatPerHandleUtilCell(snap, nowMs);
    if (fmt.marker !== "") anyMarker = true;

    const row = [
      tok.handle.padEnd(8),
      tok.plan.padEnd(8),
      tok.tags.join(",").slice(0, 10).padEnd(10),
      sel.padEnd(5),
      capStr.padEnd(6),
      fmt.display5h.padEnd(6),
      fmt.display7d.padEnd(6),
      nextReset.padEnd(14),
      fmt.marker,
    ].join("  ");
    console.log(row);
  }

  console.log("");
  console.log(
    `pool capacity: 5h ${Math.round(cap.capacity_5h_pct)}% / 7d ${Math.round(cap.capacity_7d_pct)}%`,
  );
  if (anyMarker) {
    console.log("(* = reset 通過済みで実質クリア)");
  }

  db.close();
}

/** Usage を 1 行で表示（`cmux-team pool` のみ / `--help` で呼ばれる） */
export function showPoolUsage(): void {
  console.log("Usage: cmux-team pool status");
  console.log("");
  console.log("Subcommands:");
  console.log("  status   全 token の使用状況と pool capacity を表示");
}
