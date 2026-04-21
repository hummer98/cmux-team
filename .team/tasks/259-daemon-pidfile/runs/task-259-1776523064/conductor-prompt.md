# タスク割り当て

## タスク内容

---
id: 259
title: daemon 多重起動を防止する (pidfile ロック)
priority: high
created_by: surface:130
created_at: 2026-04-18T13:47:00.399Z
---

## タスク
## 背景

2026-04-18 に ~/git/Dear で daemon が 3 つ同時起動し、各 daemon が in-memory 状態を \`task-state.json\` に書き戻し合ってタスク close 情報が消失する事例が発生した。

症状:
- Conductor の \`cmux-team close-task\` が \`OK closed\` を返しても、他 daemon が古い in-memory state で上書き → \`task-state.json\` は assigned のまま残る
- 被害タスク: T174, T178, T180, T190（いずれも \`task_completed\` がログに出ているのに assigned 状態）
- 同時多発の証拠: \`rate_limit_persist_failed ENOENT ... rename '.tmp' -> ...\` / \`updateTeamJson failed: ENOENT ... rename\` が多数（tmp file が別プロセスの rename で消えた痕跡）
- \`master_state_surface_ambiguous masters=2\` が連続出力

## 根本原因

\`skills/cmux-team/manager/main.ts\` の \`cmdStart\`（L251）に **多重起動防止機構が存在しない**。pidfile / flock / lockfile いずれも未実装。そのため同じ \`.team/\` に対して複数 daemon が起動でき、tmp+rename の atomicity では serializability を保証できないため last-writer-wins で書き込みが消える。

## やってほしいこと

### 1. pidfile による排他起動

\`.team/daemon.pid\` に起動時の PID を書き込み、起動前に以下を実行:

1. \`.team/daemon.pid\` が存在 → PID を読む
2. その PID が生きている（\`process.kill(oldPid, 0)\` で確認）→ **fail-stop**
   - エラーメッセージ例: \`Error: daemon already running (pid=<N>) at workspace=<ws>. Run 'cmux-team stop' or kill <N> first.\`
   - exit code 1
3. 生きていない（stale） → 削除してから自分の pid で再作成
4. 作成は \`writeFile(path, pid, { flag: 'wx' })\`（O_EXCL で atomic）
5. EEXIST が返ったら \`1.\` に戻る（race で別 daemon が先に取った可能性）→ リトライ上限 3 回で最終的に fail-stop

### 2. pidfile 削除

- \`cmdStop\` → SHUTDOWN message handler で pidfile を unlink
- \`process.on("SIGINT" | "SIGTERM", shutdown)\` の shutdown（main.ts:456-457）でも unlink
- **graceful shutdown 以外（SIGKILL 等）では残るのは許容** — 次回起動時の stale チェックで掃除される

### 3. pid 再利用への保険（軽量）

- stale チェックで \`process.kill(pid, 0)\` だけだと別プロセスに pid が recycle されている可能性
- \`ps -p <pid> -o command=\` で出力に \`main.ts\` または \`cmux-team\` が含まれるかを軽く確認
- 含まれなければ stale とみなして削除（過剰設計気味だが pid 再利用は macOS で起こり得る）

### 4. auto-restart ループとの整合

\`main.ts:459\` 付近の \`onReload\` で \`execFileSync(\"bun\", [\"run\", latestMainTs, \"start\"])\` を再起動ループで回している。再起動時に pidfile がまだ自分の旧 pid で残る可能性があるので、以下を確認すること:

- 親プロセスが shutdown → pidfile 削除 → 子 start → pidfile 作成、の順序になっているか
- または再起動時に pidfile の pid を自分の pid で上書き可能にする特別な抜け穴が必要か

**設計判断**: auto-restart 中は同一 workspace で確実に 1 プロセスのみなので、再起動ループ内では pidfile を一度削除してから新プロセスが掴む方式で OK。実装時に上位プロセス側で unlink → exec → 子が atomic create する順序を保証すること。

## 対象ファイル

- \`skills/cmux-team/manager/main.ts\`
  - \`cmdStart\` の冒頭（preflight の前 or 直後、createDaemon より前）に pidfile acquire 処理
  - shutdown handler（L456-457 の \`shutdown\` 関数）に pidfile unlink 処理
  - onReload 再起動ループ（L459〜）で pidfile の扱いを整合
  - \`cmdStop\` に pidfile unlink の保険
- 新規ヘルパー（任意）: \`skills/cmux-team/manager/pidfile.ts\` に \`acquirePidFile(path): Promise<void>\` / \`releasePidFile(path): void\` / \`isAlive(pid): boolean\`

## 完了条件

- 同一 \`.team/\` に対して 2 回目の \`cmux-team start\` が fail-stop（exit 1）で止まること
- stale pidfile（daemon が SIGKILL で死んだ痕跡）は次回起動時に自動掃除されること
- 正常な SIGTERM / cmdStop で pidfile が削除されること
- auto-restart ループが壊れないこと（連続再起動が可能）
- 既存の \`main.test.ts\` / \`daemon.test.ts\` を壊さないこと
- 新アルゴリズムに対するテスト追加（pidfile race / stale cleanup / graceful shutdown）

## 考慮点

### 並行する cmux-team start を shell で投げた場合

2 つの shell から \`cmux-team start\` がほぼ同時に発火しても、\`writeFile({ flag: 'wx' })\` は atomic なので片方だけ成功する。失敗側は EEXIST → リトライ → 最終的に fail-stop する流れが正しく走ること。

### preflight との関係

preflight は副作用なしのチェック群なので、pidfile acquire は preflight の **後**（checkDirenvAllowed の後、createDaemon の前）に置く。preflight 失敗時に pidfile を取らない方が clean。

### workspace 別の独立性

\`.team/daemon.pid\` は workspace-local（各プロジェクトの \`.team/\` 配下）なので、別 workspace の daemon は独立して動く。今回の T259 スコープではクロスワークスペースの排他は不要。


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-259-1776523064` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-259-1776523064
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-259-1776523064/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/259-daemon-pidfile/runs/task-259-1776523064
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/259-daemon-pidfile/runs/task-259-1776523064/summary.md` に書き出す。

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
