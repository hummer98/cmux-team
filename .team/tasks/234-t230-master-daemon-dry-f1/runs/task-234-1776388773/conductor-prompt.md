# タスク割り当て

## タスク内容

---
id: 234
title: T230 後続: master/daemon 周辺整理（DRY化・テスト補強・リソースリーク・F1掃除）
priority: medium
created_at: 2026-04-17T01:17:49.342Z
---

## タスク
# 背景

T230（Master self-register）の inspection / impl-report で挙がった 5 件の follow-up を 1 タスクにまとめて処理する。すべて master.ts / daemon.ts / main.ts 周辺の整理で、別タスクに分けると同一ファイルへの並列マージ競合が発生しやすいため統合。

参照:
- impl-report: \`.team/tasks/230-master-self-register-pane-cmux-team-spawn-master/runs/task-230-1776382576/impl-report.md\` §5
- inspection: \`.team/tasks/230-master-self-register-pane-cmux-team-spawn-master/runs/task-230-1776382576/inspection.md\` Findings #2 / #3

# やること

## 1. [S12-2 / 唯一のリソースリーク懸念] stopDaemon の clearInterval 漏れ対応

\`stopDaemon\` 時に PID watcher の \`setInterval\` が解放されていない。daemon 終了時にタイマーが残ると process exit までイベントループが回り続ける可能性。

- 対象: \`skills/cmux-team/manager/daemon.ts\` の \`spawnPidWatcher\` / \`stopDaemon\` 周辺
- watcher の \`intervalId\` を state または map で保持し、\`stopDaemon\` で全 watcher の \`clearInterval\` を実行
- 既存テストが落ちないこと、Bun の exit がハングしないこと

## 2. [S12-1] normalizeSurfaceForPath の重複定義整理

\`master.ts\` と \`daemon.ts\` で同名の \`normalizeSurfaceForPath\` 関数が独立定義されている。

- 共通モジュール（例: \`paths.ts\` or 既存の utils）に集約
- 両ファイルから import するよう変更
- 振る舞いの差異が無いことを確認

## 3. [S12-3] master.test.ts 新規作成

現状 \`master.ts\` 固有のユニットテストは \`daemon.test.ts\` 経由でカバーされているのみ。

- \`skills/cmux-team/manager/master.test.ts\` を新規作成
- 対象関数: \`persistMasterFile\` / \`deleteMasterFile\` / \`loadMasterFiles\`
- 境界ケース（不正 JSON / ファイル不在 / 空ディレクトリ / 同名 surface 重複等）

## 4. [F1-cleanup] F1 fallback で master 仮登録された conductor の掃除

\`daemon.ts:1104-1133\` の SESSION_STARTED fallback は、未登録 surface を **master として仮登録**する。実運用では \`registerSelfAsConductor\` が claude exec 前に POST されるため通常は発生しないが、極端な遅延時に conductor を master として誤登録するレースが理論上残る。

- \`CONDUCTOR_REGISTERED\` handler に「同 surface が \`state.masters\` に存在すれば削除」する補正を追加
- \`MASTER_REGISTERED\` handler 側でも同様（後着 master の正本登録時に F1 仮登録分を上書き）に整合
- 削除時は \`log(\"master_fallback_cleanup\", \`surface=\${surface} reason=conductor_registered_late\`)\` を記録
- 既存テスト（特に T230 の T1〜T6）が落ちないこと

## 5. [DRY] registerSelfAsMaster / registerSelfAsConductor 共通化

\`main.ts:1169-1204\` (registerSelfAsMaster) と \`main.ts:1217-1252\` (registerSelfAsConductor) はほぼ同一構造。

- \`registerSelf(role: \"master\" | \"conductor\", surface: string)\` に共通化
- 既存の 2 関数は薄いラッパー（後方互換維持のため）or 直接 import 元の cmdLaunchMaster/cmdLaunchConductor で \`registerSelf(role, surface)\` を呼ぶ形に変更
- ログイベント名は既存の \`master_self_register\` / \`conductor_self_register\` を維持

# 検証

\`\`\`bash
cd skills/cmux-team/manager
bun install
bunx tsc --noEmit          # 型チェック
bun test                   # 423 pass を維持 + master.test.ts 追加分
\`\`\`

E2E:
- \`cmux-team start\` → master / conductor が登録され team.json に正しく出ること
- \`cmux-team stop\` 後に bun process が即時 exit すること（タイマー残存なし）

# やらないこと（過剰実装の禁止）

- 5 件以外のリファクタリング・新機能追加
- ログフォーマットの大幅変更（既存の \`logger.ts\` 規約に準拠）
- 設計書（docs/spec/）の大改訂（必要な追記程度に留める）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-234-1776388773` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-234-1776388773
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-234-1776388773/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/234-t230-master-daemon-dry-f1/runs/task-234-1776388773
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/234-t230-master-daemon-dry-f1/runs/task-234-1776388773/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
