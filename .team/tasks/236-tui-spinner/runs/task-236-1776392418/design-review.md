# T236 TUI Agent Spinner — Design Review

## Verdict: Approved

## Summary

計画は Conductor 既存の status パターン（starting/running/idle）を Agent に対称的に導入し、dashboard は既存 `SPINNER_FRAMES` / `spinnerFrame` を再利用する一貫した設計になっている。実コード（`schema.ts:148-156`, `daemon.ts:1018-1034 / 1131-1148 / 1522-1548 / 1604-1674 / 818-824 / 2189-2206`, `dashboard.tsx:489-511 / 1319-1335`）と 10 サブタスク＋削除確認の対応は整合しており、CRITICAL チェック項目（サブタスクカバレッジ・統合検証・削除タスク・既存テスト影響）は全てパスする。Minor 指摘のみのため Approved とし、下記 Recommendations を実装時に反映することを推奨する。

## Findings

1. **[minor] 状態遷移図が実装タスクより広い**
   状態遷移図には「次の SESSION_STARTED / SESSION_ACTIVE / SESSION_STOP(ASK 以外) で status=running に復帰」と書かれているが、実装タスク（#3）は SESSION_STARTED のみに status=running を入れる。`daemon.ts:1373-1416` の `SESSION_ACTIVE` には現状 Master / Conductor 分岐しかなく Agent 分岐自体がない。Agent の SESSION_ACTIVE / SESSION_STOP は契約上到達しない or SESSION_STARTED / SESSION_IDLE に集約される前提なら、状態遷移図の表現を実装タスクのスコープに合わせて限定するのが読み手にやさしい。

2. **[minor] サブタスク #11 は #8 と重複**
   #8 の「完全置換」と #11 の「旧描画削除確認」は実質同じ作業を二重に記述している。plan 自身 #11 末尾で「#8 内で Edit により置換されるため独立した Delete ステップは発生しない」と補足しているとおり、#8 の完了条件に「旧 `${icon} ${label}` 描画を残さない」を明示するだけで十分。ただし CRITICAL チェックの「削除タスクの完全性」に照らすと #11 が存在すること自体は減点要素ではなく、冗長性の指摘に留める。

3. **[minor] `spinnerInterval` の Master 条件との非対称**
   #9 の `needsAnimation` 拡張は Agent の `running || starting` を OR する。一方、既存条件は Master が `status === "running"` のみで `starting` を含まない（`dashboard.tsx:1323`）。計画の D6 方針（starting も spinner を回す）を Agent に適用する際、Master の starting は短命でも同じポリシーの方が一貫する。本タスクの範囲外でよいが、Recommendations で軽く触れる。

4. **[minor] 検証コマンドの環境依存**
   #1 の `grep -n "status:" … | grep -A0 "AgentState"` は BSD grep では `-A0` が通常動作するものの、plan 自身が直下で `rg -n` 版を追記しているとおり ripgrep が推奨。運用上は問題ないが、チーム標準の `rg` に統一するのが明快。

5. **[minor] D9 フォールバック値 "idle" の TUI 表示ギャップ**
   restoredAgents のフォールバックを `"idle"` にするため、daemon 再起動直後は PID が生きている Agent でも TUI 上 spinner が回らない。`SESSION_STARTED` / `SESSION_IDLE` / `SESSION_CLEAR` の到達までは idle 表示となる。実害は次の hook シグナルで解消するため許容範囲だが、「再起動直後は数秒 spinner が出ない可能性あり」を Decision Log に付記しておくと観測上の驚きを減らせる。

## Recommendations

以下は Minor のため Approved の判定を変更しないが、実装時に反映を推奨する:

- **R1（Finding 1）**: 「2. 技術アプローチ」の状態遷移図から `SESSION_ACTIVE` / `SESSION_STOP(ASK 以外)` の分岐を削除し、「SESSION_STARTED で running に遷移、SESSION_IDLE / SESSION_CLEAR で idle / running(リセット) に遷移」だけに単純化する。あるいは注記として「Agent は現状 SESSION_STARTED / SESSION_IDLE / SESSION_CLEAR / SESSION_ENDED 経路のみを使う契約（`main.ts:cmdSpawnAgent` 参照）。SESSION_ACTIVE / SESSION_STOP の Agent 分岐は本タスクの範囲外（将来 ASK 拡張と併せて検討）」を加える。
- **R2（Finding 2）**: #11 を削除し、#8 の「完了条件」に次の 1 行を追加する:
  - 「旧 `ui.row({ gap: 1 }, [ ui.text(..., dim), ui.text(`[${surface}]`), ui.text(\`${icon} ${label}\`) ])` の固定描画が dashboard.tsx 内に残らないこと（ただし idle 分岐で `${icon} ${label}` を使う場合は可）」。
- **R3（Finding 3）**: #9 の `needsAnimation` 拡張と同じ修正で、Master 側条件も `m.status === "running" || m.status === "starting"` に揃える（MASTER 新規の短時間 starting でも spinner が回るようにする）。これはレイアウトとしては regression ではなく改善だが、本タスクを超えるスコープ変更なので別サブタスクまたは別タスクでも可。
- **R4（Finding 5）**: Decision Log D9 の注記を「`status` 永続値が欠落した場合は `"idle"` にフォールバックする。daemon 再起動直後、PID 生存中の Agent でも `SESSION_STARTED` / `SESSION_IDLE` 到達まで idle 表示となる（数秒）」に更新する。

## CRITICAL チェック項目

| 項目 | 結果 | 根拠 |
|---|---|---|
| サブタスクカバレッジ | PASS | 変更対象（schema / daemon × 6 分岐 / dashboard × 2 箇所）が #1〜#9 に 1 対 1 で対応。 |
| 統合テスト/検証 | PASS | #10 が E2E 手動検証として起動〜spawn-agent〜idle〜kill-agent〜stop 後の team.json 確認までをカバー。「Conductor idle + Agent running」ケースの spinner 動作確認も含む。 |
| 削除タスクの完全性 | PASS | #8 の完全置換 + #11 の残骸確認で旧 Agent 行描画の除去を担保。 |
| 既存テストへの影響 | N/A | リポジトリに自動テストフレームワークなし（CLAUDE.md 明記）。型検証は 6.1 で clean baseline 確認済み、#1 完了後に `bunx tsc --noEmit` を回す方針も明記。 |

## 実コード整合性確認

- `schema.ts:148-156` `AgentState` に `status` フィールドが未定義 — 計画 #1 で追加対象、整合。
- `daemon.ts:1018-1034` `AGENT_SPAWNED` push 箇所存在 — #2 対象、整合。
- `daemon.ts:1131-1148` `SESSION_STARTED` の Agent 逆引きループ存在 — #3 対象、整合。
- `daemon.ts:1522-1548` `SESSION_IDLE` の Agent 逆引きループ存在、`agents` splice なし（既存方針保持） — #4 対象、整合。
- `daemon.ts:1604-1674` `SESSION_CLEAR` 現状 Master / Conductor のみ — #5 で Agent 分岐追加、整合。
- `daemon.ts:818-824` `restoredAgents` map — #6 で status 復元追加、整合。
- `daemon.ts:2189-2206` `updateTeamJson` の agents map — #7 で status 追加、整合。
- `dashboard.tsx:489-511` Agent ループ、`dashboard.tsx:1319-1335` `needsAnimation` 判定 — #8 / #9 で改修、整合。
- `dashboard.tsx:319` `SPINNER_FRAMES`、`dashboard.tsx:361,396,407,477` 既存 spinner 使用箇所 — 計画の再利用方針と整合。
