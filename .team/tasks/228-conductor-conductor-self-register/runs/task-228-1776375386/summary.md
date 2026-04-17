# T228 実装サマリー: Conductor self-register 方式への移行

## タスク概要
Conductor 登録を Manager の `launchConductor` からの HTTP POST 方式から、Conductor 自身（`cmdConductor` / `cmdResume`）が自分を register する方式に変更。任意の surface から手動で `cmux-team conductor` を実行しても daemon に登録されるようにする。

## フェーズ実行履歴
| フェーズ | Agent | 結果 |
|---------|-------|------|
| Phase 1: Plan | Planner | plan.md (初版) 作成 |
| Phase 2: Design Review (v1) | Design Reviewer | **Changes Requested** - S6 fallback 削除が resume 経路を壊す / D3 soft cap 条件が発火しない |
| Phase 1b: Plan 改訂 | Planner rev2 | plan.md (v2) に修正版反映 |
| Phase 2b: Design Review (v2) | Design Reviewer rev2 | **Approved** |
| Phase 3: Impl | Implementer | S1〜S8 全完了、型チェック exit 0、bun test 390 pass |
| Phase 4: Inspection | Inspector | **GO** - Critical 0件 |

## 変更ファイル
- `skills/cmux-team/manager/main.ts` — `registerSelfAsConductor` ヘルパー追加、`cmdConductor` / `cmdResume` に組み込み
- `skills/cmux-team/manager/conductor.ts` — `launchConductor` から POST 削除、`initializeConductorSlots` の非 resume 分岐削除（resume 分岐は保持）
- `skills/cmux-team/manager/daemon.ts` — `CONDUCTOR_REGISTERED` ハンドラを idempotent merge 化（skip + existing_status/pid ログ、soft cap warning）
- `skills/cmux-team/manager/daemon.test.ts` — 新規 3 ケースのユニットテスト
- `docs/spec/01-skill-cmux-team.md` — self-register 説明追記
- `docs/spec/05-install-and-infrastructure.md` — メッセージング節更新

## 検証結果
- `bunx tsc --noEmit` → exit 0
- `bun test daemon.test.ts` → 76 pass / 0 fail
- `bun test`（全体）→ 390 pass / 0 fail

## 設計判断（Decision Log）
- D1: proxy-port 読み取り失敗時は fail-fast (exit 1)
- D2: 重複 register は既存 state を skip（破壊防止）
- D3: soft cap は `state.conductors.size >= state.maxConductors` 比較（env 未指定でも発火）
- D4: `initializeConductorSlots` の fallback ブロックは resume 分岐のみ保持（Design Review (A) 採用）
- D5: cmdResume でも `registerSelfAsConductor` を呼ぶ
- D6: hard cap は導入しない
- D7: `cmdSpawnConductor` の mainBranch 未渡しは既知の未修正箇所（スコープ外）

## 納品
- マージ先: `main` ブランチ（ローカルマージ）
