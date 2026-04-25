/**
 * pool-next-reset.ts (T323)
 *
 * selectable=true のトークンのうち、未来かつ最短の reset を選び、
 * その reset 軸を nowIso に置換した状態で computePoolCapacity を再計算して
 * 現状との差分（deltaPct）を返す純粋関数。
 *
 * 設計の意図:
 *   - A019 検証ケースでは「7d 律速」が支配的で 5h reset では cap が動かないケースが多い。
 *     それでも仕様通り「最も早い reset」を採用する（ユーザーが「次に何が起きるか」を知りたい）。
 *   - plan_ratio が null のトークンは pool capacity 寄与しないので候補から除外する。
 */
import { computePoolCapacity, type TokenForCapacity } from "./token-store";

export interface NextResetTokenInput {
  handle: string;
  plan_ratio: number | null;
  util_5h: number | null;
  util_7d: number | null;
  reset_5h_at: string | null;
  reset_7d_at: string | null;
  selectable: boolean;
}

export interface NextResetInput {
  tokens: NextResetTokenInput[];
  nowIso?: string;
}

export interface NextResetResult {
  handle: string;
  window: "5h" | "7d";
  remainingMs: number;
  deltaPct: number;
}

interface Candidate {
  handle: string;
  window: "5h" | "7d";
  resetAt: string;
  remainingMs: number;
  tokenIndex: number;
}

export function computeNextReset(input: NextResetInput): NextResetResult | null {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const nowMs = new Date(nowIso).getTime();

  const eligible = input.tokens
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.selectable && t.plan_ratio != null);
  if (eligible.length === 0) return null;

  const candidates: Candidate[] = [];
  for (const { t, i } of eligible) {
    if (t.reset_5h_at) {
      const ms = new Date(t.reset_5h_at).getTime() - nowMs;
      if (ms > 0) {
        candidates.push({
          handle: t.handle,
          window: "5h",
          resetAt: t.reset_5h_at,
          remainingMs: ms,
          tokenIndex: i,
        });
      }
    }
    if (t.reset_7d_at) {
      const ms = new Date(t.reset_7d_at).getTime() - nowMs;
      if (ms > 0) {
        candidates.push({
          handle: t.handle,
          window: "7d",
          resetAt: t.reset_7d_at,
          remainingMs: ms,
          tokenIndex: i,
        });
      }
    }
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.remainingMs - b.remainingMs);
  const next = candidates[0]!;

  const baseTokens: TokenForCapacity[] = input.tokens.map((t) => ({
    handle: t.handle,
    plan_ratio: t.plan_ratio,
    util_5h: t.util_5h,
    util_7d: t.util_7d,
    reset_5h_at: t.reset_5h_at,
    reset_7d_at: t.reset_7d_at,
  }));
  const baseCap = computePoolCapacity(baseTokens, nowIso).capacity_pct;

  const afterTokens: TokenForCapacity[] = input.tokens.map((t, i) => {
    if (i !== next.tokenIndex) return { ...t };
    if (next.window === "5h") {
      return { ...t, util_5h: 0, reset_5h_at: nowIso };
    }
    return { ...t, util_7d: 0, reset_7d_at: nowIso };
  });
  const afterCap = computePoolCapacity(afterTokens, nowIso).capacity_pct;

  return {
    handle: next.handle,
    window: next.window,
    remainingMs: next.remainingMs,
    deltaPct: Math.round(afterCap - baseCap),
  };
}
