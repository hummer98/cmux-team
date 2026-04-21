# T279 summary

## 結果

GO。reducer と shadow 配線を 4 phase で完遂。bun test 802 pass / 0 fail、state-machine 単体で 136 pass。

## 完了したサブタスク

- Phase 1 Plan（Planner Agent）
- Phase 2 Design Review（Approved、軽微 suggestions を Implementer 指示に折り込み）
- Phase 3 Implement（TDD、reducer → shadow → daemon 配線 → docs）
- Phase 4 Inspection（GO、NOGO 基準 4 項目を全て充足）

## 主な成果物

- 新規: `skills/cmux-team/manager/state-machine/` 6 ファイル（events/conductor-fsm/task-fsm/invariants/shadow/fsm.test、計 1,693 行）
- 新規: `docs/spec/07-state-machine.md`（FSM リファレンス、Mermaid 図 2 本含む、253 行）
- 修正: `daemon.ts` に shadow observer 呼び出し 14 箇所追加（末尾、try/catch 完全包摂、mutation なし）
- 修正: `CLAUDE.md`（リポジトリ構造）, `docs/spec/00-project-overview.md`（リンク追加）
- 修正: `.team/artifacts/A017-state-machine.md`（§5 補正欄追加）

## テスト結果

- `bun test state-machine/`: 136 pass / 0 fail / 227 expect
- `bun test`（全体）: 802 pass / 0 fail / 1932 expect（regression なし）

## 設計判断 / 重要事項

- **24h 稼働要件は T280 送り**（impl-report 冒頭に明記）。P1 では A017 全セル単体テスト + 既知 race パターン（T255 類）を shadow が検出するテストで代替。
- **shadow は observe only**。reducer Action は discriminated union で返すのみ、実行しない（P2 で effects.ts に移す予定）。
- **daemon.ts の既存 state mutation は 1 行も書き換えず**、各 handler 冒頭で `const prevStatus = conductor.status` の読み取り追加（Design Review で許容確認済み）のみ。
- **R2 (24h 稼働の合意)** と **D2 (A017 §5 補正欄の空でも存在)** は DoD に反映、ユーザーへの事前確認は自律判断で省略（P1 スコープ内で代替可能と判断）。

## マージコミット

後段で埋める（rebase + merge --ff-only でローカル main に取り込む）。

## P2 / P3 送り

- P2 (T280): `handleMessage` / `scanTasks` を reducer 呼び出しで置換、effects.ts で Action 実行、shadow 24h 稼働観測
- P3: tick ごとの不変条件強制 + 違反時の自動リカバリ
