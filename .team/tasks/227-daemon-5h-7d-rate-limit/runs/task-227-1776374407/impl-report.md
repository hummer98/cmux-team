# Implementation Report: T227 — daemon 再起動時に最後の 5h/7d rate limit を復元する

## 変更ファイル一覧

### 新規

- `skills/cmux-team/manager/rate-limit-persistence.ts` — `persistRateLimit` / `loadRateLimit` / `isStale` を実装。atomic write（.tmp → rename）、`RateLimitInfoSchema.safeParse` でフィールド健全性検証、`isStale` は 5h/7d reset の OR 判定。
- `skills/cmux-team/manager/rate-limit-persistence.test.ts` — round-trip / 破損 JSON / 型不一致 / 必須欠落 / stale 判定 10 パターンを網羅（17 tests）。
- `skills/cmux-team/manager/rate-limit-display.ts` — `buildRateLimitDisplay` を Rezi/Ink 非依存の純粋関数として切り出し。色は `"green" | "yellow" | "red" | "gray"` の文字列リテラルで返す。stale 時は `(stale)` ラベル付与と全パーツ GRAY 化。
- `skills/cmux-team/manager/rate-limit-display.test.ts` — しきい値ごとの色 / stale ラベル / `unifiedStatus=rate_limited` の stale 優先 / TPM フォールバックを検証（9 tests）。

### 改修

- `skills/cmux-team/manager/schema.ts` — `RateLimitInfoSchema` を追加し、`RateLimitInfo` は `z.infer<typeof RateLimitInfoSchema>` で再定義（既存フィールドに `updatedAt: string` を含む）。
- `skills/cmux-team/manager/proxy.ts` — streaming / non-streaming 両分岐で `persistRateLimit` をログ付き二段 catch で fire-and-forget。`/rate-limit` エンドポイントの `throttled` 判定に `!isStale(rl)` を追加。
- `skills/cmux-team/manager/main.ts` — `cmdStart` の `initInfra` 直後に `loadRateLimit` を呼び、成功時は `rate_limit_restored unified5h=... unified7d=... stale=<bool>`、失敗時は `rate_limit_restored empty` をログ。`shutdown` で `state.rateLimit` non-null なら最後の flush を `await` 付きで実行。
- `skills/cmux-team/manager/dashboard.tsx` — 旧 `buildRateLimitDisplay` / `buildUtilizationBar` / `formatResetRemaining` を削除し新モジュールに委譲。色文字列 → RGB マップ `mapRateLimitColor` を追加。`isThrottled` に `!isStale(daemon.rateLimit)` ガード追加。
- `skills/cmux-team/manager/daemon.ts` — `initInfra` の `.team/.gitignore` 生成を新規インストール向けには `rate-limit.json` 行を含めて生成、既存インストール向けには migration（`proxy-port` 直後に挿入）を追加。`team_gitignore_migrated` ログ出力、冪等。`throttled5h` と `computeSidebarStatus` の throttle 判定に `!isStale(state.rateLimit)` ガード追加。
- `docs/spec/05-install-and-infrastructure.md` — `.team/rate-limit.json` 章を追加（書き込み・読み込みタイミング、stale 概念、適用 5 箇所、`.gitignore` 管理）。
- `docs/spec/01-skill-cmux-team.md` — dashboard のレート制限表示章（2a）を追加。stale ラベル表示と stale 中の throttle 判定無効化を明記。

## テスト結果

- 新規テスト: **26/26 pass**（`rate-limit-persistence.test.ts` 17 + `rate-limit-display.test.ts` 9）
- 既存テスト: **413/413 pass**（manager ディレクトリ全体）
- 型チェック: `bunx tsc --noEmit` **pass（exit 0）**

## 実装中の判断

1. **TPM フォールバックの stale 扱い**: plan では明言されていなかったが、TPM ヘッダー（分単位ウィンドウ）は unified 5h/7d reset とは独立した別系統なので、`isStale` ガードは適用せずに従来通りの色分けで表示することにした。テストで「TPM >=50% → GREEN」を担保。
2. **`isStale` の `null` rate-limit 受け入れ**: `isStale(null)` を `true`（stale）として扱う API にし、`!isStale(rl)` を各 throttle 判定にシンプルに差し込めるようにした。これで `rl === null` のケースで `(rl?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD` が `false` になる挙動（従来と同じ）を保ちつつ、stale ガードの重複を避けている。
3. **rate-limit-display の色返却方式**: plan の Minor E に従い純粋関数にするため、Rezi の `rgb()` 値ではなく文字列リテラル（`"green"` 等）を返す設計にした。`dashboard.tsx` 側に `RATE_LIMIT_COLOR_MAP` を置いて RGB 変換する。これによりテストが Rezi 非依存になり、`bun test` のスピードが維持される。
4. **`.gitignore` migration の挿入位置**: plan の「`proxy-port` 行の直後に挿入する冪等実装でよい」提案を採用。`findIndex(l => l.trim() === "proxy-port")` で検出し、見つからない場合は末尾追記にフォールバック。冪等性はトリム比較でチェック（コメント行 `# rate-limit.json` は除外）。
5. **shutdown race（Minor Note A）**: plan 通り注釈のみ残し実装は現状維持。proxy fire-and-forget と shutdown flush の交差で最大 1 回分の書き込みが古い値で上書きされる可能性はあるが、次回起動で stale 判定が正しく動くため実害は小さい。

## 懸念・残課題

- 既存テスト `daemon.test.ts` / `proxy.test.ts` は両方 pass しているが、stale ガード追加が throttle 関連のカバレッジに実質的な影響を与えていないかは手動 E2E（§6 の受け入れ条件 B / B' / E）で最終確認が必要。現状 grep で `unifiedStatus === "rate_limited"` を含むテストはなく、フィクスチャ側が未来 reset を使っているので回帰なし。
- `persistRateLimit` の fire-and-forget は `drainAndLog` と同じ二段 catch パターン。CLAUDE.md のロギングポリシー準拠。
- docs/spec/01 と 05 に追記した内容は README.md / SKILL.md 側には波及させていない（plan §3 の変更対象ファイル表に含まれていないため）。ドキュメント整合性は次回 `/docs-sync` で確認する想定。
