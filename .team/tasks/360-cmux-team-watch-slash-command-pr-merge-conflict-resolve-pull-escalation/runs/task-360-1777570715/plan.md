# T360 実装計画 — `/cmux-team:watch` slash command 新設

> Implementer 向け。本ファイルが Implementer の唯一の指示書。
> 参照仕様: `docs/spec/10-events-stream.md`（v2 schema、§8 forward-compat）、`skills/cmux-team/manager/events-cli.ts`（CLI 引数仕様）。

---

## 1. 概要

### 目的

events stream (`.team/logs/events.jsonl`) を `cmux-team events --follow` で tail し、Master 自身が以下を自動処理する opt-in な slash command を新設する。

- **`task_completed`** → PR merge / conflict resolve / `git pull --ff-only` までを自動実行
- **`task_completed_state_mismatch` / `conductor_done_unresolved` / `conductor_asking` / `conductor_disconnect_timeout` / `task_aborted (judgment_pending)` / `task_sync_guard_rejected`** → user に escalate（journal_summary 提示）
- **`task_aborted (その他)` / `task_reverted_to_ready`** → log のみで継続

### 成果物

- 新規ファイル: `commands/watch.md`（1 個のみ）
- それ以外のファイル変更は **行わない**（Master template / CLAUDE.md / docs/spec / README は Phase 2 / 別 issue / 後続タスクの担当）

### Phase 1 設計方針（issue #42 確定済み）

- **opt-in**: user が能動的に `/cmux-team:watch` を invoke。常駐させない
- **Master template / CLAUDE.md には介入しない**（Phase 2 で別 issue 化）
- **自動化レベル (c)**: PR merge / conflict resolve / pull まで Master が自走
- **通知処理 protocol は command 本文に内包**: Master の context が消えたら user に再 invoke してもらう（state を外部に持たない）

---

## 2. ファイル構造

### 配置

`commands/watch.md`（plugin namespace により `/cmux-team:watch` として exposed される。`.claude-plugin/plugin.json` の `"commands": "./commands/"` 設定による）。

### YAML frontmatter

```yaml
---
allowed-tools: Bash, Read, Edit, Monitor
description: events stream を監視して PR merge / conflict resolve / pull / escalation を自動処理する
---
```

- `Bash`: pre-flight check、`gh pr merge`、`git push` / `git pull` / `git status` / `git checkout` 等
- `Read`: 必要に応じて task ファイルや artifact を参照
- `Edit`: conflict resolve 時に worktree 内のファイルを編集
- `Monitor`: events stream の persistent watch
- `Write` は **含めない**（本コマンドで新規ファイルを作る用途は無い）

### 本文セクション構成（順序固定）

1. `# /cmux-team:watch`（タイトル + 概要 1 段落）
2. `## 設計方針 / 注意事項`（opt-in、自動範囲、context 喪失時の挙動）
3. `## Pre-flight checks`（§3）
4. `## Monitor 起動`（§4）
5. `## Event 別処理 protocol`（§5、event ごとの subsection）
6. `## User 通知のフォーマット`（§6）
7. `## 終了処理`（§7）
8. `## Forward-compat 動作`（§8）

---

## 3. Pre-flight checks

Monitor を起動する **前に** 以下を順序通りに実行する。1 つでも fail したら error メッセージを user に提示して **Monitor は起動せずに終了する**。

### 3.1 daemon 稼働確認

```bash
if [ ! -f .team/daemon.pid ]; then
  echo "Error: cmux-team daemon が起動していません。先に \`cmux-team start\` を実行してください。"
  exit 1
fi

# pidfile はあるが応答しないケースを検出
cmux-team status > /tmp/cmux-team-watch-status.txt 2>&1 || {
  echo "Error: cmux-team status が応答しません。daemon が異常停止している可能性があります。"
  cat /tmp/cmux-team-watch-status.txt
  exit 1
}
```

### 3.2 events.jsonl 存在確認

```bash
if [ ! -f .team/logs/events.jsonl ]; then
  echo "Error: .team/logs/events.jsonl が見つかりません。events writer (T358) が動作していない可能性があります。daemon を最新版で起動し直してください（cmux-team v4.22.0+ が必要）。"
  exit 1
fi
```

### 3.3 events サブコマンド存在確認

`cmux-team events` は v4.22.0 以降にしか存在しない（T359）。古い CLI が graceful に exit する保証はないので、Monitor で起動する前に明示確認する。

```bash
if ! cmux-team events --help > /dev/null 2>&1; then
  echo "Error: 'cmux-team events' サブコマンドが利用できません。cmux-team v4.22.0 以上が必要です。\`npm install -g @hummer98/cmux-team@latest\` で更新してください。"
  exit 1
fi
```

> Implementer 注意: `--help` は exit code 0 を返す（events-cli.ts L487-491）。`--help` が unknown flag として弾かれる古い実装ではこの check が fail するので、その挙動を期待値とする。

### 3.4 すべて pass したら次に進む

「pre-flight OK」を 1 行 user に出して Monitor 起動に移る。

---

## 4. Monitor 起動仕様

### 4.1 コマンド全文

```bash
cmux-team events --follow --types task_completed,task_completed_state_mismatch,task_aborted,task_sync_guard_rejected,task_reverted_to_ready,conductor_done_unresolved,conductor_disconnect_timeout,conductor_asking --format json
```

- `--follow`: stream tail（events-cli.ts の follow loop、200ms poll、rotate 対応）
- `--types`: 介入要 8 event のみに絞る（noise 削減）。conductor_running / task_assigned / task_created 等は除外
- `--format json`: 機械可読の JSONL を Master が parse する。各行は `{"ts":..., "event":..., "schema_version":2, ...}` 形式

### 4.2 Monitor 呼び出しパラメータ

| param | value |
|---|---|
| `command` | 上記 §4.1 のコマンド全文 |
| `description` | `cmux-team events stream watching for task_completed / escalation events` |
| `persistent` | `true` |
| `timeout_ms` | 不要（persistent: true なので runtime 側で無視される。設定する場合は最大値） |

> persistent: true で session 終了まで動き続ける。stdout の各行（= 1 event JSON）が Master への通知となり、Master が §5 の protocol に従って処理する。

### 4.3 Monitor の停止トリガー

- user が `/clear` を打つ → Master の context が破棄され Monitor も session 終了で停止
- user が「watch を止めて」「stop」と明示 → Master が `TaskStop` で Monitor を kill
- user 以外のトリガーでは停止しない（=タスク完了で勝手に止まらない、長時間 idle でも止まらない）

---

## 5. Event 別処理 protocol

各 event を受信したら **command 本文に書かれた手順** に従う。**手順は本セクションをそのまま command 本文に転記すること**（user の context が消えたら参照できないため、command 本文に内包する設計）。

JSON は `journal_summary` / `worktree_path` / `task_id` / `conductor_surface` 等の field を `jq` または Master の解析で取り出す。

### 5.1 `task_completed`（自動 PR merge / pull）

最も処理が複雑な event。以下の分岐を **すべて command 本文に明示** する。

#### 受信したら

```text
task_completed task_id=<T> conductor_surface=<S> worktree_path=<W> journal_summary=<J>
```

#### 処理手順

**Step 1: PR の存在確認**

```bash
# worktree_path を $WT に展開
cd "$WT"
PR_URL=$(gh pr view --json url -q .url 2>/dev/null || true)
```

- `$PR_URL` が空 → **PR 無し分岐へ**（Step 5）
- `$PR_URL` が取れた → **PR merge 分岐へ**（Step 2）

**Step 2: PR merge 試行（squash）**

```bash
gh pr merge --squash --delete-branch "$PR_URL" 2>&1 | tee /tmp/cmux-team-watch-merge.txt
MERGE_EXIT=${PIPESTATUS[0]}
```

- `MERGE_EXIT == 0` → **Step 4（main pull）へ**
- `MERGE_EXIT != 0` で stderr に "conflict" / "not mergeable" が含まれる → **Step 3（conflict resolve）へ**
- それ以外の merge 失敗（review 不足、required check 未通過、permission 不足等） → user に「PR merge に失敗しました」「自動処理できないので手動で確認してください」と escalate（PR_URL と stderr 末尾を提示）。続行はしない

**Step 3: Conflict 検出時の resolve**

```bash
cd "$WT"
# main を取り込んで conflict を起こす
git fetch origin
git merge origin/main 2>&1 | tee /tmp/cmux-team-watch-conflictmerge.txt
```

- conflict が検出された場合、`git status --short` で衝突ファイルを列挙
- **Edit ツールで衝突マーカーを解消**（実際のロジックは task の内容に依存するため、Master が判断して編集）
- 解消できないと判断した場合は user に escalate（衝突ファイル一覧と journal_summary 提示）して中止
- 解消できたら:
  ```bash
  git add -A
  git commit -m "Resolve conflicts with main for T<task_id>"
  git push
  # 再度 merge を試す
  gh pr merge --squash --delete-branch "$PR_URL"
  ```
- それでも fail なら user に escalate

**Step 4: main checkout + pull --ff-only**

```bash
# 現在の repo root（worktree ではなく main checkout がある場所）を取得
MAIN_ROOT=$(git rev-parse --show-superproject-working-tree 2>/dev/null || git -C "$(dirname "$WT")/../../.." rev-parse --show-toplevel 2>/dev/null)
# fallback: cmux-team start 時の project root
[ -z "$MAIN_ROOT" ] && MAIN_ROOT=$(pwd)

cd "$MAIN_ROOT"
git fetch origin
git pull --ff-only origin main 2>&1 | tee /tmp/cmux-team-watch-pull.txt
PULL_EXIT=${PIPESTATUS[0]}
```

- `PULL_EXIT == 0` → user に「T<id> を merge / pull 完了しました」と 1 行報告して終了
- `PULL_EXIT != 0`（ff-only 不可、local に未 push commit がある等） → user に「main の自動 pull に失敗しました。手動で `git pull` してください」と escalate（stderr 末尾を提示）

**Step 5: PR 無し分岐**

PR を出していない `task_completed`（deliverable kind が `files` / `merged` / `none` のケース）は自動 merge せず、log のみ:

```text
task_completed (no PR) — task_id=<T> worktree_path=<W>
```

を user に 1 行報告して継続（介入要請はしない）。

> Implementer 注意: `gh pr merge` は GitHub remote が無い repo では fail する。`gh auth status` の事前 check は **不要**（fail したら escalate するだけで良い）。

### 5.2 `task_completed_state_mismatch`

T274 auto-close の異常完了（Conductor が `close-task` を呼ばずに DONE を返した）。**自動 merge は行わない**。

```text
[escalation] task_completed_state_mismatch
  task_id: <T>
  conductor_surface: <S>
  reason: <r>
  worktree_path: <W>
  journal_summary:
    <J を多行表示>
  → 手動で worktree を確認し、必要なら `cmux-team close-task --task-id <T> --deliverable-kind ...` を実行してください。
```

### 5.3 `task_aborted` (`reason == judgment_pending`)

`CONDUCTOR_DONE success=false unresolved=true`（T269 経路）。並行して `conductor_done_unresolved` も流れてくる（§5.7）が、両方を index して同じ task_id を関連付けるのではなく、**到着順にそれぞれ処理する**（forward-compat、reader は重複を許容）。

```text
[escalation] task_aborted (judgment_pending)
  task_id: <T>
  journal_summary:
    <J>
  → judgment_pending は user 判断が必要。worktree を確認して指示してください。
```

### 5.4 `task_aborted` (その他 reason)

`reason ∈ {disconnect_timeout, user_clear, assign_failed, resume_marked_aborted, other, ...}` および将来追加される値（forward-compat）は **log のみ** で escalate しない:

```text
[log] task_aborted task_id=<T> reason=<r>
```

> 注意: `reason` enum の default branch はここに合流させること。spec §8 に従い未知 reason も skip ではなく log。

### 5.5 `task_sync_guard_rejected`

`update-task --status ready` / `create-task --status ready` の sync guard reject。user 介入が必須。

```text
[escalation] task_sync_guard_rejected
  task_id: <T>
  kind: <k>  (diverged / uncommitted / detached / auto_pull_failed / 将来値)
  main_branch: <m>
  detail: <d>
  → main の sync 状態を整えてから再度 update-task --status ready してください。
    例: `git pull --ff-only origin <m>` / `git stash` / `git checkout <m>`
```

### 5.6 `task_reverted_to_ready`

D1〜D4 / M1 / M3 救済経路で `assigned → ready` に巻き戻った。**Manager が再 assign するので Master は何もしない**。

```text
[log] task_reverted_to_ready task_id=<T> reason=<r>
```

### 5.7 `conductor_done_unresolved`

T269 judgment_pending の最強 signal。worktree は preserve されている。

```text
[escalation] conductor_done_unresolved
  task_id: <T>
  conductor_surface: <S>
  worktree_path: <W>  ← 現状確認はここで
  journal_summary:
    <J>
  → cd <W> で worktree を確認し、指示を出してください。
```

### 5.8 `conductor_disconnect_timeout`

`DISCONNECT_TIMEOUT_SEC`（300s）超過 **直前** の警告。forced close まで猶予あり:

```text
[warn] conductor_disconnect_timeout
  conductor_surface: <S>
  task_id: <T>  (optional)
  elapsed_ms: <e>
  → このまま放置すると forced close されます（task_aborted reason=disconnect_timeout）。
    手動介入する場合は user 判断で。
```

### 5.9 `conductor_asking`

AskUserQuestion を pass through:

```text
[ask] conductor_surface=<S>
  question:
    <Q>
  → 該当 surface に回答するか、Master 経由で指示してください。
```

### 5.10 (forward-compat) 未知 event

§4.1 で `--types` を指定しているので、events-cli が writer 側に追加された未知 type は **そもそも届かない**。届いた場合（filter 後でも来た場合）は §8 に従い warn のみで継続。

---

## 6. User 通知のフォーマット

### 6.1 出力先

すべて Master の通常出力（user に直接見える）。Discord / Slack / 通知システム連携は **Phase 1 では行わない**。

### 6.2 表示原則

- **長い JSON はそのまま出さない**。Master が parse して必要 field のみ提示する
- **journal_summary は多行で OK** だが、500 文字を超える場合は末尾省略 + 「`cmux-team trace-task <T>` で全文取得可能」と案内
- **worktree_path は絶対パス** を出す（user が cd しやすいように）
- **task_id は `T<NNN>` 形式**（spec §6.1）。`task_id: T123` のように prefix 付きで表示
- **`conductor_surface` は `surface:N`** 形式（spec §6 注記）。`conductor-N` 等の別名は使わない

### 6.3 メッセージ階級

| 階級 | 用途 | プレフィックス |
|---|---|---|
| info | 自動完了報告 | `[ok]` または絵文字なし1行 |
| log | escalate しないもの | `[log]` |
| warn | forced close 直前等 | `[warn]` |
| escalation | user 判断必須 | `[escalation]`（行頭マーカー）+ 詳細ブロック |
| ask | AskUserQuestion pass through | `[ask]` |

> 階級は **command 本文に明記し、Master がブレずに使い分けられるようにする**。

---

## 7. 終了処理

### 7.1 標準的な抜け方

- **`/clear`**: Master の context が破棄されると Monitor は session で動いているため自動停止。最も推奨される抜け方
- **session 終了**: Claude Code を抜ける → Monitor も停止
- **明示停止**: user が「watch やめて」「stop watching」と指示 → Master が `TaskStop` で Monitor を kill して 1 行報告

### 7.2 command 本文に書く明文化

```text
## 終了するには

- 抜けるだけなら `/clear` を実行してください（Monitor も停止します）。
- watch を止めたいときは「stop watching」「watch やめて」など明示してください。
- Master の context が消えた場合は再度 `/cmux-team:watch` を invoke してください
  （state はファイルに永続化していないので、過去の event を遡及処理することはありません）。
```

### 7.3 abort safety

Master が context 喪失して Monitor が session で残ってしまった場合に備えた cleanup は **不要**（Monitor は session 終了で必ず終わる、persistent: true は session を超えない）。

---

## 8. Forward-compat 動作（spec §8 準拠）

events spec §8 に従い、reader である本コマンドは以下のとおり振る舞う。**Implementer はこれを command 本文の最後の節に明記すること**。

| 異常 | 動作 |
|---|---|
| `schema_version` が `2` 以外 | `cmux-team events` 側で skip + warn（events-cli.ts L289 で実装済み）。Master 側では何もしない |
| 未知 `event` | `cmux-team events` の `KNOWN_EVENTS` で skip + warn。本コマンドの `--types` filter で更に絞られる |
| 未知 `reason` / `kind` enum 値 | Master が exhaustive switch を **書かない**。default branch で `[log]` に流す（§5.4 の方針を `task_sync_guard_rejected.kind` 等にも適用） |
| 必須 field 欠損 | `cmux-team events` 側で skip + warn。Master は受信しない |
| JSON parse 失敗 | `cmux-team events` 側で skip + warn |
| stdout に warn が紛れる | warn は **stderr** に出るので Monitor の通知（stdout 行）には混入しない（events-cli.ts の warn は `ctx.stderr.write`） |

> reader の責務は「自分が知っている event を正しく扱う」こと。「未知を遮断する」ことではない（spec §8）。

---

## 9. テスト / 検証方針

### 9.1 自動テスト

- **本コマンドはテスト不要**。slash command は `.md` ファイルの static 検証のみ（YAML frontmatter parse / Markdown 構文）。Implementer は `bun test` 等を走らせる必要 **なし**
- 既存の test suite に対して回帰の心配はない（新規ファイル 1 個追加のみ、既存コードへの touch なし）

### 9.2 手動検証（Implementer 完了時に user / Inspector が行う）

1. **frontmatter parse**: `head -5 commands/watch.md` で YAML frontmatter が valid であること
2. **slash command 認識**: Claude Code 起動後 `/` を打って `cmux-team:watch` が一覧に出ること（`/cmux-team:help` でも一覧に出ることを確認）
3. **Pre-flight 動作**: `.team/daemon.pid` を一時的に削除した状態で invoke → §3.1 の error が出て中断されること
4. **events.jsonl 不存在動作**: `.team/logs/events.jsonl` を一時退避して invoke → §3.2 の error
5. **正常起動**: 全 pre-flight pass で Monitor が起動し、stdout 行が来たら Master が反応すること
6. **`/clear` で停止**: clear 後に再起動した Master からは Monitor が見えないこと

### 9.3 Inspector が読む観点

- frontmatter の `allowed-tools` が §2 通り（`Bash, Read, Edit, Monitor`、`Write` を含まない）
- `--types` の event 名 8 種が **spec §5 と一致**（typo / 余分な event がないこと）
- §5.1 の `task_completed` 分岐が **PR 有無 / conflict 有無 / ff-only 失敗** すべてカバーされていること
- §5.4 / §5.6 が「log のみ」であることが明示されている（escalate と log の境界が明確）
- §8 の forward-compat 節が含まれている
- §7 の終了処理が明文化されている

---

## 10. 完了条件 (Definition of Done)

Implementer が以下をすべて満たしたら完了。Inspector はこの箇条書きを GO/NO-GO 判定に使う。

- [ ] `commands/watch.md` が新規作成されている（既存ファイル変更は **無い**）
- [ ] frontmatter が `allowed-tools: Bash, Read, Edit, Monitor` および `description` を含む（§2）
- [ ] Pre-flight checks が §3.1 / §3.2 / §3.3 の 3 項目すべて含む
- [ ] Monitor 起動コマンドの `--types` が以下 8 種 **完全一致**（順序は任意、過不足なし）:
  `task_completed`, `task_completed_state_mismatch`, `task_aborted`, `task_sync_guard_rejected`, `task_reverted_to_ready`, `conductor_done_unresolved`, `conductor_disconnect_timeout`, `conductor_asking`
- [ ] Monitor 起動が `persistent: true` 指定であることが本文に明記
- [ ] §5.1〜§5.9 の 9 event について処理 protocol が **command 本文に転記** されている（plan.md を参照させない）
- [ ] §5.1 の `task_completed` 処理が PR 有無 / conflict 検出 / ff-only 失敗 の 3 分岐すべて記載
- [ ] §6 の通知フォーマット（階級・絶対パス・task_id 形式）が本文に明示
- [ ] §7 の終了処理（`/clear` 推奨、明示停止指示、再 invoke 案内）が本文に明示
- [ ] §8 の forward-compat 節（`schema_version` / 未知 event / 未知 reason / JSON parse 失敗）が本文に明示
- [ ] Master template / CLAUDE.md / docs/spec / README に変更が **無い**（Phase 2 / 別 issue / 後続タスクの担当範囲を侵食していない）
- [ ] テストの追加・実行は **不要**（slash command static のみ）

### 補足 — Implementer が迷ったら

- §5.1 の自動 PR merge ロジックは **保守的に**（迷ったら escalate）。本コマンドの目的は「user が手を動かさなくて済む routine 作業の自動化」であり、「複雑な判断を自動化する」ことではない
- conflict resolve できない衝突を強引に解こうとしない。escalate して user に投げる
- main pull で divergent な状態を検出したら **`--ff-only` 以外の戦略を取らない**（user の local commit を破壊するリスク回避）
- 文言は日本語で書く（既存 commands/*.md と統一）
