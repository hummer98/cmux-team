# T407 Design Review (Round 2): spawn 時 session_id pre-inject + task_sessions 正常化

レビュア: Design Reviewer Agent (surface:585, rev2)
レビュー対象: `runs/task-407-1777602177/plan.md` (Rev 2)
前回 review: `runs/task-407-1777602177/design-review.md` (Round 1)

## 判定

**Approved**

前回の Critical 4 点 (C1=A, C2 採用, C3 採用, C4=A) はすべて方針通り plan に反映されており、
Recommendations R1〜R6 もすべて plan の該当 Step に取り込まれている。
新たな Critical Issues は無い。本タスクは plan に従って TDD で実装に進んでよい。

## 前回 Critical Issues の対応状況

### C1. Master 起動行は task_sessions に存在しない → 方針 A で対応 ✓

- 改訂履歴 (line 12) で「C1 採用方針 A: Master を本タスク scope から外す」と明記。
- 影響表から `cmdLaunchMaster` 行が削除されている (line 22-33)。
- `MasterRegisteredMessage` は schema 改訂対象から外れている (Step 1, line 43: 「`MasterRegisteredMessage` は **scope 外** として一切触らない」)。
- 受け入れ条件 1 が「(Conductor/Agent)」に縮小 (line 211, line 285)。
- スコープ外セクション (line 273) に「Master の pre-inject — `task_sessions` に Master 起動行が存在しないため、pre-inject の効用が in-memory state.sessionId のみで集計に効かない」と理由付きで明記。
- **適切に対応されている。**

### C2. trace-store CTE の `session_id != ''` 欠落 → 採用 ✓

- Step 2 (line 52-67) で 3 関数すべての CTE に `AND session_id IS NOT NULL AND session_id != ''` を追加する SQL を具体的に提示。
- hook_signals 側 join 条件にも `LEFT JOIN session_to_task s2t ON h.session_id = s2t.session_id AND h.session_id != ''` の防御を追加。
- 空 session_id 防御の **regression test** を Step 2 fixture 4 として追加 (line 51: 「**(C2) 空 session_id 防御**: 空 session_id の `agent_spawned` 行 + 空 session_id の hook_signals を 1 件ずつ混ぜ、それらが集計から除外されることを assert (regression test)」)。
- CTE コメントに「2 events を採用する根拠 + `session_id != ''` 防御の根拠」を残す指示も含まれている (line 68)。
- **適切に対応されている。**

### C3. POST 順序逆転時の sessionId 上書き race → 採用 ✓

- Step 3 (line 77-87) で daemon の CONDUCTOR_REGISTERED ハンドラに以下を実装する条件分岐が明示されている:
  ```typescript
  if (message.sessionId) {
    if (!state.sessionId) {
      state.sessionId = message.sessionId;
    } else if (state.sessionId !== message.sessionId) {
      logger.warn("session_id_mismatch_at_register_late", { ... });
      // 採用しない
    }
  }
  ```
- AGENT_SPAWNED ハンドラにも同等のロジックを Step 4 (line 92) で適用。
- **後着 mismatch 専用の test (T-12 新設)** を Step 3 と Step 4 両方で追加 (line 75: 「SESSION_STARTED → CONDUCTOR_REGISTERED (sessionId 異なる) の順序で state.sessionId が hook 側のまま維持される」)。
- 整合性チェック判定表 (line 196-205) で 8 ケースすべての挙動を網羅しており、「`*_REGISTERED` 受信時 既存 && message.sessionId と異なる → warn + 既存維持 (hook 側信頼)」の方針が表で確認できる。
- **適切に対応されている。**

### C4. task_sessions.session_id の mutation 設計 → 方針 A で対応 ✓

- 改訂履歴 (line 15) で「C4 採用方針 A: `task_sessions` は append-only を維持。`updateTaskSessionLatest` 経路は導入しない」と明記。
- Step 8 (line 124-131) は「Rev 1 の Step 8 (`updateTaskSessionLatest` 経路追加) は **削除**」と明示し、本タスクでは UPDATE 経路を導入しないことを断言。
- /clear / /compact 後の追従は task-state.json の sessionId 更新のみ (既存 T203 経路) で完結する設計に変更。
- スコープ外セクション (line 274) に「`task_sessions` テーブルへの UPDATE 経路導入 — append-only 不変性を維持」を明記。
- 「/clear 後に新 UUID で `task_sessions` 行を追加するか」は別タスクとして残す旨もスコープ外で明記 (line 275)。
- 完了条件 (line 286) も「`task_sessions` は append-only 維持」に修正済。
- **適切に対応されている。** 履歴復元・trace 再生用途への影響を回避できる選択。

## 前回 Recommendations の対応状況

### R1. CTE 拡張時の重複検出テストを追加 ✓

- Step 2 fixture 2 (line 49) で「**(R1) 重複検出**: 同 task_id=Tn に対し `(assigned, U_c)` と `(agent_spawned, U_a)` が併存し、hook_signals に `session_id=U_c, U_a` が 1 件ずつ → 結果 `(Tn, n=2)` であることを assert (二重カウントしない)」を明記。
- Step 2 fixture 3 (line 50) で「**(R1) 異常状態保護**: 同 session_id に複数 task_id が紐づく fixture で MIN(task_id) が決定論的に 1 つ返る assert」も追加。
- **適切に対応されている。**

### R2. SESSION_STARTED の `source` 判定を厳密化 ✓

- 改訂履歴 (line 16) で「source=undefined の挙動明記 (Step 7)」と明示。
- Step 7 fixture 3 (line 117) で「**(R2) source=undefined** (legacy hook 経路): warn 無しで上書き = legacy 互換動作」を明記。
- 整合性チェック判定表 (line 205) でも「SESSION_STARTED `source=undefined` (legacy) → warn なし、hook 側で上書き」を明示。
- 推奨案 1 (旧版互換 = warn 無し上書き) が採用されており、運用上のノイズ増加を回避。
- **適切に対応されている。**

### R3. `--resume` 経路の挙動確認をスコープ外として明記 ✓

- スコープ外セクション (line 280) に「`--session-id` を `--resume` 経路にも適用するか — 現状は付けない方針。resume が新 UUID を払い出す挙動が観測されたら別タスクで再評価」を明記。
- 「背景: `--session-id` フラグの実機確認内容」(line 264-269) で「(b)(c) 本タスクスコープ外」と確認内容の境界を明示。
- Step 5 (line 99) で `cmdResume` には `--session-id` を渡さない方針も plan 本文で確認。
- **適切に対応されている。**

### R4. 受け入れ条件 1 の文言修正 ✓

- 受け入れ条件 1 (line 211) は「spawn 時 task_sessions の `assigned` / `agent_spawned` 行に session_id が空でなく埋まる (Conductor/Agent)」に修正済。
- 完了条件 (line 285) も「`assigned` / `agent_spawned` 行」「(Conductor/Agent)」に修正済。R4 反映 を line 285 末尾で明示。
- **適切に対応されている。**

### R5. token-pool inline env prefix と `--session-id` の test 並列性 ✓

- Step 6 fixture 2 (line 106) で「**(R5) token-pool prefix 並列性**: `tokenInjected=true` (inline env prefix あり) と `tokenInjected=false` (prefix なし) の 2 fixture でいずれも `--session-id` が claude binary 引数として正しく付与されることを assert」を明記。
- plan §token-pool / inline env prefix との順序 (line 257-258) でも 2 fixture を持つことを再確認。
- **適切に対応されている。**

### R6. metrics-cli.test の e2e fixture を「pre-inject 後」を想定して更新 ✓

- Step 9 (line 136-142) で「**(R6) e2e fixture**」として 4 軸集計 (tool counts / first edit / failure rate / token usage) すべてが task_id 解決して集計されることを assert する fixture を具体化。
- 「既存『unattached』表示が新 fixture で 0 件にならないこと (空 session_id 行が混ざる別 fixture で regression を含む)」も明記。
- **適切に対応されている。**

## 新たな Critical Issues

なし。

## 新たな Recommendations

### N1. Step 8 の no-op step 化に伴う step 数表記の整理 (任意)

Rev 2 の Step 8 は「`updateTaskSessionLatest` 経路を **導入しない**」ことを宣言する step に変わったため、
実装作業としては no-op (削除のみ + 既存 T203 経路の確認) に近い。Step 数を「10 (Rev 1 と同じ粒度)」と
書いている (line 37) が、実装作業の比重としては Step 8 が軽くなっている。
- 影響: 実装計画の管理上の誤差のみ。実害はない。
- 対応案 (任意): Step 8 のタイトルに「(no-op confirmation step)」等の補足を入れる、もしくは
  Step 8 を Step 7 に統合して全 9 step に縮約する。**Approved 阻害要因ではない。**

### N2. registerSelf の sessionId 同梱経路を Conductor 専用と明示する記述の重複確認 (任意)

影響表 (line 25) で「optional `sessionId` を受け取り body に含める (Conductor 経路でのみ呼び出される)」と
記載されているが、実装時に `cmdLaunchMaster` も `registerSelf` を呼んでいる場合、誤って sessionId が
渡らないか確認する必要がある。
- 確認内容: `cmdLaunchMaster` の `registerSelf` 呼び出しで `sessionId` 引数を **明示的に渡さない** か、
  もしくは「Master では sessionId 引数を omit」を Step 5 のコードコメントに残す。
- 影響: optional 引数のため undefined で済むので機能的には問題ないが、テンプレート的なミスを防ぐ意味で
  Step 5 に 1 行追加するとなお安全。**Approved 阻害要因ではない。**

### N3. CTE 拡張による既存 unattached 行の表示量変化を運用観点で確認 (任意)

C2 防御により、既存の空 session_id 行は集計対象から除外され、`countToolCallsByTask` の null (unattached) に
寄る。これは「unattached 行の総量が pre-inject 後しばらく **減らない**」ことを意味する (空 session_id 行が
過去 DB に残っているため)。
- plan §既存 task_sessions 行 (backfill) (line 236-237) で「線形減衰することを metrics CLI で確認すれば足りる」
  と書かれているが、検証手順 (どの metric で減衰を観測するか) を 1 行追加すると運用しやすい。
- 例: 「`cmux-team metrics --since 7d --group-by day` の unattached 行数を週次で確認し、
  pre-inject 後の新規分が unattached に流れていないことを定常確認」。
- **Approved 阻害要因ではない。**

## 質問 (Planner に投げる)

なし。前回の質問 1〜5 はすべて plan の改訂で回答されている:
- Q1 (C1 方針): A を採用、scope から外す旨を明記。
- Q2 (C4 方針): A を採用、append-only 維持。
- Q3 (`--session-id` フラグ実機確認): (a) 確認済、(b)(c) スコープ外。
- Q4 (POST 順序逆転実例観測): スコープ外として line 281 に明記。「構造的に T-12 で防げているため」の根拠あり。
- Q5 (mutation を sync に走らせるか): C4 方針 A 採用により mutation 経路自体が消えたため moot。

## Confirmed Strengths (改訂で強化された点)

- **Step 2 の fixture が 4 種類に拡充された**: agent_spawned 単独解決 (T-5)、重複検出 (R1)、異常状態保護 (R1)、空 session_id regression (C2)。CTE 改修の test coverage が大幅に増えた。
- **後着順序 mismatch (T-12) のテストが Step 3 と Step 4 の両方で要求されている**: CONDUCTOR_REGISTERED と AGENT_SPAWNED の両ハンドラで race 防御を独立検証する設計。
- **整合性チェック判定表 (line 196-205) が 8 ケースに整理された**: `*_REGISTERED` 既存 vs SESSION_STARTED 既存 を縦軸、source の値を横軸として、warn 出力と state.sessionId の扱いが一意に判定可能。実装時の挙動仕様として直接参照できる。
- **append-only 不変性の明文化**: 完了条件 + スコープ外セクション + Step 8 の 3 か所で append-only 維持を明示。
  trace DB の他の集計 (rate-limit snapshot との時系列突合等) との整合を保つ筋の通った選択。
- **pre-inject UUID の保持先が in-memory state に絞られた**: Master pre-inject 削除に伴い、永続化議論が
  不要に。team.json 直書き拒否の根拠 (line 158-162) も維持されている。
- **エッジケース・スコープ外セクションが包括的**: `--resume` / 既存 backfill / hook 順序 / UUID 衝突 /
  flag 伝播 / token-pool 順序 / settings.json hook 配布 / `--session-id` 実機確認 の 8 項目を漏れなく整理。

---

以上、Round 2 レビューを完了。**Approved**。実装フェーズに進んでよい。
