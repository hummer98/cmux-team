# タスク割り当て

## タスク内容

---
id: 265
title: formatUserClearDecision の assigning_set_at を conductor.assigningSetAt 由来に修正する（T261 follow-up）
priority: medium
created_by: surface:199
created_at: 2026-04-19T03:27:48.607Z
---

## タスク
## 背景

T261 で追加された user_clear 判定スナップショットログの \`assigning_set_at\` フィールドが、キー名と実体のセマンティクスが一致していない（Inspector Major 1）。

- **キー名の意図**: Conductor が \`status=\"assigning\"\` にセットされた時刻（= \`assignTask\` が /clear を送る直前）
- **実装の実体** (\`daemon.ts:233\`): \`conductor.startedAt\` を参照しており、これは Conductor プロセス/セッション開始時刻（\`launchConductor\` で \`new Date().toISOString()\` にセット、assignTask では更新されない）

### 実害（T262 事例）

2026-04-19 11:45:09 のログ:

\`\`\`
user_clear_decision_snapshot C[192] case=session_clear_expected
  prev_status=assigning
  clear_sent_at=2026-04-19T02:45:08.452Z
  assigning_set_at=2026-04-19T01:00:00.226Z   ← 1h45m 前を指している
  elapsed_since_clear_sent=1172
\`\`\`

このログだけ見ると「Conductor は 1h45m の間 assigning 状態だった」ように読めるが、実際にはこの瞬間に assignTask が呼ばれて assigning に入ったばかり。次に user_clear 誤判定を追う際、このフィールドが noise になり調査を詰まらせる。

## やること（実装方針）

1. **ConductorState に \`assigningSetAt?: string\` を追加**
   - \`skills/cmux-team/manager/schema.ts\` or 型定義箇所を探す
   - 既存の T261 系フィールド（\`clearSentAt\`, \`promptSentAt\`, \`promptBytes\`, \`sessionStartedClearAt\`, \`sessionIdleAtInAssigning\`）と同じ扱い（runtime only、永続化対象外）

2. **\`assignTask\` で status=assigning にセットする直前/直後に \`assigningSetAt\` を代入**
   - \`skills/cmux-team/manager/conductor.ts\` の \`assignTask\` 内（T232 で導入された assigning 遷移箇所、CLAUDE.md 参考: conductor.ts:420 付近）
   - \`conductor.status = \"assigning\"\` と同じトランザクションで \`conductor.assigningSetAt = new Date().toISOString()\`

3. **\`resetConductor\` で undefined クリア**
   - \`skills/cmux-team/manager/conductor.ts:558 resetConductor\` 内で他の T261 系フィールドと同様に \`conductor.assigningSetAt = undefined\`

4. **\`formatUserClearDecision\` で読み替え** (\`daemon.ts:233\`)
   - \`assigning_set_at=\${conductor.startedAt ?? \"null\"}\` → \`assigning_set_at=\${conductor.assigningSetAt ?? \"null\"}\`

5. **テスト追加**
   - assignTask で assigningSetAt がセットされること
   - resetConductor で undefined に戻ること
   - formatUserClearDecision の出力に assigningSetAt が反映されること（startedAt が参照されないこと）
   - 既存 T261 テスト（daemon 9 本 + conductor 2 本）が壊れないこと

## 参考ファイル

- skills/cmux-team/manager/daemon.ts:221 (formatUserClearDecision)
- skills/cmux-team/manager/conductor.ts の assignTask / resetConductor
- .team/tasks/261-user-clear/runs/task-261-1776560866/inspection.md の Major 1 Finding
- CLAUDE.md \"T261: user_clear 判定スナップショット\" 周辺

## 期待する完了状態

- user_clear_decision_snapshot ログの \`assigning_set_at\` が、実際に Conductor が assigning に入った時刻を指す
- 調査時に \`elapsed_since_clear_sent\` と \`assigning_set_at\` の両方が意味のある値として読める
- bun test 全通過

## 非スコープ

- Inspector Minor 2（impl-report のテスト数字ずれ）は対応不要
- Inspector Minor 3（positive/negative 合流テスト）は仕様許容範囲内のため対応不要
- キー名変更案（\`conductor_started_at\` にリネーム）は採用しない（観測性改善よりキー後方互換を優先）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-265-1776569268` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-265-1776569268
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-265-1776569268/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/265-formatusercleardecision-assigning-set-at-conductor-assigningsetat-t261-follow-up/runs/task-265-1776569268
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/265-formatusercleardecision-assigning-set-at-conductor-assigningsetat-t261-follow-up/runs/task-265-1776569268/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」Step 12 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
