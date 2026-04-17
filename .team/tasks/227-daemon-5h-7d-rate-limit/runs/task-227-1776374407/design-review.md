# Design Review: T227 plan.md (v2)

## Verdict

**Approved**

## Summary

前回の必須 Recommendations 4 件（stale ガード 5 箇所、fire-and-forget の二段 catch、`.gitignore` migration、`loadRateLimit` の Zod safeParse）と Minor B/E（`isStale` OR 判定の明文化、`rate-limit-display.ts` 切り出し）が全て plan v2 に反映されている。実装ステップ・テスト計画・受け入れ条件も整合しており、実装フェーズに進んでよい。Minor Note A（shutdown race）は plan 自身に注記として残っており、許容範囲の既知事項として扱える。

## Review of Prior Recommendations

### ✅ 1. stale ガードを全 throttle 判定 5 箇所に入れる

- §2-4 末尾で **`dashboard.tsx:918`, `dashboard.tsx:236`→新モジュール, `proxy.ts:182`, `daemon.ts:1313`, `daemon.ts:1770`** の 5 箇所が明示されている
- §3 の変更対象ファイル表でも各ファイルの該当行に `isStale` ガード追加が記載
- §4 Step 5 / Step 10-12 で順番に実装手順が書かれており、Step 11 は「stale 時にタスク割当が誤ってブロックされないこと」を担保する意図まで明文化
- §7 リスク項目で「`grep -n THROTTLE_5H_THRESHOLD` / `grep -n 'unifiedStatus === "rate_limited"'` で残存していないことを PR レビュー時にチェック」と配線漏れ検出手順も用意
- 前回指摘した typo（`daemon.ts:918` → `dashboard.tsx:918`）は §3 末尾の注記で修正済み

### ✅ 2. fire-and-forget のエラー処理を「ログ付き二段構造」に統一

- §2-2 に明示的なコードサンプルあり:
  ```ts
  persistRateLimit(root, rl).catch((e: any) =>
    log("rate_limit_persist_failed", e.message).catch(() => {})
  );
  ```
- 「空の `.catch(() => {})` は CLAUDE.md の『ロギングポリシー > 禁止事項』に抵触するため使わない」と明記
- §4 Step 4 の実装コードにも同じ形が再掲されており、Step 8（shutdown）のエラーも `log("rate_limit_persist_failed", ...)` で記録する方針

### ✅ 3. `.team/.gitignore` の既存ファイル追記マイグレーション

- §4 Step 6 に詳細手順:
  - 既存 `if (!existsSync(gitignore))` はそのまま（新規生成時に `rate-limit.json` を含める）
  - `else` ブランチで既存内容を読み、`rate-limit.json` 行の有無を行単位で判定
  - 未含有なら追記（`proxy-port` 行の直後挿入の冪等実装を許容）
  - `log("team_gitignore_migrated", path=... added=rate-limit.json)` を記録
  - 冪等性（既に含まれていれば何もしない・ログも出さない）
- §6 受け入れ条件 E で「二重追記されないこと」の手動検証あり
- §7 リスク項目でも「新規・既存両対応」が明記

### ✅ 4. `loadRateLimit` のフィールド健全性検証（Zod safeParse）

- §2-3: 「`RateLimitInfoSchema.safeParse(JSON.parse(raw))` を通し、JSON 破損 or フィールド型不一致のどちらでも null フォールバック」
- §3 の変更対象ファイル表で `schema.ts` に `RateLimitInfoSchema` を新規 export、既存 interface は `z.infer` で置換
- §4 Step 1 でスキーマ定義、Step 2 でテスト（型不一致・必須欠落）、Step 3 で `safeParse` 実装
- §5 テスト計画に「`unified5hUtilization: "0.5"` 文字列で safeParse 失敗」「必須フィールド欠落で null」の 2 ケースを明示
- §6 受け入れ条件 D で破損 JSON / 型不一致 / フィールド欠落の 3 パターンを手動検証

### ✅ Minor B: `isStale` の OR 判定を本文と整合

- §2-4 で明示的に列挙:
  - いずれかの reset が未来 → non-stale
  - 両方過去 or 両方 null → stale
  - 片方 null + もう片方が過去 → stale
- §5 テスト計画でも 6 ケースに分解（両方 null / 5h 未来 7d null / 7d 未来 5h null / 片方過去 片方 null / 両方過去 / 両方未来）
- `isStale(rl, now = Date.now())` で `now` を注入可能にしている点もテスト容易性の観点で適切

### ✅ Minor E: `rate-limit-display.ts` 純粋関数切り出し

- §3 の変更対象ファイル表で新規モジュール追加
- §4 Step 9 で Ink 非依存の純粋関数として切り出し、色を enum or 文字列定数で返す方針を明記
- §5 の `rate-limit-display.test.ts` でテストケースが具体化（stale → GRAY / non-stale + rate_limited → RED / non-stale 通常 → しきい値別）

## Minor Notes（Approved 維持）

- **A. shutdown race（plan §2-2 末尾の注記）**: proxy の fire-and-forget が in-flight の状態で shutdown の `await persistRateLimit` が走ると「古い値で上書き」が最大 1 回起こりうる。plan 自身が「実害なしとして注釈のみ残す」と判断しており、将来 write queue 化で解決可能な既知事項として受け入れ可能。

- **B. Step 6 の `.gitignore` 追記箇所**: plan は「`proxy-port` 行の直後にシンプルに挿入する冪等実装でよい」と書いているが、既存 `.team/.gitignore` の構造が将来変わった場合に insertion point の検出が失敗する可能性がある。実装時は「`proxy-port` 行が見つからない場合はファイル末尾に追記」のフォールバック 1 行を入れておくと堅牢になる。軽微なので実装者判断に委ねる。

- **C. `rate_limit_restored` ログの値整形**: §4 Step 7 のログ文字列に `unified5hUtilization` を素で展開しているが、`null` の場合に `unified5h=null` と出ることになる。支障はないが、dashboard 表示と揃えて `pct` 変換（`Math.round(x * 100)`）しておくと `manager.log` の可読性が上がる。Nice-to-have。

- **D. Step 6 の「コメント行は除外」判定**: 行比較時に `#` で始まる行を除外する仕様だが、`# rate-limit.json` のような **コメントアウトされた既存エントリ** がある場合の挙動が未規定。極めて稀なケースなので無視してよいが、実装では `trim()` 後に `#` で始まる行を単純に skip する形で十分。

- **E. Zod スキーマの `unifiedStatus` の型**: §4 Step 1 では `unifiedStatus: z.string().nullable()` としているが、実際の値は `"rate_limited"` などの enum 的な文字列に限られる。厳格化するなら `z.enum([...]).nullable()` だが、proxy 側で未知の値が来た場合の互換性を優先して `z.string().nullable()` のままで問題ない。Nice-to-have。

## 次フェーズへの引き継ぎ

Planner → Implementer への引き継ぎ時は、以下の順序で実装を始めることを推奨:

1. `schema.ts` の `RateLimitInfoSchema` 追加 → 型が既存 interface と一致することを tsc で確認
2. `rate-limit-persistence.test.ts` 先書き → `rate-limit-persistence.ts` 実装で green
3. `rate-limit-display.test.ts` 先書き → `rate-limit-display.ts` 実装
4. `proxy.ts` / `main.ts` / `daemon.ts` / `dashboard.tsx` の呼び出し配線（Step 4-12）
5. `docs/spec/` 同期と E2E

特に Step 8-12（5 箇所の `isStale` ガード）は配線漏れが最大のリスクなので、実装後に `rg "THROTTLE_5H_THRESHOLD" skills/cmux-team/manager/` と `rg 'unifiedStatus === "rate_limited"' skills/cmux-team/manager/` を実行して全マッチに `!isStale(...)` が付いていることを目視確認すること。
