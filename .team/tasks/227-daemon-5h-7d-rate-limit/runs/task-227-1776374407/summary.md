# T227 実行サマリー — daemon 再起動時に最後の 5h/7d rate limit を復元する

## 完了ステータス

- **Phase 1 (Plan)**: ✅ completed（2 往復: 初回 Changes Requested → v2 で Approved）
- **Phase 2 (Design Review)**: ✅ completed
- **Phase 3 (Implementation)**: ✅ completed
- **Phase 4 (Inspection)**: ✅ GO 判定

## 実装方針（採択）

1. **永続化先**: `.team/rate-limit.json`（atomic write `.tmp → rename`）
2. **書き込み**: proxy.ts の `state.rateLimit` 更新直後に fire-and-forget + shutdown 時に `await` flush
3. **読み込み**: `cmdStart` の `initInfra` 直後に `loadRateLimit` → `state.rateLimit` に注入
4. **古いデータ**: 破棄せず、`isStale` ヘルパで判定 → dashboard は GRAY + `(stale)` ラベル、throttle 判定は stale 時に無効化（誤ブロック防止）
5. **`unifiedStatus`**: 復元するが、`isStale(rl)` なら無視（`rate_limited` でも forceRed しない）

## 変更ファイル一覧

### 新規（4 ファイル）

- `skills/cmux-team/manager/rate-limit-persistence.ts` — `persistRateLimit` / `loadRateLimit` / `isStale`
- `skills/cmux-team/manager/rate-limit-persistence.test.ts` — 17 tests
- `skills/cmux-team/manager/rate-limit-display.ts` — Ink 非依存の純粋関数モジュール
- `skills/cmux-team/manager/rate-limit-display.test.ts` — 9 tests

### 改修（7 ファイル）

- `skills/cmux-team/manager/schema.ts` — `RateLimitInfoSchema = z.object({...})` 追加、`RateLimitInfo = z.infer<typeof RateLimitInfoSchema>` に再定義
- `skills/cmux-team/manager/proxy.ts` — streaming/non-streaming の 2 箇所で persist 呼び出し（ログ付き二段 catch）、`/rate-limit` エンドポイントの throttled 判定に `!isStale` ガード
- `skills/cmux-team/manager/main.ts` — `cmdStart` で load、`shutdown` で最後の flush を `await`
- `skills/cmux-team/manager/dashboard.tsx` — 旧 `buildRateLimitDisplay` 削除、新モジュールに委譲、色マッピング追加、`isThrottled` に stale ガード
- `skills/cmux-team/manager/daemon.ts` — `.team/.gitignore` migration（既存ファイル追記、冪等）、throttle 判定 2 箇所に stale ガード
- `docs/spec/05-install-and-infrastructure.md` — `.team/rate-limit.json` 章を追加
- `docs/spec/01-skill-cmux-team.md` — dashboard の stale 表示章を追加

## テスト結果

- 新規テスト: **26/26 pass**
- 既存テスト: **413/413 pass**（manager ディレクトリ全体）
- 型チェック `bunx tsc --noEmit`: pass（exit 0）

## 設計レビュー反映

初回 design-review で Changes Requested。以下 4 項目を plan v2 + 実装に反映:

1. **stale ガードを 5 箇所すべてに**: `dashboard.tsx` (2), `proxy.ts` (1), `daemon.ts` (2)
2. **fire-and-forget は二段 catch**: `.catch((e) => log("rate_limit_persist_failed", e.message).catch(() => {}))`（CLAUDE.md ロギングポリシー準拠）
3. **`.team/.gitignore` migration**: 既存ワークツリーでも `rate-limit.json` 行を冪等に追記、`team_gitignore_migrated` をログ
4. **`loadRateLimit` の型検証**: `RateLimitInfoSchema.safeParse` で必須フィールド・型不一致を検出、失敗時 null

## 受け入れ条件の充足

- ✅ daemon 再起動後、`cmdStart` で `loadRateLimit` → `state.rateLimit` 注入 → dashboard に直前値が表示される
- ✅ reset 時刻を過ぎた値は dashboard で GRAY + `(stale)` 表示（`docs/spec/01-skill-cmux-team.md` に明記）
- ✅ 新しい API 応答を受け取った時点で `proxy.ts` が `state.rateLimit` を上書き + `persistRateLimit` が atomic write で永続ファイルも上書き

## 納品

- ローカルマージ（main に直接マージ）
