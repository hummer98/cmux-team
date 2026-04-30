# T341 サマリー — auto-discover gate + `cmux-team token promote`

## 達成したこと

1. **auto-discover gate**: pool 設定 OFF の project では proxy が未知 token を `tokens.db` に INSERT しないようにした。既知 token の `usage_snapshots` 更新は維持。
2. **`cmux-team token promote @<auto-handle> <new-display-name>`**: auto-discover で登録された token を正規 handle に昇格させる migration コマンドを追加した。

## サブタスク

| Phase | Agent | 出力 |
|-------|-------|------|
| Phase 1 (Plan) | Planner (surface:150) | `plan.md` (663 行) |
| Phase 2 (Design Review) | Design Reviewer (surface:152) | `design-review.md` — Verdict: **Approved**（Critical 0 / Major 4 / Minor 6） |
| Phase 3 (Impl) | Implementer (surface:154) | `impl-result.md` — Step 1-5 + M1-M4 + m1-m6 すべて反映 |
| Phase 4 (Inspection) | Inspector (surface:155) | `inspection.md` — Verdict: **GO**（Critical 0 / Major 0 / Minor 4） |

## 変更ファイル

| ファイル | 変更内容 |
|----------|----------|
| `skills/cmux-team/manager/proxy.ts` | `updateTokensDB` の signature を options object 化 (`{ tokenPoolEnabled, getState? }`)、`start()` で起動時 1 回 `isTokenPoolEnabled` 評価、`else if (organizationId)` 直下に gate 配置 |
| `skills/cmux-team/manager/token-store.ts` | `updateTokenPromoteFields(db, token_id, fields)` を新規 export — id 維持で `handle/auth_hash/plan/plan_ratio/tags/credential_source/selectable=1` を atomic UPDATE |
| `skills/cmux-team/manager/token-cli.ts` | `cmdTokenPromote` を新規追加。`add` と同形の source 選択 UI、`organization_id` 一致検証、`newHandle === oldHandle` の info ログ、Keychain 先 → DB 後の順序、`plan='unknown'` 時の `set-plan` ヒント、`try/finally` で `db.close()` |
| `skills/cmux-team/manager/main.ts` | `cmdTokenPromote` の import / switch / Usage 文言追加 |
| `docs/spec/09-token-pool.md` | `set-plan` 直後に `### cmux-team token promote` セクション追加（M2 ヒント・M3 同一 handle 挙動・m6 rename 余地に言及）、`auto-discover` 節に「pool 機能 OFF では skip（T341）」+「proxy 起動時 1 回キャッシュ」明記 |

## テスト

| ファイル | 追加テスト | 結果 |
|----------|------------|------|
| `proxy.test.ts` | T341-P1〜P4（pool gate 4 ケース。P4 は m4 推奨に従い「起動時 1 回キャッシュ」検証） | 43 pass / 0 fail |
| `token-store.test.ts` | `updateTokenPromoteFields` 単体（正常系 / token_id 維持 / plan_ratio=null）3 ケース | 96 pass / 0 fail / 1 skip（既存） |
| `token-cli.test.ts` | `cmdTokenPromote` integration R-promote-1〜11（正常系 credential、manual + tags、org_id 不一致、旧 handle 不在、新 handle 衝突、auto-discover 以外を拒否、probe 失敗、usage_snapshots 維持、newHandle === oldHandle、plan='unknown' ヒント、引数不足）11 ケース | 24 pass / 0 fail / 4 skip（既存） |
| `config.test.ts` | non-regression | 26 pass / 0 fail |

`bunx tsc --noEmit` (skills/cmux-team/manager) → exit 0、新規エラー 0 件。

## 受け入れ条件 (AC1-5)

| AC | 内容 | 結果 |
|----|------|------|
| AC1 | pool OFF で `claude` を動かしても tokens.db に新規 INSERT されない | ✓ T341-P1 |
| AC2 | pool ON では従来通り auto-discover が走る | ✓ T341-P2 |
| AC3 | `cmux-team token promote @cd8d kddi` で selectable=1 / handle=@kddi / plan / Keychain 登録 | ✓ R-promote-1, 2 |
| AC4 | promote 前後で `usage_snapshots` が壊れない（token_id 維持） | ✓ R-promote-8 + token-store.test.ts |
| AC5 | pool OFF でも proxy の usage tracking（既知 token snapshot 更新）は機能する | ✓ T341-P3 |

## 設計判断のハイライト

- **M1 (`updateTokensDB` の options object 化)**: 呼び出し点が 2 箇所だけだが将来の追加引数に強く、可読性が高い options object を採用。
- **gate のキャッシュ**: proxy 起動時に 1 回 `isTokenPoolEnabled(projectRoot)` を評価しクロージャ束縛。daemon 再起動が pool 設定変更の前提という既存運用と一貫。`proxy_token_pool_resolved` ログで観測可能。
- **promote の auth_hash 検証**: 「probe で取れた organization_id が DB の既存レコードと一致するか」を検証（auth_hash の完全一致は要求しない）。別アカウントの token が混入することを防ぐ。
- **Keychain 先 → DB 後**: 既存 `cmdTokenAdd` の冪等性パターンに揃える。Keychain 失敗時は DB 未変更で safe。
- **`auto-discover` 限定 promote**: `selectable=1` の token を rename する別コマンドは scope 外（仕様書に `cmux-team token rename` の将来余地として明記）。

## マージ情報

- **ブランチ**: `task-341-1777188656/task` → `main`（ローカル ff-only マージ）
- **マージ commit**: 完了処理 Step 11 で記録
