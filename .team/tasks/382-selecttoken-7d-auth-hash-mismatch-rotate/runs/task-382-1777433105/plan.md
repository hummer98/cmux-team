# T382 実装計画: selectToken に 7d ブロッカー追加 + auth_hash mismatch 時の auto rotate

## 1. 概要

`token-store.ts: admitCandidates` の admit ループは現在 `effUtil5h > 0.95` のみをブロッカーとしている（`token-store.ts:955`）。これにより「5h は十分余裕があるが 7d 月次枠がほぼ枯渇している」 token が admit され、selectToken の score 比較で `effUtil7d=0.91` の token が唯一の admit 候補になると monthly limit hit を引き起こす（Dear T318 の root cause）。本タスクの一次対応はこの admit ロジックに `effUtil7d > 0.95` を OR 条件で追加し、5h と 7d を対称な blocker 軸として扱うこと。

二次対応として proxy 側の auth_hash mismatch 自己修復（`token_db_update_failed err=UNIQUE constraint failed: tokens.organization_id` の補修経路）を検討するが、proxy.ts の auto-discover 経路の書き換えとログ整備が必要で実装容易度が落ちるため、本タスクからは切り出して別タスク化する（後述 §6）。

## 2. 対象ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/token-store.ts` | 共有定数 `BLOCKER_5H` / `BLOCKER_7D` 追加 + `admitCandidates` の blocker に 7d 追加 + JSDoc 更新 |
| `skills/cmux-team/manager/pool-throttle.ts` | local `POOL_BLOCKER_THRESHOLD` を `token-store.BLOCKER_5H/7D` に置き換え、`countPoolTokens` の available 計数に 7d blocker と 7d stale 救済を追加 |
| `skills/cmux-team/manager/pool-throttle.ts: hasPoolHeadroomFromSummary` | util7d も 0.95 超なら headroom 無し扱い（dashboard cosmetic 整合） |
| `skills/cmux-team/manager/token-store.test.ts` | 7d ブロッカーの新規ケース 4 件 + 既存 stale 救済テストの境界確認 1 件 |
| `skills/cmux-team/manager/pool-throttle.test.ts` | `isThrottled5h` / `countPoolTokens` の 7d ブロッカー新規ケース + `hasPoolHeadroomFromSummary` 7d ケース |
| `docs/spec/09-token-pool.md` | 「ブロッカー除外」節（行 245 付近）+ stale 救済例表（行 256-265）+ pool-aware THROTTLE 節（行 318）の閾値記述更新 |

非変更（自動追従）:
- `canSelectAnyToken` / `peekNextToken` / `selectToken` 本体は `admitCandidates` 経由なので構造的に自動追従
- `pool-summary.ts` / `pool-header-display.ts` は `peekNextToken` 結果を表示するだけなので追従

## 3. 詳細設計

### 3.1 定数化方針

**配置**: `skills/cmux-team/manager/token-store.ts` の最上部（型定義より上、行 14 付近の "型定義" コメントブロック直前）に export const として定義する。理由は admit 判定の唯一の真理として `token-store.ts` を保ち、他モジュール（pool-throttle.ts）からは import で参照する形にするため。

**命名と値**:
```ts
/** admit blocker: stale 救済反映後の effUtil_5h がこの値を超える token は除外する。 */
export const BLOCKER_5H = 0.95;
/** admit blocker: stale 救済反映後の effUtil_7d がこの値を超える token は除外する（T382）。 */
export const BLOCKER_7D = 0.95;
```

**export の有無**: 両方 export する。`pool-throttle.ts: countPoolTokens` および `hasPoolHeadroomFromSummary`、テストコードからの import 用途。

**廃止**:
- `pool-throttle.ts:43` の `const POOL_BLOCKER_THRESHOLD = 0.95;` は削除し、`token-store` から import した `BLOCKER_5H` / `BLOCKER_7D` を直接参照する。

### 3.2 admitCandidates の改修ポイント

対象: `token-store.ts:898-987` の `admitCandidates` 関数。

**変更箇所**: `token-store.ts:955` の 1 行
```ts
// 5) ブロッカー除外: 5h > 95%
if (effUtil5h > 0.95) continue;
```
を以下に置き換える:
```ts
// 5) ブロッカー除外: 5h or 7d > BLOCKER_*（T382: 7d 軸を追加）
if (effUtil5h > BLOCKER_5H) continue;
if (effUtil7d > BLOCKER_7D) continue;
```

stale 救済（`token-store.ts:944-952`）はそのまま温存する。`reset_7d_at` 過去なら effUtil7d=0 で評価されるため、7d リセット直後の token を誤除外しない。

**JSDoc 更新**:
- `selectToken` の説明（`token-store.ts:1015-1031`）と `admitCandidates` の説明（`token-store.ts:858-887`）の「6. ブロッカー除外」節に `effUtil7d > BLOCKER_7D` を併記。
- `peekNextToken` の説明（`token-store.ts:1062-1069`）も同じ blocker を使うことを明記。

### 3.3 default 一致 token への影響整理

T335 で導入された default 昇格 (`token-store.ts:959`) は `if (tok.handle === effectiveDefault) admitted = true;` で **admit 判定** のみを skip する。本タスクの 7d blocker は admit 判定の手前 (5) ブロッカー除外) なので、default 一致 token であっても 7d > 0.95 なら除外される。

これは意図した挙動である（背景の Dear T318 では `@tayo` が default だったため。「default だから無条件 admit」では monthly limit hit を防げない）。

JSDoc およびテストで以下を明示する:
- `effectiveDefault === tok.handle` でも `effUtil7d > 0.95` ならブロッカーで止まる
- 全 token が 7d 超過なら `selectToken` は null を返し、spawn-agent はフォールバック側に流れる

### 3.4 pool-throttle.ts への波及確認

#### 3.4.1 `canSelectAnyToken` / `peekNextToken`
`token-store.ts:1001-1010` / `1079-1096`、いずれも `admitCandidates` を呼ぶだけで blocker 判定を内蔵していない → **自動追従**。コード変更不要。

#### 3.4.2 `countPoolTokens`（pool-throttle.ts:103-176）
`canSelectAnyToken` を呼ばずに admit ロジックを再実装している（行 122-167）。これは「length>0 だけ返す `canSelectAnyToken` では数値カウントできない」ための意図的な複製（pool-throttle.ts:122 のコメント）。

**現状の漏れ**:
- 行 142-149: stale 救済が **5h 軸のみ**（`reset_7d_at` の effUtil7d=0 上書きが無い）
- 行 150: blocker 判定が **5h 軸のみ** (`effUtil5h > POOL_BLOCKER_THRESHOLD`)

**修正案**: `admitCandidates` 相当のロジックを正確に複製する。具体的には行 142-150 を以下に置き換える:
```ts
let effUtil5h = snap?.util_5h ?? 0;
let effUtil7d = snap?.util_7d ?? 0;
if (snap) {
  const recAt = new Date(snap.recorded_at).getTime();
  const isStale = nowMs - recAt > STALE_THRESHOLD_MS;
  if (isStale) {
    if (snap.reset_5h_at != null && parseResetEpochMs(snap.reset_5h_at) <= nowMs) {
      effUtil5h = 0;
    }
    if (snap.reset_7d_at != null && parseResetEpochMs(snap.reset_7d_at) <= nowMs) {
      effUtil7d = 0;
    }
  }
}
if (effUtil5h > BLOCKER_5H) continue;
if (effUtil7d > BLOCKER_7D) continue;
```

**構造的整合性の改善案（任意）**: admitCandidates をそのまま export して countPoolTokens から呼び出せば「複製による drift」を構造的に絶てる。ただし AdmitCandidate 型の export と policy normalize の重複を整理する必要があり scope が膨らむため、本タスクではコード複製のまま「ロジックの一致」をテストで担保する（pool-throttle.test.ts 側の new ケースで 7d blocker と 7d stale 救済の両方を assert）。スコープ拡大が許容なら admitCandidates export → countPoolTokens 内で再利用する refactor を後続タスクで行う（design-review-r2 の「構造的整合性」原則と整合）。

#### 3.4.3 `hasPoolHeadroomFromSummary`（pool-throttle.ts:188-195）
dashboard cosmetic 用の近似関数。現状 `util7d` を一切見ていない（PerHandleSummary には util7d が含まれているのに無視）。

**修正案**:
```ts
export function hasPoolHeadroomFromSummary(perHandle: PerHandleSummary[]): boolean {
  for (const ph of perHandle) {
    if (!ph.selectable) continue;
    const u5 = ph.util5h;
    const u7 = ph.util7d;
    const blocked5h = u5 != null && u5 > BLOCKER_5H;
    const blocked7d = u7 != null && u7 > BLOCKER_7D;
    if (blocked5h || blocked7d) continue;
    return true;
  }
  return false;
}
```
util_5h / util_7d 両方が null（snapshot 待ち）なら headroom あり扱いを保つ（既存挙動）。util_7d だけ null なら 5h のみで判定する（snapshot 受信前の段階で誤った throttle 表示を避ける）。

### 3.5 spec 更新箇所（docs/spec/09-token-pool.md）

| 節 | 行 | 更新内容 |
|---|---|---|
| token 選択アルゴリズム §候補抽出 | 245 | `5. ブロッカー除外: effUtil5h > 0.95` を `5. ブロッカー除外: effUtil5h > 0.95 または effUtil7d > 0.95（T382）` に書き換え |
| stale 救済の挙動 (T373) 例表 | 256-265 | `@tayo` 行（snap=(0.02, 0.91), reset_5h=過去, reset_7d=未来）を「**ブロッカー除外（7d 0.91 < 0.95 → 該当行は admit のまま）**」とは別に、新規行を追加: `@over7d` (0.5, 0.96) reset 未到達 → effUtil=(0.5, 0.96) → **ブロッカー除外（7d 軸）** |
| pool-aware THROTTLE 判定 §閾値 | 318 | `selectToken の > 0.95 ブロッカーを唯一の閾値として共有する` を `5h / 7d 両軸とも > 0.95 でブロッカーとして共有する（T382）` に修正 |
| `/rate-limit` レスポンス §近似 | 304 | `pool-throttle.ts: countPoolTokens の available 計数も parseResetEpochMs を共有して同じ stale 救済ロジックで数える` を、5h/7d 両軸の stale 救済を行うことを明記する形に修正（行 268-269 の同記述も同様に） |

「default 一致でも 7d > 0.95 ならブロッカーで止まる」旨も §候補抽出の note として追記する（既存の「default の runtime 昇格」(行 238) と「ブロッカー除外」の関係を明文化）。

## 4. テスト戦略

### 4.1 追加テストケース（token-store.test.ts）

`describe("selectToken (T382: 7d blocker)")` を新規セクションとして既存 T373 の直後に追加。

| テスト名 | aim |
|---|---|
| `T382-1: util_7d=0.96 / util_5h=0.0 → admit されない` | 単体 token で 7d 軸単独でも除外されることを assert（指示書 §テスト「7d=0.96 / 5h=0」） |
| `T382-2: 全 token が util_7d>0.95 のとき selectToken は null` | 指示書 §テスト の「全 token が 7d>0.95 で null」 |
| `T382-3: util_7d=0.95（境界値）→ admit される` | 厳密不等号 `>` を確認（0.95 自身は通過、0.96 で止まる） |
| `T382-4: default 一致でも util_7d=0.96 なら除外される` | §3.3 の effectiveDefault に対する blocker 強制を assert |
| `T382-5: stale + reset_7d_at 過去 で snap.util_7d=0.99 → admit（effUtil7d=0 救済）` | 7d リセット直後の救済が壊れていないこと |
| `T382-6: stale + reset_7d_at 未来 で snap.util_7d=0.97 → ブロッカー除外` | T373 救済が 7d blocker を素通りさせないこと |

### 4.2 追加テストケース（pool-throttle.test.ts）

`describe("isThrottled5h: pool 有効経路")` 内に追加:
- `T382-T1: 全 token util_5h=0.5 / util_7d=0.96 → throttled=true`（7d blocker が isThrottled5h 経路を伝播）
- `T382-T2: 1 件 5h=0.5/7d=0.5、1 件 5h=0.5/7d=0.96 → throttled=false`（片方残れば throttled=false）

`describe("countPoolTokens")` 内に追加:
- `T382-C1: 3 件 (5h=0.5/7d=0.5, 5h=0.5/7d=0.96, 5h=0.96/7d=0.5) → available=1`
- `T382-C2: stale + reset_7d_at 過去 + util_7d=0.99 → available にカウントされる（7d 救済）`

`describe("hasPoolHeadroomFromSummary")` 内に追加:
- `T382-H1: util5h=0.1 / util7d=0.96 → false`（7d blocked を正しく拾う）
- `T382-H2: util5h=0.1 / util7d=null → true`（util7d 不明時は 5h で判定）

### 4.3 既存テストの回帰確認

- `token-store.test.ts` の T373-1〜T373-6（行 1985-2131）は全て util_7d ≤ 0.95 か reset 過去で effUtil7d=0 になる構成のため新 blocker の影響を受けない。各テストの util_7d を一覧して確認: T373-1 (0.18), T373-2 (0.18), T373-3 (0.1), T373-4 (0.5 reset 過去), T373-5 (0.5 fresh, score 比較で負け), T373-6 (0.18 / 0.91→reset=未来 / 0.85)。**T373-6 の @tayo は util_7d=0.91 なので 0.95 を超えず素通り**。T373 stale 救済の意図は完全に温存される。
- `pool-throttle.test.ts:T2`（行 113）は片方 util_5h=0.96 / 片方 util_5h=0.5 / 両方 util_7d=0.5 で throttled=false → 影響なし。
- `pool-throttle.test.ts:T4-blocker`（行 141）は util_5h=0.97 で blocker → 7d 追加の影響なし。
- `pool-throttle.test.ts:T12`（行 266）の available=2: 7d はいずれも 0.5 / 0.5 / 0.1 なので 7d blocker に該当せず、count は変わらない。

`bun test --timeout 30000 token-store.test.ts pool-throttle.test.ts dashboard-pool.test.tsx pool-summary.test.ts pool-header-display.test.ts pool-cli.test.ts` を回して green を確認する（CLAUDE.md の bun test 全体実行禁忌に従い対象を絞る）。

## 5. 作業手順（TDD）

1. **ブランチ確認**: 既に worktree `task-382-1777433105` 内にいるため、main 直接編集の事故は起きない。
2. **§4.1 のテストを先に追加**して `bun test --timeout 30000 token-store.test.ts` を実行 → 6 件全て fail することを確認（赤）。
3. **§3.1 の定数 `BLOCKER_5H` / `BLOCKER_7D` を `token-store.ts` 上部に追加**。
4. **§3.2 の `admitCandidates` 改修**を行い、`token-store.test.ts` を再実行 → 緑になることを確認。既存 selectToken 系テスト（T335 / T369 / T372 / T373）も全て緑のまま。
5. **§4.2 の pool-throttle.test.ts に新規テストを追加**して fail を確認（赤）。
6. **§3.4.2 の `countPoolTokens` 改修** + **§3.4.3 の `hasPoolHeadroomFromSummary` 改修** + **§3.1 の定数を pool-throttle.ts から token-store import に置き換え**。緑になることを確認。
7. **§3.5 の spec 更新**を行う。例表は実コード（admitCandidates の評価結果）と数式が一致するか手計算で 1 行ずつ検証する。
8. **回帰**: `cd skills/cmux-team/manager && for f in token-store.test.ts pool-throttle.test.ts dashboard-pool.test.tsx pool-summary.test.ts pool-header-display.test.ts pool-cli.test.ts token-cli.test.ts proxy.test.ts; do bun test --timeout 30000 "$f"; done` を実行し全 green。
9. **lint / typecheck**: `bun run typecheck`（package.json で確認 — 無ければ `bunx tsc --noEmit` 相当）。
10. **コミット**: 1 コミットで `feat(token-store): admitCandidates に 7d ブロッカー追加（T382）` 程度。

## 6. 二次対応（auth_hash auto rotate）の判断

### 6.1 proxy 側の現状

`proxy.ts:98-176` の `updateTokensDB` 関数:
- `getTokenByAuthHash(db, authHash)` でヒットしたら usage_snapshots を UPSERT
- ヒットしない & `organizationId` が取れる場合、`auto-discover` 経路で `insertToken` する（行 161）
- `insertToken` は `tokens.organization_id` が UNIQUE 制約なので、**Keychain 側で OAuth refresh が起きて auth_hash が変わった既存 token に対して** UNIQUE constraint failed を引く（実際の事故で観測された）

### 6.2 修正案

`auto-discover` の `insertToken` の手前で `getTokenByOrganizationId(db, organizationId)` を呼び:
- ヒットしない → 従来通り `insertToken`
- ヒットする → 既存 token の `auth_hash` を `updateTokenAuth(db, existing.id, authHash)` で更新 + `log("token_auto_rotated", "handle=... old=... new=...")`、その後 `getLatestUsageSnapshot` 取得して通常の throttled UPSERT 経路に流す

**実装複雑度**: 中。
- `proxy.ts: updateTokensDB` の auto-discover 分岐を 1 個増やすだけ。
- `token-store.ts: updateTokenAuth` は既存（行 373-382）。
- ログ仕様を proxy 側のログ規約に合わせる必要あり（既存の `token_auto_discovered` と同形式: `handle=@xxx old_auth=... new_auth=...`）。
- masking: auth_hash は 12 文字 prefix なので秘匿の必要は薄いが、念のため old のみ全文ログでなく prefix 6 文字に丸めるか確認したい。

### 6.3 判断: 別タスクに切り出す

**理由**:
1. **目的が直交**: 一次対応は「7d 残量に基づく admit 制御」、二次対応は「DB と Keychain の永続的不整合の自己修復」。テスト戦略・回帰範囲が別軸。
2. **proxy 側のテスト整備コスト**: `proxy.test.ts` には既存 spec があり、auth_hash mismatch ケースの fixture を新規に作る必要がある（auto-discover 失敗・成功ケース両方）。これにより本タスクの diff が 2 倍以上に膨らむ。
3. **本事故への効き目は一次対応単独で十分**: 7d blocker さえ入れば仮に @tayo の auth_hash 不整合で snapshot が凍結しても、`util_7d=0.91 < 0.95` の状態では admit される一方、`util_7d=0.96` 以上では除外される。Dear T318 のような「7d=0.91 で唯一の admit 候補が落札 → monthly limit hit」を防ぐには 7d blocker だけで十分。auth_hash mismatch は別途の信頼性問題で、別タスク化しても安全。
4. **二次対応失敗時の影響**: rotate ロジックにバグがあると proxy 経由の全 token snapshot UPSERT 経路に影響する（巻き込み事故が大きい）。一次対応とリスクが釣り合わない。

→ **本タスクでは二次対応を実装しない**。別タスク T??? として「proxy: auth_hash mismatch 時の auto rotate（T382 followup）」を分離して登録することを推奨する。

## 7. 検証コマンド

CLAUDE.md の「bun test 全体実行禁忌」に従い、対象ファイルを絞る:

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-382-1777433105/skills/cmux-team/manager

# Tier 1: 直接修正したテスト
bun test --timeout 30000 token-store.test.ts
bun test --timeout 30000 pool-throttle.test.ts

# Tier 2: 影響範囲の回帰
for f in dashboard-pool.test.tsx pool-summary.test.ts pool-header-display.test.ts pool-cli.test.ts pool-status-header.test.ts token-cli.test.ts proxy.test.ts; do
  bun test --timeout 30000 "$f"
done

# Tier 3: spec 整合性（typecheck 等が package.json にあれば）
cd /Users/yamamoto/git/cmux-team/.worktrees/task-382-1777433105
bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json   # tsconfig が無ければ skip
```

## 8. リスクと注意点

| リスク | 対応 |
|---|---|
| pool が逼迫して全 token が 7d>0.95 のとき spawn が止まる | **仕様として正しい挙動**。指示書 §影響範囲 で明記済み。Manager log に `pool_no_candidate reason=7d_blocked` を出すかは任意（既存の throttled 経路で `isThrottled5h=true` がログされる前提なので追加実装は不要） |
| `effectiveDefault` 一致 token が default だからといって blocker をすり抜ける誤実装 | §3.3 で明示的にテスト T382-4 を追加 |
| `pool-throttle.ts: countPoolTokens` の admit ロジックが `admitCandidates` から drift する | 本タスクで一致させた上で、`pool-throttle.test.ts` の C1/C2 でロジック一致を assert。中長期的には `admitCandidates` を export して countPoolTokens から呼び出す refactor 案を別タスク化することを検討 |
| `hasPoolHeadroomFromSummary` の util7d=null 取り扱い | snapshot 受信前の起動直後はわざと「headroom あり」と出して spawn を許可する設計（既存設計と整合）。テスト T382-H2 で明示 |
| spec 更新で実コードと例表の数値乖離 | 例表は admitCandidates の入力 `(util_5h, util_7d, reset_5h_at, reset_7d_at, recorded_at)` から手計算で導出し、コメントに計算過程を残す |
| 既存 T373-6 の `@tayo` (util_7d=0.91) が誤って blocker に該当する誤読 | `0.91 < 0.95` で blocker 不該当。本 plan §4.3 で明記し、テスト実行で確認 |
| Keychain refresh による auth_hash mismatch の根治は別タスクで | 本タスクでは触らない。proxy.ts の `token_db_update_failed` ログは継続発生する可能性があるが、7d blocker により admit ロジックは保護される |
