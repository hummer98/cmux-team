# T281 plan.md レビュー (v1)

## Verdict

**Approved**

実装者が plan.md 単独で迷わず実装でき、受け入れ条件を満たす確信が持てる。
ただし軽微な Recommendations あり（任意対応で可）。

---

## Strengths

- **根本原因の特定が正確**: `rate-limit-persistence.ts:81-90` の OR 判定 → `throttled5h` ガードが解除されない因果が明確に整理されている。§1 の症状 → 根本原因 → 修正の本体の論旨が綺麗に繋がっている。
- **影響範囲の網羅性が完璧**: 6 箇所（daemon.ts:2515 / daemon.ts:3333 / proxy.ts:193 / dashboard.tsx:1092 / rate-limit-display.ts:41 / main.ts:486）を列挙し、grep 結果と一致することを確認済み。各箇所を「5h 専用 / 7d 専用 / 両軸」に分類しており、daemon.ts:3333（`unified5hUtilization` + `unifiedStatus=rate_limited` のみ参照）、proxy.ts:193（同）、dashboard.tsx:1092（`unified5hUtilization` のみ参照）すべて 5h 専用という分類は実装コードとも整合。
- **既存テストの取り扱いが明示的**: `rate-limit-persistence.test.ts:139-142`（5h 過去 / 7d 未来 → non-stale）が「意図と逆転する」ため削除対象であることを §2 と §5.2 で明記。偶発的に既存テストを残して壊れる事故を防いでいる。
- **破壊的変更の扱いが明瞭**: 案 A（`isStale` 削除）を採用した理由（誤用リスク、呼び出し元 6 箇所のみ）と、案 B / 案 C を却下した理由が §3.2 に整理されている。§7.1 で「単一コミットで完結させる」方針も明記。
- **TDD 手順が具体的**: Step 1–4 が赤 → 緑 → リファクタで整理され、Step 2 の手順 4 → 9 を 1 コミットに収める意図（§7.1）とも整合。各ステップで `bun test` を走らせるタイミングも明示。
- **隠れた前提の明文化**: §2「7d throttle について」で `THROTTLE_7D_THRESHOLD` が存在しないことを grep で確認済みと明記し、`isStale7d` を観測/将来拡張用に定義すると位置づけている。§7.5 で「7d は観測のみ」を仕様として `rate-limit-persistence.ts` の docstring に書く方針も示している。
- **受け入れ条件の検証手順が完結**: §8 に Unit / 全体 / 型チェック / E2E の 4 段階が並び、特に §8.4 で `.team/rate-limit.json` に 5h 過去 / 7d 未来のテストデータを仕込み dashboard から `⏸ THROTTLED` が消えることを手動確認する手順が具体的。
- **スコープ外の明記**: §10 で 7d throttle ガード追加 / 永続化フォーマット変更 / stale 表示 UI リニューアル / スキーマへの stale フラグ追加を除外。実装者がスコープを広げて迷走するのを防いでいる。

---

## Recommendations（任意）

以下は Approved を覆すものではなく、実装時の配慮で対応できる軽微な提案。

### R1. `buildUtilizationBar` の内部色決定ロジックへの言及

`rate-limit-display.ts:41` 周辺の修正（§9 パッチイメージ）で `stale5h ? "gray" : forceRed && p.color !== "gray" ? "red" : p.color` という三項演算子を各バーに適用する形だが、`buildUtilizationBar` が返すバー内部の色（例: 閾値超過で自身を赤にしている等）との相互作用を一言添えると実装者が安心できる。現行テスト `rate-limit-display.test.ts:70-90` が継続通過する前提で検証済みなので問題は出ないはずだが、Step 3 の緑確認時に「`buildUtilizationBar` の色を `stale5h` で上書きしたあとに `forceRed` が発動しない」ことを明示的に確認する一文があると丁寧。

**推奨修正**: §3.3 または §6 Step 3 に、「`buildUtilizationBar` の返す色は軸単位に閉じるため、他軸の stale 状態は浸透しない」ことを 1 行で追記。

### R2. `main.ts:486` ログフォーマット変更の grep 根拠を残す

§7.4 で「外部ログパーサは存在しない想定」「grep で確認したが該当なし → docs 更新不要」と結論しているが、どの grep を走らせたか（例: `rg "stale=" README.md docs/`）の具体が残っていないため、実装者が同じ判断を再現するのに手間がかかる。

**推奨修正**: §7.4 に確認した grep コマンドを 1 行添える（`rg -n 'rate_limit_restored' README* docs/ .team/ 2>/dev/null` など）。必須ではなく、実装時に実行して空である事実を commit message に残すだけでも十分。

### R3. §5.4「既存テストの修正」の表現

「継続で通るはず」と書かれているが、Step 3 で新規テストを追加する前に Step 2 で `stale` を `stale5h` / `stale7d` に分割した時点で既存テストの動作に影響が出る可能性がある。実際には両軸 stale のケースなので通るという結論で正しいが、「Step 2 完了時点で `bun test rate-limit-display.test.ts` を走らせて継続緑を確認」という 1 行を追加すると漏れを防げる。

**推奨修正**: §6 Step 2 の 9（`bun test` 全体通過確認）の前に、「`rate-limit-display.test.ts` の既存テストが Step 2 時点で既に緑であることを確認」を 1 行差し込む。plan 的には 9 の `bun test` 全体通過で包含されているため optional。

---

## 補足（判定根拠）

### 設計の妥当性

`isStale5h` / `isStale7d` の命名は左から右に読んで意味が取れる良い命名。シグネチャが既存 `isStale` と同形（`(rl, now?)` → `boolean`）のため呼び出し側の差分が最小で、レビュー時のノイズも小さい。内部で `isFuture` を共用する方針も実装コストを抑えられて合理的。

### 軸別判定の意味論

`isStale5h(rl) = !isFuture(unified5hReset)` と「5h 軸だけを見る」定義は T281 のバグ本質（5h reset 過去で throttle が解除されない）と 1:1 対応しており、他の意味解釈の余地がない。`isStale7d` も対称に定義され、非対称な特例を入れていないのが良い。

### テスト計画

§5.1 のケース 6 件（null / null / 過去 / 未来 / 過去+未来 / 解釈不能）が stale 判定の組み合わせを網羅。§5.3 の 5h 過去 / 7d 未来ケースが T281 リグレッションテストとして機能しており、受け入れ条件 1（「5h reset 過去 / 7d reset 未来の状態で throttle ガードが解除される」）と直接対応。

### 隠れた前提の検証

`THROTTLE_7D_THRESHOLD` 不在の確認、`unified7dUtilization` の throttle ガード対象外、`persistRateLimit` / `loadRateLimit` が stale 判定を行わない（§7.3）点まで押さえられており、「今回見るべきでない範囲」を明確にしている。

---

## Blockers

なし。

## 次ステップ

Implementer は plan.md の §6 TDD 手順をそのまま実行してよい。R1–R3 は実装中に都度配慮する程度で十分。
