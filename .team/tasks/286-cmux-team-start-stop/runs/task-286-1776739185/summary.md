# Task Summary: T286 — cmux-team start 自己修復 + stop コマンド廃止

## 完了したサブタスク

- [x] **S1**: `applyDiscardOnly` 関数抽出（reason filter + sequential 実行保証）
- [x] **S2**: `layout_mismatch_on_resume` を純観測ログ化（旧文言「run 'cmux-team stop' then 'start'」削除）
- [x] **S3**: `initializeLayout` フォールバック分岐実装（`resumePlan` を `initializeConductorSlots` に明示的に渡す）
- [x] **S4**: `layout_restore_empty_fallback kept=0 discarded=<N> layout=<wide|16x9>` ログイベント追加
- [x] **S5**: `cmdStop` 削除 (`main.ts` から関数 + `case "stop"` + JSDoc 削除、`i18n.ts` から `help_stop` 削除)
- [x] **S6**: `pidfile.ts` の `PidFileLockedError` メッセージ更新（`Run 'cmux-team stop' or` 削除）
- [x] **S7**: ドキュメント書き換え（README.md / README.ja.md / CLAUDE.md / docs/spec / SKILL.md / cmux-team-guide）
- [x] **S8**: CHANGELOG `[Unreleased]` セクション追加（Changed (Breaking) + Fixed）
- [x] **S9**: テスト追加（M17a/M17b/M17c 3 バリアント + cmdStop unknown command + idempotency）

## 変更ファイル一覧

| ファイル | 差分 |
|---------|------|
| `skills/cmux-team/manager/daemon.ts` | +99, -... |
| `skills/cmux-team/manager/daemon.test.ts` | +236 |
| `skills/cmux-team/manager/main.ts` | -28 |
| `skills/cmux-team/manager/main.test.ts` | +36 |
| `skills/cmux-team/manager/i18n.ts` | -28 |
| `skills/cmux-team/manager/pidfile.ts` | +1, -1 |
| `skills/cmux-team/manager/pidfile.test.ts` | +13 |
| `CHANGELOG.md` | +8 |
| `CLAUDE.md` | +3, -3 |
| `README.md` | +5, -2 |
| `README.ja.md` | +6, -3 |
| `docs/spec/01-skill-cmux-team.md` | +3, -2 |
| `docs/spec/03-commands.md` | +2, -1 |
| `docs/spec/06-implementation-tasks.md` | +5, -2 |
| `skills/cmux-team/SKILL.md` | +3, -2 |
| `skills/cmux-team-guide/SKILL.md` | +3, -3 |
| `package-lock.json` | +2, -2 (4.1.0 → 4.2.0 同期) |

合計: 17 files changed, +400 / -102

## テスト結果

- **`bun test --timeout 600000`**: **852 pass / 0 fail**, 2057 expect() calls
  - 新規追加テスト:
    - `daemon.test.ts` 「マトリクス復帰」describe 配下: M17a (全 E discard) / M17b (全 C idle cleanup) / M17c (C+E 混在) / M17d (全 E + resumePlan unmatched)
    - `main.test.ts` 「cmdStop 廃止 (T286)」describe: Unknown command で exit 1、冪等性
    - `pidfile.test.ts`: PidFileLockedError メッセージに `cmux-team stop` 案内なし
- **`bunx tsc --noEmit`**: **既存 3 件のみ（新規 0 件）**
  - `conductor.ts:201` — TS1016 optional parameter followed by required（既存）
  - `daemon.test.ts:3956` — TS2322 `"new_session"` type（既存）
  - `daemon.ts:1597` — TS2352 SESSION_STARTED cast（既存）

## フロー履歴

| Phase | Round | Verdict | 出力 |
|-------|-------|---------|------|
| Phase 1 (Plan) | v1 | — | plan.md |
| Phase 2 (Design Review) | round 1 | Changes Requested | review-v1.md |
| Phase 1 (Plan revision) | v2 | — | plan.md (v2) |
| Phase 2 (Design Review) | round 2 | **APPROVED** | review-v2.md |
| Phase 3 (Implementation) | round 1 | — | impl-summary.md |
| Phase 4 (Inspection) | round 1 | NOGO (D-section docs only) | inspect-report.md |
| Phase 3 (Fix) | round 2 | — | impl-fix-report.md |
| Phase 4 (Inspection) | round 2 | **GO** | inspect-report-v2.md |

## マージ先

`main` ブランチへローカルマージ予定（ff-only）。

## 主な変更点

1. **自己修復**: `initializeLayout` で `planLayoutRestore` の結果が全て空（`alive` + `resumeExisting` + `resumeNewSurface` = 0）のとき `applyDiscardOnly` で C/E 経路の副作用だけ適用してから `initializeConductorSlots` にフォールバック。これにより KDG-SSO で発生した「全 surface 消失 → Conductor 0 のまま起動完了」が解消される
2. **`cmux-team stop` 廃止**: 破壊的変更。cmux セッション終了で daemon が自動停止するため不要。手動停止は `kill <pid>`（`.team/daemon.pid`）で行う
3. **observability**: `layout_restore_empty_fallback`（fallback 発動）+ 純観測化された `layout_mismatch_on_resume restored=<X> current=<Y>` で診断性が向上
4. **設計原則の徹底**: `applyDiscardOnly` 内で `Promise.all` 禁止 + `for...await` 強制（cmux 側 race condition 回避）

## 完了レポートで強調する勘所

設計判断 / 試行錯誤 / 自己判断 / 残課題 / 成果は完了処理の最後にセッション上に出力する。
