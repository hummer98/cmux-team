import { describe, test, expect } from "bun:test";
import { classifyStopPayload, QUESTION_CHAR_LIMIT } from "./classify-stop";

function makeTranscript(assistantMessages: any[], prefix: any[] = []): string {
  const lines: string[] = [];
  for (const m of prefix) lines.push(JSON.stringify(m));
  for (const m of assistantMessages) lines.push(JSON.stringify(m));
  return lines.join("\n") + "\n";
}

function makeAssistant(content: any[]): any {
  return { type: "assistant", message: { content } };
}

function makeCtx(transcript: string | null) {
  return {
    readTranscriptTail: () => transcript,
  };
}

describe("classifyStopPayload", () => {
  test("1. Case A (ASK) — Agent で AskUserQuestion を含む", () => {
    const transcript = makeTranscript([
      makeAssistant([
        { type: "text", text: "どの方式にする?" },
        { type: "tool_use", name: "AskUserQuestion", input: {} },
      ]),
    ]);
    const result = classifyStopPayload(
      { transcript_path: "/tmp/t.jsonl" },
      makeCtx(transcript),
    );
    expect(result).toEqual({ kind: "ASK", question: "どの方式にする?" });
  });

  test("2. ASK は呼び出し側コンテキストに依存しない", () => {
    const transcript = makeTranscript([
      makeAssistant([
        { type: "text", text: "どうする?" },
        { type: "tool_use", name: "AskUserQuestion", input: {} },
      ]),
    ]);
    const result = classifyStopPayload(
      { transcript_path: "/tmp/t.jsonl" },
      makeCtx(transcript),
    );
    expect(result.kind).toBe("ASK");
    if (result.kind === "ASK") expect(result.question).toBe("どうする?");
  });

  test("4. text のみは IDLE（呼び出し側コンテキスト不問）", () => {
    const transcript = makeTranscript([
      makeAssistant([{ type: "text", text: "考え中..." }]),
    ]);
    const result = classifyStopPayload(
      { transcript_path: "/tmp/t.jsonl" },
      makeCtx(transcript),
    );
    expect(result).toEqual({ kind: "IDLE" });
  });

  test("5. Case C — tool_use / tool_result あり", () => {
    const transcript = makeTranscript([
      makeAssistant([
        { type: "tool_use", name: "Read", input: {} },
        { type: "tool_result", content: "..." },
      ]),
    ]);
    const result = classifyStopPayload(
      { transcript_path: "/tmp/t.jsonl" },
      makeCtx(transcript),
    );
    expect(result).toEqual({ kind: "IDLE" });
  });

  test("6. text + tool 混在は IDLE", () => {
    const transcript = makeTranscript([
      makeAssistant([
        { type: "text", text: "実行します" },
        { type: "tool_use", name: "Bash", input: {} },
      ]),
    ]);
    const result = classifyStopPayload(
      { transcript_path: "/tmp/t.jsonl" },
      makeCtx(transcript),
    );
    expect(result).toEqual({ kind: "IDLE" });
  });

  test("7. transcript_path 不在は IDLE", () => {
    const result = classifyStopPayload(
      {},
      makeCtx("should-not-be-read"),
    );
    expect(result).toEqual({ kind: "IDLE" });
  });

  test("8. transcript 読込失敗 (null) は IDLE", () => {
    const result = classifyStopPayload(
      { transcript_path: "/tmp/nope" },
      makeCtx(null),
    );
    expect(result).toEqual({ kind: "IDLE" });
  });

  test("9. JSONL 破損行混在 — 最終 assistant 行が正常なら拾う", () => {
    const lines = [
      JSON.stringify(makeAssistant([{ type: "text", text: "前" }])),
      "{this is broken json",
      JSON.stringify(
        makeAssistant([
          { type: "text", text: "q?" },
          { type: "tool_use", name: "AskUserQuestion", input: {} },
        ]),
      ),
    ];
    const transcript = lines.join("\n") + "\n";
    const result = classifyStopPayload(
      { transcript_path: "/tmp/t.jsonl" },
      makeCtx(transcript),
    );
    expect(result.kind).toBe("ASK");
    if (result.kind === "ASK") expect(result.question).toBe("q?");
  });

  test("9b. 最終 assistant 行だけ破損 — 直前の assistant 行を拾う", () => {
    // 「最終 assistant 行のみ破損」でも findLastAssistant は逆順走査するため、
    // 直前の assistant 行が拾われる。
    const lines = [
      JSON.stringify(makeAssistant([{ type: "text", text: "考え中..." }])),
      '{"type":"assistant","mes', // 壊れた assistant らしき行
    ];
    const transcript = lines.join("\n") + "\n";
    const result = classifyStopPayload(
      { transcript_path: "/tmp/t.jsonl" },
      makeCtx(transcript),
    );
    // 直前の assistant 行（text のみ） → T208 以降は IDLE
    expect(result).toEqual({ kind: "IDLE" });
  });

  test("10. assistant 行なし (user だけ) は IDLE", () => {
    const transcript = [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify({ type: "user", message: { content: "hello" } }),
    ].join("\n");
    const result = classifyStopPayload(
      { transcript_path: "/tmp/t.jsonl" },
      makeCtx(transcript),
    );
    expect(result).toEqual({ kind: "IDLE" });
  });

  test("11. question 4KB 超過は 4096 chars に切り詰め", () => {
    const longText = "a".repeat(10000);
    const transcript = makeTranscript([
      makeAssistant([
        { type: "text", text: longText },
        { type: "tool_use", name: "AskUserQuestion", input: {} },
      ]),
    ]);
    const result = classifyStopPayload(
      { transcript_path: "/tmp/t.jsonl" },
      makeCtx(transcript),
    );
    expect(result.kind).toBe("ASK");
    if (result.kind === "ASK") expect(result.question.length).toBe(QUESTION_CHAR_LIMIT);
  });

  test("12. AskUserQuestion 直前に複数 text — 最後の text を採用", () => {
    const transcript = makeTranscript([
      makeAssistant([
        { type: "text", text: "aaa" },
        { type: "text", text: "bbb" },
        { type: "tool_use", name: "AskUserQuestion", input: {} },
      ]),
    ]);
    const result = classifyStopPayload(
      { transcript_path: "/tmp/t.jsonl" },
      makeCtx(transcript),
    );
    expect(result.kind).toBe("ASK");
    if (result.kind === "ASK") expect(result.question).toBe("bbb");
  });

  test("13. text に埋め込み改行 — 全文が入る (shell と差分あり)", () => {
    const transcript = makeTranscript([
      makeAssistant([
        { type: "text", text: "行1\n行2\n行3" },
        { type: "tool_use", name: "AskUserQuestion", input: {} },
      ]),
    ]);
    const result = classifyStopPayload(
      { transcript_path: "/tmp/t.jsonl" },
      makeCtx(transcript),
    );
    expect(result.kind).toBe("ASK");
    if (result.kind === "ASK") expect(result.question).toBe("行1\n行2\n行3");
  });

  test("14. UTF-8 日本語 5000 文字超は 4096 文字切り詰めで UTF-8 として valid", () => {
    const longJp = "あ".repeat(5000);
    const transcript = makeTranscript([
      makeAssistant([
        { type: "text", text: longJp },
        { type: "tool_use", name: "AskUserQuestion", input: {} },
      ]),
    ]);
    const result = classifyStopPayload(
      { transcript_path: "/tmp/t.jsonl" },
      makeCtx(transcript),
    );
    expect(result.kind).toBe("ASK");
    if (result.kind === "ASK") {
      expect(result.question.length).toBe(QUESTION_CHAR_LIMIT);
      // UTF-8 として valid（途中切断で壊れた byte sequence が無いこと）
      // JS string は UTF-16 なので .slice は surrogate pair を壊さない限り valid。
      // 「あ」は BMP 内の 1 code unit なので絶対壊れない。
      expect(result.question).toBe("あ".repeat(QUESTION_CHAR_LIMIT));
    }
  });

  test("15. T208: 多数の tool_use の後、最後のターンが text-only end_turn でも IDLE（A[191] 再現）", () => {
    // A[191] 縮退版: 40 ターンの tool_use のあと、最後の 1 ターンだけ text-only。
    // Stop hook は最後の end_turn でしか発火しないため、classifier が見るのは最後の 1 行のみ。
    const earlyTurns = Array.from({ length: 40 }, (_, i) =>
      makeAssistant([{ type: "tool_use", name: "Write", input: { i } }]),
    );
    const lastTurn = makeAssistant([{ type: "text", text: "plan.md を出力しました。" }]);
    const transcript = makeTranscript([...earlyTurns, lastTurn]);

    const result = classifyStopPayload(
      { transcript_path: "/tmp/t.jsonl" },
      makeCtx(transcript),
    );
    expect(result).toEqual({ kind: "IDLE" });
  });

  test("16. 空 content の assistant 行は IDLE", () => {
    const transcript = makeTranscript([makeAssistant([])]);
    const result = classifyStopPayload(
      { transcript_path: "/tmp/t.jsonl" },
      makeCtx(transcript),
    );
    expect(result).toEqual({ kind: "IDLE" });
  });
});
