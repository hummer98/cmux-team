/**
 * T208: Stop hook payload 分類ロジック（Manager 側に集約）
 *
 * Stop hook は `stop_reason === "end_turn"` の時にしか発火しないため、
 * classifier に到達する時点で「最後の assistant 行は必ずターン完了済み」である。
 * したがってモノローグ判定は不要であり、ここでは
 *   - AskUserQuestion を含むか (ASK)
 *   - それ以外 (IDLE)
 * の二択に縮退している。
 *
 * 旧 SKIP（agent モノローグ）パスは T204/A[191] 事例（Write 連打 → 最終ターンで
 * text-only な完了報告で永久ブロック）を踏まえて T208 で削除した。
 *
 * 入力:
 *   - payload: Stop hook JSON payload から `transcript_path` のみ抽出した形
 *   - ctx:
 *       readTranscriptTail: transcript ファイル末尾 N bytes を読む関数（DI）
 *
 * 判定順序:
 *   1. transcript_path 不在 / 読込失敗 / assistant 行なし → IDLE（fail-safe）
 *   2. 末尾から逆順に assistant 行を探し、最初に見つかった行を対象にする
 *   3. content[] 内に AskUserQuestion tool_use が 1 件以上あれば ASK
 *      （question は最後の text 要素全文を chars で切り詰め）
 *   4. それ以外は IDLE
 */

export type StopClassification =
  | { kind: "ASK"; question: string }
  | { kind: "IDLE" };

export interface ClassifyContext {
  readTranscriptTail: (path: string, bytes: number) => string | null;
}

export const DEFAULT_TAIL_BYTES = 16 * 1024;
export const QUESTION_CHAR_LIMIT = 4096;

interface ContentEntry {
  type?: string;
  name?: string;
  text?: string;
}

interface AssistantMessage {
  type?: string;
  message?: { content?: ContentEntry[] };
}

function tryParseLine(line: string): AssistantMessage | null {
  const s = line.trim();
  if (!s) return null;
  try {
    return JSON.parse(s) as AssistantMessage;
  } catch {
    return null;
  }
}

/** 末尾 tail から逆順に走査し、最初に見つかった assistant 行を返す */
function findLastAssistant(tail: string): AssistantMessage | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = tryParseLine(lines[i]!);
    if (obj && obj.type === "assistant") return obj;
  }
  return null;
}

export function classifyStopPayload(
  payload: { transcript_path?: string },
  ctx: ClassifyContext,
): StopClassification {
  const path = payload.transcript_path;
  if (!path) return { kind: "IDLE" };

  const tail = ctx.readTranscriptTail(path, DEFAULT_TAIL_BYTES);
  if (tail == null) return { kind: "IDLE" };

  const assistant = findLastAssistant(tail);
  if (!assistant) return { kind: "IDLE" };

  const content = assistant.message?.content ?? [];
  let askCount = 0;
  let lastText = "";
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "tool_use" && c.name === "AskUserQuestion") askCount++;
    if (c.type === "text" && typeof c.text === "string") lastText = c.text;
  }

  if (askCount > 0) {
    return { kind: "ASK", question: lastText.slice(0, QUESTION_CHAR_LIMIT) };
  }
  return { kind: "IDLE" };
}
