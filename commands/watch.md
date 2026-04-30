---
allowed-tools: Bash, Read, Edit, Monitor
description: "events stream を監視して PR merge / conflict resolve / pull / escalation を自動処理する"
---

# /cmux-team:watch

`.team/logs/events.jsonl` を `cmux-team events --follow` で tail し、Master 自身が `task_completed` の自動 PR merge / conflict resolve / `git pull --ff-only` を実行し、判断が必要な escalation event を user に提示する opt-in な watch コマンドです。

## 設計方針 / 注意事項

- **opt-in**: user が能動的に `/cmux-team:watch` を invoke した時のみ動く。常駐させない
- **自動範囲**: `task_completed` に対する PR merge（squash + delete-branch）/ conflict resolve / main ブランチへの `git pull --ff-only` までを Master が自走する。それ以外の判断は escalate
- **state は外部に持たない**: 過去 event の遡及処理はしない。Master の context が `/clear` 等で消えた場合は、user に再 invoke してもらう
- **保守的に**: 迷ったら escalate。複雑な判断を自動化しない

## Pre-flight checks

Monitor を起動する **前に** 以下を順序通りに実行する。1 つでも fail したら error メッセージを user に提示して **Monitor は起動せずに終了する**。

### 1. daemon 稼働確認

```bash
if [ ! -f .team/daemon.pid ]; then
  echo "Error: cmux-team daemon が起動していません。先に \`cmux-team start\` を実行してください。"
  exit 1
fi

cmux-team status > /tmp/cmux-team-watch-status.txt 2>&1 || {
  echo "Error: cmux-team status が応答しません。daemon が異常停止している可能性があります。"
  cat /tmp/cmux-team-watch-status.txt
  exit 1
}
```

### 2. events.jsonl 存在確認

```bash
if [ ! -f .team/logs/events.jsonl ]; then
  echo "Error: .team/logs/events.jsonl が見つかりません。events writer が動作していない可能性があります。daemon を最新版で起動し直してください（cmux-team v4.22.0+ が必要）。"
  exit 1
fi
```

### 3. events サブコマンド存在確認

```bash
if ! cmux-team events --help > /dev/null 2>&1; then
  echo "Error: 'cmux-team events' サブコマンドが利用できません。cmux-team v4.22.0 以上が必要です。\`npm install -g @hummer98/cmux-team@latest\` で更新してください。"
  exit 1
fi
```

3 つすべて pass したら user に「pre-flight OK」を 1 行出して Monitor 起動に移る。

## Monitor 起動

### コマンド

```bash
cmux-team events --follow --types task_completed,task_completed_state_mismatch,task_aborted,task_sync_guard_rejected,task_reverted_to_ready,conductor_done_unresolved,conductor_disconnect_timeout,conductor_asking --format json
```

`--types` には介入要 8 event を完全一致で指定する（順序は任意、過不足なし）:

- `task_completed`
- `task_completed_state_mismatch`
- `task_aborted`
- `task_sync_guard_rejected`
- `task_reverted_to_ready`
- `conductor_done_unresolved`
- `conductor_disconnect_timeout`
- `conductor_asking`

`conductor_running` / `task_assigned` / `task_created` 等は除外する（noise 削減）。

### Monitor 呼び出しパラメータ

| param | value |
|---|---|
| `command` | 上記のコマンド全文 |
| `description` | `cmux-team events stream watching for task_completed / escalation events` |
| `persistent` | **`true`**（session 終了まで動き続ける） |

`persistent: true` で起動すると stdout の各行（= 1 event JSON）が Master への通知になる。Master は次節の protocol に従って各行を parse・処理する。

### 停止トリガー

- user が `/clear` を打つ → Master の context が破棄され Monitor も session 終了で停止
- user が「watch を止めて」「stop watching」と明示 → Master が `TaskStop` で Monitor を kill する
- それ以外（タスク完了、長時間 idle 等）では止めない

## Event 別処理 protocol

各 stdout 行を JSON parse し、`event` field で分岐する。`journal_summary` / `worktree_path` / `task_id` / `conductor_surface` 等の field を取り出して以下の通り処理する。

### `task_completed`（自動 PR merge / pull）

最も処理が複雑な event。以下をすべて実行する。

#### Step 1: PR の存在確認

```bash
WT="<worktree_path>"
cd "$WT"
PR_URL=$(gh pr view --json url -q .url 2>/dev/null || true)
```

- `$PR_URL` が空 → **Step 5（PR 無し分岐）へ**
- `$PR_URL` が取れた → **Step 2（PR merge 試行）へ**

#### Step 2: PR merge 試行（squash）

```bash
gh pr merge --squash --delete-branch "$PR_URL" 2>&1 | tee /tmp/cmux-team-watch-merge.txt
MERGE_EXIT=${PIPESTATUS[0]}
```

- `MERGE_EXIT == 0` → **Step 4（main pull）へ**
- `MERGE_EXIT != 0` で stderr に `conflict` / `not mergeable` を含む → **Step 3（conflict resolve）へ**
- それ以外の merge 失敗（review 不足、required check 未通過、permission 不足等） → user に `[escalation]` で「PR merge に失敗しました。手動で確認してください」と提示（PR_URL と stderr 末尾を一緒に出す）。続行はしない

#### Step 3: Conflict 検出時の resolve

```bash
cd "$WT"
git fetch origin
git merge origin/main 2>&1 | tee /tmp/cmux-team-watch-conflictmerge.txt
```

- `git status --short` で衝突ファイルを列挙
- **Edit ツールで衝突マーカーを解消**する（解消ロジックは task の内容に依存するため Master が判断）
- 解消できないと判断したら user に `[escalation]` で衝突ファイル一覧 + journal_summary を提示して中止
- 解消できたら以下を実行:

  ```bash
  git add -A
  git commit -m "Resolve conflicts with main for T<task_id>"
  git push
  gh pr merge --squash --delete-branch "$PR_URL"
  ```

  それでも fail した場合は user に `[escalation]` で投げる

#### Step 4: main checkout + pull --ff-only

```bash
MAIN_ROOT=$(git rev-parse --show-superproject-working-tree 2>/dev/null || git -C "$(dirname "$WT")/../../.." rev-parse --show-toplevel 2>/dev/null)
[ -z "$MAIN_ROOT" ] && MAIN_ROOT=$(pwd)

cd "$MAIN_ROOT"
git fetch origin
git pull --ff-only origin main 2>&1 | tee /tmp/cmux-team-watch-pull.txt
PULL_EXIT=${PIPESTATUS[0]}
```

- `PULL_EXIT == 0` → user に `[ok] T<id> を merge / pull 完了しました` と 1 行報告して継続
- `PULL_EXIT != 0`（ff-only 不可、local に未 push commit がある等） → user に `[escalation]` で「main の自動 pull に失敗しました。手動で `git pull` してください」と提示（stderr 末尾を一緒に出す）
- **`--ff-only` 以外の戦略は取らない**（user の local commit を破壊するリスクを避ける）

#### Step 5: PR 無し分岐

deliverable kind が `files` / `merged` / `none` 等で PR を出していない `task_completed` は自動 merge せず、log のみ:

```text
[log] task_completed (no PR) task_id=<T> worktree_path=<W>
```

を 1 行報告して継続（介入要請はしない）。

> 注: `gh pr merge` は GitHub remote が無い repo では fail する。`gh auth status` の事前 check は不要。fail したら escalate するだけで良い。

### `task_completed_state_mismatch`

Conductor が `close-task` を呼ばずに DONE を返した異常完了。**自動 merge は行わない**。

```text
[escalation] task_completed_state_mismatch
  task_id: T<NNN>
  conductor_surface: surface:N
  reason: <r>
  worktree_path: <絶対パス>
  journal_summary:
    <J を多行表示>
  → 手動で worktree を確認し、必要なら `cmux-team close-task --task-id T<NNN> --deliverable-kind ...` を実行してください。
```

### `task_aborted` (`reason == judgment_pending`)

`CONDUCTOR_DONE success=false unresolved=true` 経路。並行して `conductor_done_unresolved` も流れてくるが、両方を index して紐付けるのではなく **到着順にそれぞれ処理する**（forward-compat、reader は重複を許容）。

```text
[escalation] task_aborted (judgment_pending)
  task_id: T<NNN>
  journal_summary:
    <J>
  → judgment_pending は user 判断が必要。worktree を確認して指示してください。
```

### `task_aborted` (その他 reason)

`reason ∈ {disconnect_timeout, user_clear, assign_failed, resume_marked_aborted, other, ...}` および将来追加される値（forward-compat）は **log のみ** で escalate しない。**default branch もここに合流させる**。

```text
[log] task_aborted task_id=T<NNN> reason=<r>
```

### `task_sync_guard_rejected`

`update-task --status ready` / `create-task --status ready` の sync guard reject。user 介入が必須。

```text
[escalation] task_sync_guard_rejected
  task_id: T<NNN>
  kind: <k>  (diverged / uncommitted / detached / auto_pull_failed / 将来値)
  main_branch: <m>
  detail: <d>
  → main の sync 状態を整えてから再度 update-task --status ready してください。
    例: `git pull --ff-only origin <m>` / `git stash` / `git checkout <m>`
```

### `task_reverted_to_ready`

D1〜D4 / M1 / M3 救済経路で `assigned → ready` に巻き戻った。**Manager が再 assign するので Master は何もしない**。

```text
[log] task_reverted_to_ready task_id=T<NNN> reason=<r>
```

### `conductor_done_unresolved`

T269 judgment_pending の最強 signal。worktree は preserve されている。

```text
[escalation] conductor_done_unresolved
  task_id: T<NNN>
  conductor_surface: surface:N
  worktree_path: <絶対パス>  ← 現状確認はここで
  journal_summary:
    <J>
  → cd <絶対パス> で worktree を確認し、指示を出してください。
```

### `conductor_disconnect_timeout`

`DISCONNECT_TIMEOUT_SEC`（300s）超過 **直前** の警告。forced close まで猶予あり。

```text
[warn] conductor_disconnect_timeout
  conductor_surface: surface:N
  task_id: T<NNN>  (optional)
  elapsed_ms: <e>
  → このまま放置すると forced close されます（task_aborted reason=disconnect_timeout）。
    手動介入する場合は user 判断で。
```

### `conductor_asking`

AskUserQuestion を pass through する。

```text
[ask] conductor_surface=surface:N
  question:
    <Q>
  → 該当 surface に回答するか、Master 経由で指示してください。
```

## User 通知のフォーマット

### 出力先

すべて Master の通常出力（user に直接見える）。Discord / Slack / 通知システム連携は **行わない**。

### 表示原則

- **長い JSON はそのまま出さない**。Master が parse して必要 field のみ提示する
- **journal_summary は多行で OK** だが、500 文字を超える場合は末尾省略 + 「`cmux-team trace-task T<NNN>` で全文取得可能」と案内する
- **worktree_path は絶対パス** で出す（user が cd しやすいように）
- **task_id は `T<NNN>` 形式**（spec §6.1）。`task_id: T123` のように prefix 付きで表示
- **`conductor_surface` は `surface:N`** 形式（spec §6 注記）。`conductor-N` 等の別名は使わない

### メッセージ階級

| 階級 | 用途 | プレフィックス |
|---|---|---|
| info | 自動完了報告 | `[ok]` または絵文字なし1行 |
| log | escalate しないもの | `[log]` |
| warn | forced close 直前等 | `[warn]` |
| escalation | user 判断必須 | `[escalation]`（行頭マーカー）+ 詳細ブロック |
| ask | AskUserQuestion pass through | `[ask]` |

階級は **ブレずに使い分ける**。受信した event がどれに該当するかは前節 §「Event 別処理 protocol」の各サブセクションに明記してある。

## 終了するには

- 抜けるだけなら `/clear` を実行してください（Monitor も session 終了で自動停止します）。最も推奨される抜け方です
- watch を止めたいときは「stop watching」「watch やめて」など明示してください。Master が `TaskStop` で Monitor を kill して 1 行報告します
- session を抜ける（Claude Code を終了する）場合も Monitor は自動で停止します
- Master の context が消えた場合は再度 `/cmux-team:watch` を invoke してください（state はファイルに永続化していないので、過去 event を遡及処理することはありません）

## Forward-compat 動作

events spec §8 に従い、reader である本コマンドは以下のとおり振る舞う。

| 異常 | 動作 |
|---|---|
| `schema_version` が `2` 以外 | `cmux-team events` 側で skip + warn（events-cli 実装済み）。Master 側では何もしない |
| 未知 `event` | `cmux-team events` の `KNOWN_EVENTS` で skip + warn。本コマンドの `--types` filter で更に絞られる |
| 未知 `reason` / `kind` enum 値 | Master が exhaustive switch を **書かない**。default branch で `[log]` に流す（`task_aborted` の方針を `task_sync_guard_rejected.kind` 等にも適用） |
| 必須 field 欠損 | `cmux-team events` 側で skip + warn。Master は受信しない |
| JSON parse 失敗 | `cmux-team events` 側で skip + warn |
| stdout に warn が紛れる | warn は **stderr** に出るので Monitor の通知（stdout 行）には混入しない |

reader の責務は「自分が知っている event を正しく扱う」こと。「未知を遮断する」ことではない（spec §8）。
