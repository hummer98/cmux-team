# T355 完了サマリー

**タスク**: ANTHROPIC_CUSTOM_HEADERS を改行区切りに修正して role/surface 汚染を止める
**ブランチ**: `task-355-1777259174/task`
**worktree**: `/Users/yamamoto/git/cmux-team/.worktrees/task-355-1777259174`
**結果**: GO（Inspector 検品 pass）

## 完了したサブタスク

- Phase 1 Plan: plan.md 作成（Planner Agent surface:182）
- Phase 3 Implementation: TDD で実装（Implementer Agent surface:183）
- Phase 4 Inspection: 検品 GO（Inspector Agent surface:184）

## 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/main.ts` | L1957 (master) と L2114 (conductor) の `ANTHROPIC_CUSTOM_HEADERS` を `, ` 連結から `\n` 連結に変更。コメントに T355 の経緯を追記 |
| `skills/cmux-team/manager/main.test.ts` | `generateMasterSettings` / `generateConductorSettings` の expected を改行区切りに更新。新規 `describe("T355: ANTHROPIC_CUSTOM_HEADERS は改行区切り（カンマ混入禁止）")` で regression テスト 1 件追加 |
| `skills/cmux-team/manager/proxy.test.ts` | 分離ヘッダー (`x-cmux-role` + `x-cmux-surface`) で送信したリクエストが DB の `role` / `surface` 列に分離保存されることを検証する T355 regression テスト 1 件追加 |

`main.ts:2043` (agent surface) は単一値で汚染が発生しないため変更しない（plan.md 通り）。

## テスト結果

- `bun test main.test.ts proxy.test.ts`: **231 pass / 0 fail**
- `for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do bun test --timeout 30000 "$f"; done` (manager 配下 sequential): **57 ファイル 0 fail**
- `bunx tsc --noEmit`: 既存 18 件 (`pool-header-display.test.ts` 由来) のみ。本タスク変更ファイル由来の新規エラーゼロ

## Inspector 検品結果

**GO**。plan.md の要件完全充足、テストはタウトロジーになっておらず regression net として有効、「やってほしくないこと」（DB migration / proxy.ts 改変 / DB スキーマ変更 / 他環境変数改変）はいずれも犯していない。詳細は `inspection.md` 参照。

minor 指摘 3 件への対応:

1. **package-lock.json の差分混入** → Conductor が commit 前に `git restore package-lock.json` で T355 commit から除外。release プロセスの同期不備（`chore: release v4.14.0` で package-lock.json が同期されなかった）は別タスクで対応すべき
2. **agent surface コメントに T355 言及追記** → plan.md でも不要としていた通り見送り（過剰コメント懸念）
3. **実機検証 (Manager 再起動 → trace DB の role 列確認)** → Conductor は自身が再起動対象に含まれるため実施不可。close-task 後に Master が以下を実行することで確認可能:
   ```bash
   # Manager 再起動
   cmux-team start  # （実際は既存 daemon を kill してから再 start）
   # 再起動後、master/conductor から API リクエストが流れた後で:
   sqlite3 .team/traces/traces.db "SELECT DISTINCT role, surface FROM api_usage WHERE timestamp > datetime('now','-5 minutes')"
   # 期待: role が master/conductor/agent の 3 値のみ、surface が surface:NNN 形式
   ```

## マージコミット

完了処理 Step 8/9 で記載予定。

## 関連リンク

- 公式仕様: https://code.claude.com/docs/en/llm-gateway
- 並列タスク: T354 (Metrics タブ正規化、独立)
- 修正対象: `skills/cmux-team/manager/main.ts:1957/2114`
