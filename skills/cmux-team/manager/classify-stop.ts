/**
 * T189: Stop hook payload 分類ロジック（Manager 側に集約）
 *
 * 旧 DETECT_ASK_SCRIPT (bash + jq + python3 fallback) の役割を純粋関数として切り出す。
 * shell 側は transcript_path を抽出するだけの forwarder に縮退する。
 *
 * 入力:
 *   - payload: Stop hook JSON payload から `transcript_path` のみ抽出した形
 *   - ctx:
 *       isConductor: Conductor 判定（Case B skip の除外に使う）
 *       readTranscriptTail: transcript ファイル末尾 N bytes を読む関数（DI）
 *
 * 判定順序:
 *   1. transcript_path 不在 / 読込失敗 → IDLE（fail-safe）
 *   2. 末尾から逆順に assistant 行を探し、見つけた最初の行を対象にする
 *   3. content[] 内の AskUserQuestion tool_use 件数と tool_use/tool_result 件数をカウント
 *   4. ask > 0 → ASK（question は最後の text 要素全文を chars で切り詰め）
 *   5. tool 件数 === 0 && !isConductor → SKIP (agent_monologue)
 *   6. それ以外 → IDLE
 */

export type StopClassification =
  | { kind: "ASK"; question: string }
  | { kind: "IDLE" }
  | { kind: "SKIP"; reason: "agent_monologue" };

export interface ClassifyContext {
  isConductor: boolean;
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
  let toolCount = 0;
  let lastText = "";
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "tool_use" && c.name === "AskUserQuestion") askCount++;
    if (c.type === "tool_use" || c.type === "tool_result") toolCount++;
    if (c.type === "text" && typeof c.text === "string") lastText = c.text;
  }

  if (askCount > 0) {
    const question = lastText.slice(0, QUESTION_CHAR_LIMIT);
    return { kind: "ASK", question };
  }
  if (toolCount === 0 && !ctx.isConductor) {
    return { kind: "SKIP", reason: "agent_monologue" };
  }
  return { kind: "IDLE" };
}
