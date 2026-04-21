# T283 完了サマリー

**タイトル**: Master の git 操作解禁 + worktree fetch デフォルト ON + ready 昇格時の sync 警告

**完了日**: 2026-04-21

## 完了したサブタスク

Plan v2 の ST1 〜 ST15 全実装 + Inspector Finding 1/2 に対する fix round を完了。

| 区分 | 内容 |
|------|------|
| ST1-ST2 | `git-sync.ts` / `git-sync.test.ts` 新規作成（34 tests） |
| ST3-ST5 | `resolveFetchBeforeWorktree` 追加・デフォルト ON 化・起動ログ emit |
| ST6-ST9 | `cmdCreateTask` / `cmdUpdateTask` に sync check、env bypass 注入 |
| ST10-ST13 | help テキスト / Master テンプレート / CLAUDE.md / docs/spec 同期 |
| ST14-ST15 | CHANGELOG、手動検証シナリオドキュメント化 |
| Fix | CLAUDE.md ログテーブル修正、impl-report 代替検証追記 |

## 変更ファイル

**新規**:
- `skills/cmux-team/manager/git-sync.ts`（301 行）
- `skills/cmux-team/manager/git-sync.test.ts`（563 行）

**変更**:
- `skills/cmux-team/manager/config.ts`（`resolveFetchBeforeWorktree` 追加）
- `skills/cmux-team/manager/conductor.ts`（`doFetch` でデフォルト ON、shell export に `CMUX_TEAM_SKIP_SYNC_CHECK=1`）
- `skills/cmux-team/manager/main.ts`（`runSyncCheckOrExit`, `cmdStart` log, `cmdSpawnAgent` exportVars, `cmdCreateTask` / `cmdUpdateTask` に sync check 配線）
- `skills/cmux-team/manager/i18n.ts`（ja/en help）
- `skills/cmux-team/templates/ja/master.md`, `skills/cmux-team/templates/en/master.md`（git ポリシー緩和）
- `CLAUDE.md`（Ready 昇格 sync ガード節、デフォルト ON 記述、ログイベントテーブル）
- `docs/spec/04-templates.md`, `docs/spec/05-install-and-infrastructure.md`
- `CHANGELOG.md`（Unreleased Breaking x2 + Added x1）

## テスト結果

- `bun test git-sync.test.ts`: **34 pass / 0 fail / 68 expect()**（16ms）
- `bun test`（manager 全体）: **836 pass / 0 fail / 2000 expect()**（37.42s）
- `bunx tsc --noEmit`: 新規型エラー 0 件（既存 pre-existing 3 件のみ）

## 設計の要点

| 項目 | 採用した方針 |
|------|------------|
| State machine | 7 state enum (`clean` / `behind-ff` / `ahead` / `diverged` / `uncommitted` / `detached` / `no-remote`) + 純関数 `decideSyncState` / `classifyVerdict` |
| Agent 経路 bypass | `cmdSpawnAgent` の `exportVars` に `CMUX_TEAM_SKIP_SYNC_CHECK=1` を**無条件で**追加（Agent surface は Conductor env を継承しないため） |
| デフォルト ON 化 | `CMUX_TEAM_FETCH_BEFORE_WORKTREE`: 未設定→ON、`0/false/off`→OFF、bogus→throw（`resolveAutoUpdateMode` と同構造） |
| ログイベント | `ready_rejected` / `ready_warning` / `ready_force_bypass` / `ready_sync_skipped`（env / config の 2 経路） |

## 関連アーティファクト

- plan.md（487 行、v2 approved）
- review-v1.md / review-v2.md（2 往復で approved）
- impl-report.md / impl-fix-report.md
- inspect-report.md（Verdict: GO, Critical 0 / Major 0 / Minor 2）

## マージ情報

ローカル main に ff-only マージ（コミット SHA は完了レポート参照）。
