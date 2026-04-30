# T335 完了サマリー

token pool 設定モデルの改訂（A019 §改訂検討事項 2026-04-26 の実装）。
tag 体系を ACL から hint に緩め、project 側に `default` / `include` / `exclude` を導入することで、token / project の追加に伴う設定変更を最小化した。

## 完了したサブタスク

- Phase 1: Plan（plan.md 生成）
- Phase 2: Design Review（Major 3件 + Minor 7件 → Conductor が判断確定 → plan 改訂 → Approved）
- Phase 3: TDD Implementation（Step A〜F 全完了）
- Phase 4: Inspection（GO 判定、Minor 1 を完了処理で修正）

## 設計判断（Conductor 確定済み Open Questions）

| ID | 確定内容 | 根拠 |
|---|---|---|
| M1 | project default の auto-discover 連携は **runtime 昇格のみ・DB 不変** | auto-discover 経路との相互汚染回避 / 副作用なし |
| M2 | OSS project では **`selectable=1` の全 token を候補化（exclude のみ尊重）**。`oss_pool_tags` は廃止 | 受け入れ条件「Project C: pool 対象 K2, K3 すべて」を満たす最も自然なポリシー |
| M3 | Keychain 不在時も **`AGENT_TOKEN_BOUND` post**（dashboard 表示優先）+ env 注入 skip + warn log | 観測性を優先、usage_snapshots は proxy 経路で別途集計される |

判断方針:
- `primary_orgs` 未指定時 → 全て non-OSS（旧動作維持）
- `default ∩ include` → include 側を黙って dedup（`default` 優先）
- `exclude ∋ default` → warn ログ + exclude から default を除外（`default` 候補化を維持）
- 大文字混じり handle → warn のみ、reject も lowercase 化もしない

## 変更ファイル一覧

| ファイル | 種別 | +/- |
|---|---|---|
| `skills/cmux-team/manager/config.ts` | 編集 | +191 / -15 |
| `skills/cmux-team/manager/config.test.ts` | **新規** | +341 / -0 |
| `skills/cmux-team/manager/project-tags.ts` | 編集 | +90 / -17 |
| `skills/cmux-team/manager/project-tags.test.ts` | 編集 | +189 / -8 |
| `skills/cmux-team/manager/token-store.ts` | 編集 | +110 / -14 |
| `skills/cmux-team/manager/token-store.test.ts` | 編集 | +416 / -0（うちテスト名修正 1 件） |
| `skills/cmux-team/manager/main.ts` | 編集 | +57 / -9 |
| `package-lock.json` | 編集 | +81 / -0（worktree bootstrap 由来） |
| `.team/artifacts/A019-token-pool-design.md` | 編集（main 側、未追跡） | M1/M2/M3 文面整合 |

## テスト結果

| 実行単位 | pass | skip | fail |
|---|---:|---:|---:|
| `config.test.ts` + `project-tags.test.ts` | 64 | 1 | 0 |
| `token-store.test.ts` | 93 | 1 | 0 |
| `main.test.ts` | 174 | 0 | 0 |
| `pool-* / token-cli / token-format` | 52 | 4 | 0 |
| `daemon / conductor / master / proxy` | 260 | 0 | 0 |
| その他 manager 全 46 ファイル | 605 | 0 | 0 |
| **合計（実装 Agent 計測）** | **1248** | **5** | **0** |
| **Inspector 再検証（小束）** | **643** | **6** | **0** |

`bunx tsc --noEmit` 新規エラー 0 件（出力なし、exit 0）。

## 受け入れ条件達成

| Project | 受け入れ条件 | 実装場所 | 達成 |
|---|---|---|---|
| A | default=K2 最優先 / include の K1 フォールバック / K3 候補外 | `token-store.test.ts:1451-1517` (4 ケース) | ✓ |
| B | `tokenPool.enabled=false` で pool 機能 OFF | `config.test.ts:317-340` (`resolveTokenPoolEnabled`) | ✓ |
| C | OSS で K1/K2/K3 全 candidate / blocker fallback / exclude のみ尊重 | `token-store.test.ts:1521-1567` (3 ケース) | ✓ |

## Inspector findings 対応

- **Minor 1 (テスト名の誤読防止)**: `token-store.test.ts:1451` のテスト名と説明コメントを「default と include は両方 admit される（最終選択は score）」に書き換え + コメント整理 → 完了
- **Minor 2 (log level の warn 引数なし)**: 現状の `log()` API に level 引数がないため、event 名 `token_pool_fallback` で意味を明示する暫定対応とする。`logger.ts` の API 拡張は別タスク扱い → 残課題
- **Minor 3 (A019 artifact が main 側 untracked)**: A018 / A019 とも main 側で untracked のまま運用されており、本タスクの commit 範囲外。Master 側の運用判断 → 残課題（Master 側で必要に応じて別途 commit）

## 触っていない領域（境界遵守）

- DB schema 変更なし（`SCHEMA_V1` 不変）
- Keychain 連携実装は `retrieveTokenFromKeychain` / `KeychainNotFoundError` の再利用のみ
- `cmux-team token add|list|remove|rotate` CLI 変更なし
- proxy / api_usage / usage_snapshots 書き込み経路変更なし
- EventBus 直接 `emit`/`on` 呼び出し新規追加なし
- task-state 直接書き換え新規追加なし
- 空 `catch {}` 新規追加なし

## マージコミット / PR

ローカルマージ予定（後段で更新）。
