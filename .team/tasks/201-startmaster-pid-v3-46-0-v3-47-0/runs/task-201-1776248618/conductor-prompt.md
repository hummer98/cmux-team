# タスク割り当て

## タスク内容

---
id: 201
title: startMaster の PID フォールバック実装 — v3.46.0→v3.47.0 マイグレーション非互換の修復
priority: high
created_at: 2026-04-15T01:46:06.593Z
---

## タスク
## 症状

daemon auto-restart 時に既存 Master が dead 判定され、重複 Master が spawn される。結果として U[55] がゾンビ、U[116] が新規 spawn され、`.team/master.surface` マーカーと team.json の master section が U[116] に切り替わる。ユーザーが U[55] で作業していた会話コンテキストは daemon の認識から外れる。

## 実測ログ（2026-04-15）

\`\`\`
05:55:35 daemon_started v3.46.0 pid=45378           ← pre-T195 (surface ベース判定)
05:55:38 master_alive U[55]                          ← surface 検証で OK
10:18:29 source_changed file=preflight.ts           ← T195 リリース差分の検知
10:18:39 daemon_auto_restart
10:18:40 daemon_started v3.47.0 pid=74850           ← post-T195 (PID ベース判定)
10:18:42 resume_fallback_to_ready task_id=199 reason=no_worktree
10:18:42 conductors_restored count=2 surfaces=C[53],C[54]
10:18:42 master_check_failed U[55] alive=false      ← ← ← 問題発生
10:18:43 master_spawning
10:18:43 master_spawned U[116]
\`\`\`

## 根本原因

T195 (6e44637) で \`startMaster\` が surface 検証から PID 検証に切り替わった。新 \`isMasterAlive(projectRoot)\` は \`.team/team.json\` の \`master.pid\` を読むが、以下の理由で team.json に pid が書かれないまま v3.46.0 → v3.47.0 に乗り換えるケースが非互換になっている。

### なぜ team.json に master.pid が無かったか

1. pre-T195 (v3.46.0) の \`startMaster\` は \`isMasterAlive(surface)\` のみで生存確認し、\`state.masterPid\` を設定しない (master.ts:50 pre-T195 版で確認)
2. \`state.masterPid\` は \`SESSION_STARTED\` push メッセージ受信時にのみ設定される (daemon.ts:739)
3. Master は 05:47 時点で既に起動済み (Claude Code セッション継続中) なので、v3.46.0 の稼働中に新規 \`SESSION_STARTED\` push は飛んでこない
4. この環境は \`CMUX_CLAUDE_HOOKS_DISABLED=1\` が設定済み (\`envrc_check_skipped reason=already_set\` ログ) で、そもそも hook push が限定的
5. 結果として v3.46.0 稼働中ずっと \`state.masterPid = undefined\`、\`updateTeamJson\` は毎回 \`pid: undefined\` を書き込み、JSON.stringify が落とすので team.json に master.pid フィールドが存在しない

### なぜ v3.47.0 が騙されたか

\`skills/cmux-team/manager/daemon.ts:477\` の短絡評価:

\`\`\`typescript
const alive = restoredMasterPid != null && await isMasterAlive(state.projectRoot);
\`\`\`

- team.json に pid が無い → \`restoredMasterPid = undefined\`
- 短絡で \`alive = false\`（\`isMasterAlive\` すら呼ばれない）
- \`master_check_failed\` → 新規 spawn パスへ

## 対策案（検討してほしい）

### Option A: pid 未登録時は旧 surface 検証にフォールバック

\`\`\`typescript
if (restoredMasterPid != null) {
  alive = await isMasterAlive(state.projectRoot);
} else {
  // pid 不明時: surface 検証で代替
  alive = await cmux.validateSurface(surface, state.workspace);
}
\`\`\`

- メリット: 最小変更でマイグレーション互換を取り戻せる
- デメリット: T195 が排除したかった cmux tree/list-status 系の呼び出しが一部残る

### Option B: 起動直後に ps で Master プロセスを発見して pid を同期

\`\`\`bash
ps -ax -o pid,command | grep "claude.*master-settings.json" | grep -v grep
\`\`\`

- メリット: PID ベースに一本化できる
- デメリット: プラットフォーム依存（macOS/Linux の ps 違い）、プロンプトパスのマッチングが脆い

### Option C: Master の \`.team/master.surface\` マーカーに pid を併記

現在のマーカーは surface のみ。\`surface:116\\npid:76460\` のように pid を追記して、次回 daemon 起動時に読み出す。

- メリット: team.json 経路を介さない、spawn 時に書き込めば確実
- デメリット: マーカーファイルのフォーマット変更（既存の書き込み箇所を全て更新する必要）
- 注意: マーカーはマイグレーション途中でフォーマットが揃っていないケースがあるため、パース時は surface のみでも fallback して読めるようにする

### Option D: 起動時に \`SESSION_STARTED\` 相当の push を強制する

Master spawn 時に cmux-team 側から自発的に pid を push する仕組み。

- メリット: 既存のメッセージ経路を使える
- デメリット: 「Master は独立プロセス」の境界を daemon 側が越える必要があり、設計上微妙

## 関連ファイル

- \`skills/cmux-team/manager/daemon.ts:457-511\` — \`startMaster\`
- \`skills/cmux-team/manager/master.ts:50-61\` — \`isMasterAlive\` (post-T195)
- \`skills/cmux-team/manager/daemon.ts:1550-1595\` — \`updateTeamJson\`
- \`skills/cmux-team/manager/daemon.ts:739\` — SESSION_STARTED で masterPid 設定

## 副作用

- 旧 U[55] Master (PID 23504) がゾンビとして稼働し続ける。今回の修正では掃除まで含めるか、別タスクに切るか判断する
- 新 U[116] Master (PID 76460) が team.json には登録されているが、state.masterPid は undefined のまま (SESSION_STARTED push が飛んでこないため)
- つまり現在の daemon も既に同じ状態に陥っており、**次の daemon 再起動でまた U[116] が dead 判定されて U[次] に移る**

## 受け入れ基準

- v3.46.0 以前から引き継いだ Master が v3.47.0+ の daemon 再起動で重複 spawn されないこと
- team.json の master.pid 欄が空でも (pid が事後的に push されていない状態でも) 既存 Master を正しく復元できること
- 既存の \`daemon.test.ts\` / \`cmux.test.ts\` が通ること。新規ケースとして「team.json に master.pid 無し + surface 生存」のテストを追加すること

## 補足

- T201 の作業自体は worktree を切って普通に進めて OK
- 現在の Master U[116] は SESSION_STARTED push を受けていないため state.masterPid = undefined のまま。修正を検証するには別プロセスで新旧シナリオを再現する必要がある


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-201-1776248618` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-201-1776248618
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-201-1776248618/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/201-startmaster-pid-v3-46-0-v3-47-0/runs/task-201-1776248618
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/201-startmaster-pid-v3-46-0-v3-47-0/runs/task-201-1776248618/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
