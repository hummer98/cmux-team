# T323 plan.md 設計レビュー (2)

## Verdict: Approved

## Summary

前回指摘した critical 2 件 / major 2 件 / minor 4 件はすべて対応済みで、観察経路 (R1 Option A) と Agent path (R2.B) の構造的整理が plan に反映された。
Decision Log の D12 / D13 / D14 / D15 の追記、サブタスク 2 / 9 の新規追加、各サブタスクへの「既存テスト更新」項目の付与により、実装中の取りこぼしを防ぐ枠組みも揃った。
新規に発見した懸念はいずれも minor で、実装フェーズ内で吸収可能と判断する。

## 前回指摘への対応状況

### Finding #1 (critical) Master/Conductor の handle 解決経路 — **対応済み**

- §2.1 を **Option A** に書き換え、`x-cmux-surface` ヘッダーを `ANTHROPIC_CUSTOM_HEADERS` に追加する経路を確立。サブタスク 2 を新規追加。
- `generateMasterSettings(projectRoot, surface)` / `generateConductorSettings(projectRoot, surface)` のシグネチャ変更、per-surface settings.json (`${surface}-master-settings.json` / `${surface}-conductor-settings.json`) 化、proxy.ts:534 の `x-cmux-surface` 優先化、`x-cmux-conductor-id` を legacy fallback として残す方針が明記された。
- **検証: 実装上の前提は妥当**。
  - 現行コード (`proxy.ts:403`) は `/statusline` エンドポイントで既に `x-cmux-surface` を読んでおり、ヘッダー名は競合しない。
  - 既存 `generateMasterSettings` / `generateConductorSettings` の 3 つの呼び出し箇所 (`main.ts:2162` cmdConductor / `main.ts:2248` cmdResume / `main.ts:2300` cmdLaunchMaster) はいずれも surface 既知の文脈で、シグネチャ拡張は素直に当てられる。
  - `x-cmux-conductor-id` は実コード上どこからも書かれていない (write 元が存在しない) ため、legacy fallback として残す判断は安全。
- D1 / D13 の根拠も明確で、複数 Master / 複数 Conductor 構成での識別経路として構造的に正しい。

### Finding #2 (critical) AGENT_SPAWNED 順序問題 — **対応済み**

- §2.1 と D2 / D12 で **R2.B 採用**を明示。`AGENT_SPAWNED` の POST 位置・内容は不変、`AGENT_TOKEN_BOUND` を `selectToken` 成功直後に追加メッセージとして送る方針。サブタスク 6 で詳細が固まっている。
- D12 で「Keychain / DB アクセスは元々 selectToken 内で発生しており、本タスクでタイミングは変えていない」と T244 race への影響評価を明記。`selectToken` 失敗時には `AGENT_TOKEN_BOUND` を送らない、daemon 側で agent が見つからない race ケースは warning + state 不変化 とフォールバック規定も妥当。
- 現行 `cmdSpawnAgent` (`main.ts:2494-2562`) の構造とも整合: `AGENT_SPAWNED` 送信 (L2494) → exportVars 構築 → `selectToken` (L2550) → exportVars push (L2553) のフローに `AGENT_TOKEN_BOUND` 送信を L2553 直後に挿入できる。

### Finding #3 (major) 既存テスト影響対応 — **対応済み**

- サブタスク 1 (schema.test / daemon.test team.json snapshot)、サブタスク 2 (main.test:1832-1860 / proxy.test 期待値更新)、サブタスク 6 (daemon.test の AGENT_SPAWNED → AGENT_TOKEN_BOUND シーケンス)、サブタスク 7 (proxy.test の updateTokensDB シグネチャと role 別動作)、サブタスク 9 (token-cli.test 不破壊) が完了条件に明記された。
- サブタスク 12 で `bun test` 全通過を最終 gate として置く構造も維持されており、サブタスク間の取りこぼしリスクは低い。

### Finding #4 (major) formatUtil/formatReset 共有方針 — **対応済み**

- サブタスク 9 を新規追加し、`token-format.ts` への切り出しを完了条件として明記。`token-cli.ts:88-111` の internal 定義を export 化、両ファイルが import で共有する方針。コピペ重複禁止が D14 / R4 整合で担保される。

### Finding #5 (minor) 警告閾値と selectable 判定閾値の差別化 — **対応済み**

- D11 を rev 2 で具体化し、「警告閾値 = 表示用 / selectable 判定閾値 = pool 選択ブロッカー」の意味差を明記。サブタスク 5 の完了条件に「pool-surface-row.ts 冒頭コメントで明示」を追加。

### Finding #6 (minor) 罫線幅 50 と既存セクションヘッダー幅の整合性 — **対応済み**

- D10 を rev 2 で 60 文字に変更。
- 補足観察: 既存ヘッダーは `─ Master ──...` (`58 - title.length` repeat) / `─ Tasks ──... 51 dashes`(`main.ts:1396, 1423`) で 59〜61 文字幅とセクションごとに ±1 のばらつきがある。60 で揃える判断は実用上問題ない。

### Finding #7 (minor) サブタスク責務重複 — **対応済み**

- サブタスク 7 (cmdStatus 統合 / rev 2) からは routing を完全に除外し、サブタスク 10 (pool-cli.ts 実装 + `case "pool"`) に集約。D15 で経緯を記録。サブタスク 7 の完了条件 (a) には `case "pool"` 追加を含めない旨が明記されている。

### Finding #8 (minor) agents シリアライズの欠落 — **対応済み**

- D14 で「`spawnedAt` / `taskTitle` の欠落補修は本タスクスコープ外（別タスクで対応）」と明示。本タスクでは `tokenHandle` 追加のみに絞る判断。
- 現行コード (`daemon.ts:3576-3582`) で `spawnedAt` / `taskTitle` が出力されていない事実、および `restoreConductorState` (L946) のフォールバックで顕在化していない実情も整合。

## 新規 Findings

### N1. [minor] §3.1 / §2.5 の `formatSelectable` シグネチャ表記が現状実装と異なる

- plan §3.1 (`token-format.ts` の export) と §2.5 では `formatSelectable(selectable: boolean): string` と書かれているが、現状の `token-cli.ts:106` は `formatSelectable(tok: Token, snap: UsageSnapshot | null): string` で、`tok.selectable === false → "no"`、`util_5h > 0.95 → "blocked"`、それ以外 `"yes"` の 3 値を返す実装になっている。
- サブタスク 9 完了条件は「関数シグネチャと挙動は token-cli.ts 内の現行と完全一致させる（既存テスト破壊禁止）」と書かれているため、実装時の取り扱いは正しい方向に固まっているが、§3.1 / §2.5 の宣言が誤っており読者を混乱させる。
- 影響: 軽微（実装時に現行シグネチャを採用すれば実害なし）。
- 推奨: §3.1 / §2.5 の `formatSelectable` シグネチャ表記を `(tok: Token, snap: UsageSnapshot | null): string` に修正、または §2.5 の表で「現行 token-cli.ts のシグネチャをそのまま再利用（boolean 単独版は作らない）」を 1 行注記する。

### N2. [minor] `ANTHROPIC_CUSTOM_HEADERS` のカンマ併記が Claude Code に解釈される前提が事前検証未済

- §2.1 の Option A は「`ANTHROPIC_CUSTOM_HEADERS` のカンマ併記は既存の Claude Code 仕様内で成立する（複数ヘッダ列挙が許容される設計）」と書いているが、現在の実コードで実証済みなのは `"x-cmux-role: master"` 等の **単一ヘッダー** のみ。複数ヘッダーをカンマ + スペース区切りで併記した場合、Claude Code パーサが
  - (a) 複数 HTTP ヘッダーに分解してくれる
  - (b) 単一ヘッダー値として `master, x-cmux-surface: surface:90` をそのまま送る
  のどちらの挙動を取るかが、本 plan のレベルでは保証されていない。`proxy.ts:534` で `req.headers.get("x-cmux-role")` が連結文字列を返す場合、role 解決が壊れて巻き戻しが発生する。
- §5.1 のリスク表で「実装後に簡単な smoke テスト」が緩和策として書かれているが、サブタスク順序上はサブタスク 2 完了条件に smoke 検証ステップを **明示** する方が安全。
- 推奨:
  - サブタスク 2 完了条件に「proxy.ts のログに `x-cmux-role` / `x-cmux-surface` がそれぞれ独立した値として到達することを 1 回の手動 smoke で確認」を追加。
  - もし (b) 挙動が判明したら、Option A の代わりに以下のいずれかへフォールバックする方針を Decision Log に明示:
    - 改行 (`\n`) 区切りでの複数ヘッダー指定（Claude Code が改行区切りを受け付ける場合）
    - HTTP_PROXY 経路で proxy 側がヘッダーを後付けする経路（既存 `opts.role` / `opts.conductorSurface` の延長）

### N3. [minor] schema.ts のメッセージ union 名称が plan と異なる

- plan §3.2 の表では「`DaemonMessage` (Zod discriminated union) に `AgentTokenBound` を追加」と書かれているが、実コード (`schema.ts:148`) の union 名は `QueueMessage` (`export const QueueMessage = z.discriminatedUnion("type", [...])`)。
- 実装上は `QueueMessage` への追加で正しく解釈できるが、plan のドキュメントとしては名称が一致していない。
- 推奨: §3.2 の表記を `QueueMessage` に置換。サブタスク 1 完了条件の「`DaemonMessage.parse(...)` が成功する」も同じく `QueueMessage.parse(...)` に修正。

## Recommendations

新規 findings はいずれも minor のため、Approved 判定を覆す内容ではないが、実装着手前に以下を反映しておくと実装フェーズが滑らかになる:

- **R1 (N1 対応)**: §3.1 と §2.5 の `formatSelectable` シグネチャ表記を `(tok: Token, snap: UsageSnapshot | null): string` に揃える（または §2.5 表に 1 行注記）。
- **R2 (N2 対応)**: サブタスク 2 完了条件に「`x-cmux-role` / `x-cmux-surface` が proxy 側で独立 HTTP ヘッダーとして到達するかの smoke 検証」を 1 行追加し、§5.1 リスク表のフォールバック案（改行区切り / proxy 側付与）を Decision Log に書き起こす。
- **R3 (N3 対応)**: §3.2 / サブタスク 1 完了条件の `DaemonMessage` を `QueueMessage` に置換する。

これらを反映後、実装フェーズに進んで差し支えない。
