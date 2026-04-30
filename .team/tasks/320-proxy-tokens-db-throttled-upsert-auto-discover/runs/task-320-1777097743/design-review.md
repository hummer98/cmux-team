# Design Review (Round 2): T320 plan.md

レビュー対象: `.team/tasks/320-proxy-tokens-db-throttled-upsert-auto-discover/runs/task-320-1777097743/plan.md`
レビュアー: Design Reviewer Agent (surface:90)
レビュー日: 2026-04-25
前回レビュー: 同ディレクトリの旧 design-review.md（Round 1、Verdict: Changes Requested）

## Verdict

**Approved**

Round 1 で挙げた Critical 2 件はいずれも解消、Major 5 件のうち M1/M2/M3/M5 がフル解消、M4 は「全衝突 → null」分岐が明記され、残りの「sanitized 4 文字未満 → null」だけが純粋ユニットテスト未追加（plan 本文の擬似コードと Risk 表で対応済み、判定ルール上「Implementer フェーズ吸収可能」に該当）。新規矛盾は無く、`start()/stop()` の lifecycle と検証コマンドも妥当。実装フェーズへ進んで差し支えない。

---

## Round 1 指摘の解消状況

### C1. P3 境界値テストの期待値が仕様/実装と矛盾 — ✓ 解消

- §3.3 P3 が `next=0.305 (diff 0.005) → false` / `next=0.32 (diff 0.02) → true` の **FP 安定値**で書き直されている。`0.31` は明示的に不使用。
- §2.2 のコード中で `UTIL_DELTA_THRESHOLD = 0.01` のコメントに「`<` 比較なので 0.01 ちょうどは upsert 側に倒れる（タスク本文「以上」と整合）」と明記。
- P3 (d) で reset 時刻のみ変化 → true、(e) で unified_status のみ変化 → true も追加されており、`shouldUpsertSnapshot` の全分岐が境界に依存せずに検証される。
- 完了基準 §6 にも「P3 は安定値 (0.305 / 0.32) で書き、FP 不安定値 (0.31) を使わない (C1)」が明記。

→ Round 1 で懸念した「Implementer がテストを通すために比較演算子を反転させる」誤誘導の余地は無くなっている。

### C2. `recordTokenUsage` 呼び出しが `api_usage` 経路にネスト — ✓ 解消

- §1.5 の文言が「**`opts?.db` の有無に依存させない**。両者は独立した try/catch で囲み、片方の失敗が他方に波及しないようにする」に書き換わり、「standalone proxy（`opts.db` unset）モードでも tokens.db は更新される」と明示。
- §4 Step 3c（非 streaming）:
  ```ts
  if (opts?.db && url.pathname === "/v1/messages") { /* 既存 */ }
  // ↑ とは独立
  if (url.pathname === "/v1/messages") { recordTokenUsage(tokenDb, upstreamRes.headers, req.headers); }
  ```
  `if (opts?.db && ...)` ブロックの**外側**で独立分岐になっている。
- §4 Step 3d（streaming `ctx` 型）が `apiUsage` と**並列の独立フィールド** (`tokenDb` / `requestHeaders` / `responseHeaders` / `isMessagesEndpoint`) として書き換えられ、§4 Step 3e で `if (ctx.apiUsage)` の外に独立分岐として呼び出し。
- §5 Risk 表に「`opts.db` unset (standalone proxy) で tokens.db 更新が走らない設計バグ → C2 修正で解消」と追記。

→ §1.5 と §4 Step 3c/3e の整合性も完全に取れた。Round 1 で指摘した「文言と実装手順の食い違い」は解消。

### M1. テストケース 3 の検証が `recorded_at` 同値比較になっていた — ✓ 解消

- §3.2 case 3: **主**を `snapshot.util_5h === 0.30`（0.305 に書き換わっていないことの直接確認）、`recorded_at` を**副 (参考)** に降格。
- case 4: **主** `snapshot.util_5h === 0.32`、副が `recorded_at` 進行（参考）。
- case 5: **主** `snapshot.reset_5h_at === <新値>`、副が `recorded_at` 進行（参考）。
- §3.2 補足に「CI 上で ms 単位の同値による flaky を避けるため」と理由付け。
- 完了基準 §6 に「case 3/4/5 は `util_5h` / `reset_5h_at` 値検証を主軸（M1/N3）」明記。

→ Round 1 で挙げた「ms 同値 flaky」「UPSERT 走っても recorded_at が同 ms になる可能性」は完全に回避される検証設計に。

### M2. ctx の Headers lifecycle が不明瞭 — ✓ 解消

- §1.7「Headers の lifecycle（M2 修正）」セクション新設:
  - `responseHeaders: new Headers(upstreamRes.headers)` で**独立 copy** を ctx に乗せる
  - 既存 `resHeaders = new Headers(upstreamRes.headers)`（proxy.ts:442 周辺）の流用も可能と明記
  - `requestHeaders` は handler 生存中の参照で OK と理由付き
- §4 Step 3d でも同方針を再掲。
- §5 Risk 表「streaming で response/request headers の参照が ctx 通過後に release される」が「`new Headers(upstreamRes.headers)` で明示的に独立 copy する」に書き換わり。
- 完了基準 §6 に「`responseHeaders` は `new Headers(upstreamRes.headers)` で独立 copy (M2)」明記。

→ Round 1 で「明示的な copy は不要」と書かれていた箇所が「copy する」に正しく反転。

### M3. streaming + auto-discover の組み合わせテスト抜け — ✓ 解消

- §3.2 に case 7「**streaming SSE 経路 + 未登録 token → auto-discover が発火する** (M3 新規)」を追加。
- 検証内容に「pre-INSERT なし。SSE finally 内で recordTokenUsage が呼ばれ、tokens テーブルに 1 件 / usage_snapshots に 1 件入る。ctx 経由の orgId/auth_hash 伝搬が壊れていないことを確認」を明記。
- 完了基準 §6 に「case 7 で「streaming + auto-discover」シナリオを確認 (M3)」明記。

→ ctx 経由のフィールド (tokenDb / requestHeaders / responseHeaders) が統合経路で実際に動くかが押さえられる。

### M4. handle 4-6 全衝突 / sanitized 短すぎ skip の経路 — △ 部分解消（Implementer フェーズ吸収可）

- **全衝突 → null** は §3.3 P2 (d) で「**4・5・6 全衝突 → null**」として追加され、完了基準 §6 にも明記 ✓
- **sanitized 4 文字未満 → null** の純粋テストケース追加は無い。ただし:
  - §1.3 / §2.2 の擬似コードで `if (cand.length < len) break` により対応済み（実装側）
  - §5 Risk 表「organization_id の正規化（UUID 内 `-` 除去）で 4 文字未満になる」に残存しており、緩和策に含まれる
  - 現実の `organization_id` は UUID 形式で 32 hex 文字、sanitized が 4 文字未満になる経路は実機では発生しない（極端なテスト用入力でしか踏まない）
- 判定ルール「M3/M4/M5 のうち 1 件はテストレベルなので Implementer フェーズ吸収可能、明記されていれば OK」に該当。Implementer 判断で P2 に (e) として 1 アサート追加すれば完成度が上がるが、必須ではない。

→ 主観的には **概ね解消**。Minor として後述の Recommendations に「P2 に sanitized 不足ケースを追加してもよい」を残す。

### M5. concurrent INSERT 時の UNIQUE 違反吸収 — ✓ 解消

- §1.4 の手順 5a に「`insertToken` が UNIQUE 違反で throw した場合は再 SELECT で吸収（concurrent insert race 対応, M5）」明記。
- §2.2 擬似コードで実装パターンを追加:
  ```ts
  try {
    token = insertToken(tokenDb, { ... });
  } catch (e: unknown) {
    // M5: UNIQUE 違反 (concurrent insert race) を吸収して再 SELECT
    token = getTokenByOrganizationId(tokenDb, orgId);
    if (!token) throw e;  // 別種のエラーは上位 catch へ
  }
  upsertUsageSnapshot(tokenDb, { token_id: token.id, ...next });
  ```
  さらに「初回 snapshot は throttle せず必ず書く（race で先行 INSERT があった場合も `upsertUsageSnapshot` は ON CONFLICT で更新するので冪等）」とコメント。
- §5 Risk 表「concurrent proxy 起動で同 organization_id を 2 重 INSERT」が「**同一リクエスト内で `getTokenByOrganizationId` で再 SELECT** して snapshot を確実に書く（M5 修正）。これにより race 時の snapshot 取りこぼしを防ぐ」に書き換え。
- 完了基準 §6 に「`recordTokenUsage` の auto-discover ルートで insertToken UNIQUE 違反を吸収する concurrent insert race 対応 (M5)」明記。

→ Round 1 で指摘した「当該リクエストの snapshot 書込みが落ちる」問題は完全に解消（race 負けでも当該リクエスト内で snapshot を入れる）。

---

## New Issues

### Critical

なし。

### Major

なし。

### Minor

#### N7. §3.2 末尾の「ケース総数 10 上限」議論が冗長で読み手が混乱しやすい

該当箇所:
> **合計: 8 + 3 = 11 ケース** … と書いたが、case 7 (M3) は case 6 と並列なので片方を吸収する場合は 7 + 3 = 10 でも可。**最大 10 ケース上限を厳守する**ため、case 7 を新規追加 + case 1 に N5 統合 + P1/P2/P3 を上記の通り内部分岐で複合化する形で **proxy.test.ts 8 ケース + proxy-token-pool.test.ts 3 ケース = 11 ケース** に収めるか、P1 を内部分岐 only でカウント 1 として **合計 11 → 10** に圧縮する（Implementer 判断で statement 単位は内部 it.each / describe 単位で増えてもよい）。

- 自家撞着気味（「11 ケース」とも「10 ケース内に収まる」とも書かれている）。
- 判定ルールには「最大 10 ケース上限」は無いので、Implementer は迷わず実装すべき（運用方針の最後の一文「Critical/Major の検証観点が漏れないことを優先する」は適切）。
- 修正は不要だが、Implementer が読んだ際に「とにかく描かれている case 1〜8 + P1〜P3 を全部書けば良い」と判断すれば問題ない。

#### N8. P2 に「sanitized 短すぎ → null」を 1 アサート足すと M4 完全解消

§3.3 P2 (a)〜(d) は「衝突パス」のみカバー。`pickAutoDiscoverHandle("---")` のような sanitized 不足経路は擬似コードでは `cand.length < len` で break する設計だが、純粋ユニットテストでの裏付けが無い。

P2 (e) として 1 行追加:
```ts
// (e) sanitized 4 文字未満 → null
expect(pickAutoDiscoverHandle(db, "---")).toBeNull();
```

これだけで M4 が完全解消する。Implementer フェーズで吸収可能なレベル。

#### N9. §4 Step 3c の `recordTokenUsage` 呼び出しは `tokenDb` が null でも安全

§2.2 で `recordTokenUsage` が冒頭で `if (!tokenDb) return;` するので、Step 3c の `if (url.pathname === "/v1/messages")` 内で `tokenDb` を渡しても問題ない。一見 `tokenDb` が null のときに不要な分岐評価を毎回やっているが、`/v1/messages` 完全一致の頻度は限定的なのでオーバヘッドは無視できる。

ただし、コードリーダー視点では `if (tokenDb && url.pathname === "/v1/messages") recordTokenUsage(tokenDb, ...)` のほうが意図が明示的。Implementer 判断で短絡させても良い（plan の擬似コードを変えるほどでもない）。

---

## Recommendations

Approved につき必須対応は無い。Implementer が実装する際の参考メモのみ:

1. P2 (e) として「sanitized 4 文字未満 → null」アサートを 1 行足すと M4 が完全解消（任意）。
2. §3.2 末尾の「ケース総数 10 上限」議論は無視して、表の case 1〜8 + P1〜P3 を全て実装する判断で良い（観点の漏れ防止を優先）。
3. §4 Step 3c の `recordTokenUsage` 呼び出しは `tokenDb` null check を呼び出し側で短絡しても良い（任意、可読性向上）。

---

## Test Coverage Assessment

### plan §3 で追加されたカバレッジ（Round 2）

- ✓ streaming + auto-discover (case 7、M3)
- ✓ handle 4・5・6 全衝突 → null (P2 (d)、M4 主要部)
- ✓ shouldUpsertSnapshot 境界が安定値で記述（C1）
- ✓ unified_status 未返却 → null (case 1 に統合、N5)

### 残存する観点（必須ではない）

- handle sanitized 短すぎ → null（実装側は対応、純粋テスト未追加）
- concurrent INSERT race の純粋テスト（実装側は対応、純粋テスト未追加 — 統合テストで再現困難なので OK）
- `unified-7d-utilization` のみ欠落するパース robustness（A020 で実機ヘッダー観測済み、現実には全部来る前提）

### スコープ外（Round 1 と同じ）

- spawn-agent selection / TUI / CLI（plan §0 Non-goals）
- auth_hash rotation 検出（plan §1.4 / Risk 表で明記済み）
- `api_usage` への auth_hash 列追加（A020 §後続実装、本タスク外）
- 機能 OFF 設定の 3 階層実装（別タスク）

---

## Lifecycle / 検証コマンドの確認

### `start()` 内 lifecycle

§1.1 / §4 Step 3b / 3f に以下が一貫記載:

- `tokenDb: Database | null = null` をクロージャ変数として保持
- `initTokenDB()` を try/catch で囲み、失敗時は `tokenDb=null` のまま続行（log 警告のみ）
- `stop()` 関数内で `try { tokenDb?.close(); } catch {}` で確実に close
- 既存 `start()` 構造を破壊しておらず、`server.stop()` 呼び出しの後段に追加するだけ

→ lifecycle 設計は壊れていない。

### 検証コマンド

§3.4:
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-320-1777097743
cd skills/cmux-team/manager && bun test proxy.test.ts
cd skills/cmux-team/manager && bun test proxy-token-pool.test.ts
cd skills/cmux-team/manager && bun test token-store.test.ts
cd /Users/yamamoto/git/cmux-team/.worktrees/task-320-1777097743 && bunx tsc --noEmit
cd /Users/yamamoto/git/cmux-team/.worktrees/task-320-1777097743/skills/cmux-team/manager && bun test
```

→ worktree root 起点で各ファイル単位 test、tsc、最後に regression 確認の全 manager test。現実的かつ網羅的。

---

## 結論

**Approved**。Round 1 の Critical 2 件 (C1/C2) は完全解消、Major 5 件のうち M1/M2/M3/M5 はフル解消、M4 はテストレベルでの sanitized 不足ケース追加が任意で残るのみ（実装側は対応済み、判定ルール上 Implementer 吸収可能）。新規 Critical / Major は発生していない。

Implementer は plan §4 の Step 1〜5 を順に進めれば良い。任意で N8 の P2 (e) アサート追加・N9 の null check 短絡を取り込むと品質が上がるが、これらは必須ではない。
