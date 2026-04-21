# T268 実装計画: Conductor Step 8/9 フォールバックに並列追加 conflict の自動解消を追加（改訂版 v2）

> **改訂履歴:** Design Review (Changes Requested) を反映。
> 主な変更: §2.1(a) の `git update-ref` アプローチ撤回（Finding 1 — linked worktree から main branch ref を書換えると PROJECT_ROOT の index/作業ツリーが silent rollback する実証済み bug）、rebase ループ化（Finding 2）、§D1 再決定（D1-B' 採択）、`/dev/stdin` 誤記訂正（Finding 4）、Subtask 7 を E2E テストへ吸収（Finding 6）、`--worktree` 必須化（Finding 8）、reason 集合整理（Finding 9）。

## 1. 課題分析

### 1.1 現状の問題点

T266 で Conductor が `daemon.test.ts` 1 ブロックの conflict を理由に `CONDUCTOR_DONE --success=false` を送って `assigned` のまま放置した。実際の conflict は **T263 側の新規 describe と T266 側の新規 describe を並列追加しただけ** で、重なる行がゼロの pure additive conflict。現行の Step 8/9 フォールバックは以下 4 つの設計欠陥を抱えている。

1. **Step 8 と Step 9 で基準ブランチが非対称**
   - Step 8: `git rebase origin/{{MAIN_BRANCH}}` — `origin/main` 基準
   - Step 9 local merge: `git merge --ff-only <branch>` from `{{PROJECT_ROOT}}` — `local main` 基準
   - 並列タスク A が local main に先行 merge すると、タスク B は Step 8 成功（`origin/main` は未進行）→ Step 9 で `local main` が A の commit を含む分だけ branch より先行 → ff-only 不可で失敗する。
2. **Step 9 の失敗時フォールバックが未定義**
   - template には Step 8 の `git rebase --abort` パスしか書かれておらず、Step 9 で ff-only に失敗した Conductor は独自判断で Step 8 のパスを流用するか完全停止するしかない。
3. **`--success false` に reason が付かない**
   - `daemon.ts:2752-2760` は `reason=${opts?.reason ?? "-"}` と既に整っているが、template には `--reason <id>` の例が一切無い。結果として `conductor_done_unresolved reason=-` になり、`manager.log` から失敗原因を事後追跡できない。
4. **conflict の粒度判定が粗すぎる**
   - 「3-way merge が失敗 = 人間判断」の 1 ビットしか無い。「重なる行ゼロの並列追加」（semantic には無害）を毎回人間判断に escalate するため、運用コストが高い。

### 1.2 根本原因

- 現行 template は「main 側で conflict が surface することを防ぎ、納品時に常に fast-forward できる状態にする」（Step 8 冒頭コメント）を謳いながら、Step 9 の納品先を統一していない。rebase 基準と merge 基準の乖離が放置されている。
- auto-resolve の設計がそもそも存在せず、conflict 検出 → abort → 人間判断以外の経路が無い。
- `conductor-role.md` に reason 識別子の候補集合が未定義で、Conductor が reason 文字列を自発的に付与できない。

### 1.3 影響範囲

| 層 | 影響 |
|----|------|
| Conductor template (`skills/cmux-team/templates/{ja,en}/conductor-role.md`) | Step 8/9 の手順再設計（rebase ループ化 + PROJECT_ROOT 上での ff）|
| Manager CLI (`skills/cmux-team/manager/main.ts`) | 新サブコマンド `cmux-team try-auto-resolve-conflict` |
| Manager logic (新規 `skills/cmux-team/manager/auto-resolve-conflict.ts`) | 自動解消ロジック本体 |
| Manager test (`skills/cmux-team/manager/daemon.test.ts`, 新規 `auto-resolve-conflict.test.ts`) | reason propagation 確認 + 自動解消単体テスト + E2E rebase fixture |
| daemon (`daemon.ts` `handleConductorDone`) | **コード変更なし**（reason propagation は T263 で実装済み、動作確認のテスト追加のみ） |
| 外部プロジェクト（Dear 等） | template 書換え後は `cmux-team start` 再実行で取り込み可能。破壊的変更なし |

## 2. 技術アプローチ

### 2.1 選択したアプローチ

**(a) Step 8 の rebase 基準は `origin/{{MAIN_BRANCH}}` のまま据え置き、Step 9 納品時に PROJECT_ROOT 上で `git pull --ff-only origin {{MAIN_BRANCH}} && git merge --ff-only <branch>` を一気に実行して基準を PROJECT_ROOT 側で統一する（D1-B' 採択）。**

> **Design Review Finding 1 対応:** 前版は linked worktree から `git update-ref refs/heads/{{MAIN_BRANCH}}` で local main を ff するアプローチを採っていたが、modern git は linked worktree からの main ref 書換えを拒否せず、**PROJECT_ROOT の HEAD だけが先行し index/作業ツリーが取り残される silent rollback bug** を引き起こすことが実証された（再現手順は design-review.md §Finding 1）。このため `update-ref` 経路は完全撤回し、PROJECT_ROOT の main worktree 上で直接 `checkout` / `pull --ff-only` / `merge --ff-only` する方式に切り替える。

手順（Step 8）:
```bash
cd <WORKTREE_PATH>
git fetch --quiet origin {{MAIN_BRANCH}}
git rebase origin/{{MAIN_BRANCH}}   # 失敗時は (b) の auto-resolve ループへ
```

手順（Step 9 local merge ブランチ — B を選んだ場合のみ）:
```bash
cd {{PROJECT_ROOT}}

# 事前検査: main worktree が {{MAIN_BRANCH}} 上で clean でなければ escalate
CUR=$(git rev-parse --abbrev-ref HEAD)
if [ "$CUR" != "{{MAIN_BRANCH}}" ] || ! git diff --quiet || ! git diff --cached --quiet; then
  cmux-team send CONDUCTOR_DONE --surface "$CMUX_SURFACE" --success false \
    --reason main_worktree_dirty
  exit 0
fi

# 他タスクが先に push していれば取り込む
if ! git pull --ff-only origin {{MAIN_BRANCH}}; then
  cmux-team send CONDUCTOR_DONE --surface "$CMUX_SURFACE" --success false \
    --reason main_pull_failed
  exit 0
fi

# 1 回目の ff merge
if ! git merge --ff-only <branch>; then
  # race 救済: worktree へ戻って local main に rebase → 再度 ff merge
  cd <WORKTREE_PATH>
  git rebase {{MAIN_BRANCH}}   # local main は上で pull 済みで最新
  cd {{PROJECT_ROOT}}
  if ! git merge --ff-only <branch>; then
    cmux-team send CONDUCTOR_DONE --surface "$CMUX_SURFACE" --success false \
      --reason merge_ff_failed
    exit 0
  fi
fi
```

この順序により:
- `git update-ref` を一切使わず、main worktree の整合性を破壊しない
- race は `pull --ff-only` が検出し、保守側に倒す（`main_pull_failed`）
- main worktree が dirty / 別ブランチなら人間判断に委ねる（`main_worktree_dirty`）
- Step 9 race（Step 8 完了 〜 Step 9 merge 間の割り込み）は 1 回 rebase リトライで救い、それでも失敗なら `merge_ff_failed` で escalate

**(b) Step 8 rebase 失敗時は `cmux-team try-auto-resolve-conflict` を介した while ループで複数 commit 連続 conflict に対応する（Finding 2 対応）。**

Conductor が書く bash:

```bash
cd <WORKTREE_PATH>
git fetch --quiet origin {{MAIN_BRANCH}}
if git rebase origin/{{MAIN_BRANCH}}; then
  :   # rebase 完了
else
  # auto-resolve ループ（最大 10 回）
  loop=0
  while :; do
    loop=$((loop + 1))
    if [ "$loop" -gt 10 ]; then
      git rebase --abort
      cmux-team send CONDUCTOR_DONE --surface "$CMUX_SURFACE" --success false \
        --reason rebase_auto_resolve_loop_exceeded
      exit 0
    fi
    if ! cmux-team try-auto-resolve-conflict --worktree "$PWD" --json; then
      git rebase --abort
      cmux-team send CONDUCTOR_DONE --surface "$CMUX_SURFACE" --success false \
        --reason merge_conflict_semantic
      exit 0
    fi
    if git rebase --continue; then
      break   # rebase 完走
    fi
    # 再度 conflict → 次ループで auto-resolve
  done
fi
```

**(c) auto-resolve 成功後のテスト実行は D4 に従う（§D4 参照）。**

**(d) `--success false` 送信時は必ず `--reason <id>` を付与する（§D5 に確定集合）。**

### 2.2 代替案と却下理由

#### D1（Step 8/9 基準統一）の選択肢

Design Review Finding 1 により、前版の update-ref 案は実行不能。以下を再比較する。

| 代替案 | 判定 | 理由 |
|--------|------|------|
| **D1-A'**: Step 9 local merge を全廃し、納品は必ず `origin/{{MAIN_BRANCH}}` への PR push + `ff-only` 前提 | 却下 | 現行 CLAUDE.md「小変更はローカル merge がデフォルト」を破壊し T268 スコープ外。個人プロジェクト用途の UX を大幅変更する |
| **D1-B'**: Step 8 は `origin/main` 基準のまま、Step 9 で PROJECT_ROOT 上の main worktree を使って `checkout` → `pull --ff-only` → `merge --ff-only` を原子的に実行 | **採用** | update-ref を経由しないため Finding 1 回避。既存 Step 9 の local merge 部分に `pull --ff-only` と事前 clean 検査を足すだけで済む。main worktree が dirty なら escalate（保守側倒し）。 |
| D1-C': `cmux-team integrate-branch` 新サブコマンド + `.team/integrate.lock` 排他ロック | 却下 | 実装ボリュームが D1-B' の 3〜5 倍。ロックファイル管理の増分保守コスト高。まず D1-B' で効果検証してから必要になれば D1-C' に進化させる（将来タスク）。 |
| D1 (旧): linked worktree から `git update-ref refs/heads/{{MAIN_BRANCH}}` | **撤回** | Finding 1 で実証済みの silent rollback bug。PROJECT_ROOT の index/作業ツリーを破壊する |

#### その他の代替

| 代替案 | 却下理由 |
|--------|----------|
| B-alt1: template 内に bash の conflict-marker parser を直接書く（D2 の Option A） | diff3 marker 依存 + shell の堅牢性が低い + Conductor の LLM ごとにコードが微妙に揺れる。保守不能 |
| C-alt1: `diff3 -m` / `git merge-file` に丸投げ（D3 の Option A 相当） | git rebase は既に merge-file を内部利用しているが T266 で conflict を出した。merge-file の挙動は「base が空でも両側の挿入位置が競合するとマーカーを出す」ため、追加解消ロジックが必要 — そのロジックを外に書く以上、自前の marker parser と労力は同じ |
| C-alt2: ML / LLM で semantic 判定 | オーバーキル。cmux-team の原則「決定論的なものはコードで、判断が必要なものは AI で」に照らすと、conflict 判定は決定論の側 |

### 2.3 pure additive conflict 判定ロジック（D3 の採択案）

実装は `skills/cmux-team/manager/auto-resolve-conflict.ts` に `tryAutoResolveConflict(worktreePath, opts)` として配置。アルゴリズムは以下。

```
1. `git diff --name-only --diff-filter=U` で conflict ファイル一覧を取得
2. 各ファイルについて:
   a. `git ls-files -u -- <file>` で stage 1/2/3 の blob SHA とモードを取得
      - stage 1 = BASE（共通祖先）
      - stage 2 = OURS
      - stage 3 = THEIRS
      - いずれかが欠落（= ファイル add/delete 衝突） → semantic conflict として reject
      - mode の差（`100644 vs 100755` 等）あり → semantic conflict として reject
      - mode `160000`（submodule）/ `120000`（symlink）なら reject
      - rename 衝突（stage 2/3 でパスが異なる）→ reject
      - バイナリ（`git show :1:<file>` の先頭 8KB が NUL を含む） → reject
   b. `git show :1:<file>` / `:2:<file>` / `:3:<file>` の内容を 3 つの tmpfile
      （`os.tmpdir()` + `crypto.randomUUID()`）に書き出す
   c. `git merge-file --diff3 -p <ours-tmp> <base-tmp> <theirs-tmp>` を呼び、
      diff3 形式の merged 出力（stdout）を得る
      # ※ git merge-file はファイルパス引数のみ受ける。stdin 経由は不可。
      # ※ 呼び出し側は try / finally で tmpfile を unlink する
   d. 出力を `<<<<<<<` / `|||||||` / `=======` / `>>>>>>>` の 4 マーカーで segment 分割
   e. 各 conflict hunk について:
      - BASE segment が空（改行のみ含む空白も許容するオプション）
      - 他全ての hunk も BASE 空 →「pure additive」と判定
      - 1 つでも BASE 非空 → reject（semantic conflict）
   f. pure additive と判定された場合、merged 出力 = 各 hunk を「OURS 内容 + THEIRS 内容」で置換
      （順序はタスクの時系列 = OURS を先に置く。受け入れ条件上は順不問）
3. 全 conflict ファイルが pure additive なら:
   a. merged 内容を worktree の各ファイルに書き込む
   b. `git add <file>` で stage に戻す
   c. exit 0（成功）
4. 1 つでも semantic conflict があれば:
   a. worktree には触らず終了（呼び出し側が `git rebase --abort` を担当）
   b. exit 10（reject）+ stderr に rejected ファイルと理由を出力
5. 予期しないエラー（ls-files 出力不正、tmpfile I/O 失敗 等）:
   a. exit 2（internal error）+ stderr にエラー内容
```

**例外扱い:**
- rename 衝突: `ls-files -u` のパス列を全 stage で一致確認、異なれば reject
- submodule conflict: mode `160000` で reject
- symbolic link: mode `120000` で reject
- バイナリ conflict: blob 先頭 8KB の NUL 検索で reject
- 巨大ファイル（10 MB 超）: reject（将来ストリーム処理化）

### 2.4 実装形態（D2 の採択案）

**独立 TypeScript モジュール + `cmux-team` サブコマンド** に切り出す。

- モジュール: `skills/cmux-team/manager/auto-resolve-conflict.ts`
  - `export async function tryAutoResolveConflict(worktreePath: string): Promise<Result>` を提供
  - CLI バイナリ `cmux-team try-auto-resolve-conflict` から呼ぶ
  - 単体テスト `auto-resolve-conflict.test.ts` で実 git リポジトリを作って検証（`daemon.test.ts` の `setupRealGitWithWorktree` と同じパターン）
- サブコマンド: `skills/cmux-team/manager/main.ts` に追加
  - 引数: **`--worktree <path>` を必須**（Design Review Finding 8 対応 — `$(pwd)` デフォルトは誤爆リスク高）、`--json`（出力形式）
  - 必須欠落時は exit 2（internal_error）+ stderr に usage
  - `--worktree` が main worktree（`.git` が dir で、かつ同一 path が `git worktree list` の先頭）の場合は exit 2（防御策）
  - exit code: 0=resolved, 10=semantic_reject, 2=internal_error
  - JSON 出力で resolved ファイル一覧と rejected ファイル一覧を返す（Conductor が reason 選択に使う）

template 側からは §2.1 (b) の while ループで呼び出す。`--worktree "$PWD"` を明示指定する。

### 2.5 既存パターンとの整合性

- `cmux-team` サブコマンド追加: 既存の `spawn-agent` / `close-agent` / `send-agent` / `await-agent` 等と同じ流儀で `main.ts` の switch に 1 分岐追加。`i18n.ts` の help テキストにも追記。
- 実 git worktree を使う test: `daemon.test.ts` の T263 ケースで確立されたパターン（`setupRealGitWithWorktree`）を流用。test helper を `auto-resolve-conflict.test.ts` にコピーするか、新規 `test-helpers/git.ts` を作るかは Implementer 判断（最小は inline コピー）。
- `exec-error.ts` の `formatExecError` を流用して `git` コマンド失敗のログを統一形式に揃える。

## 3. 変更対象

### 3.1 新規作成

| パス | 内容 |
|------|------|
| `skills/cmux-team/manager/auto-resolve-conflict.ts` | pure additive conflict 判定 + 書き戻しロジック（約 200 行） |
| `skills/cmux-team/manager/auto-resolve-conflict.test.ts` | 実 git リポジトリを作って additive / semantic / rename / binary / **rebase E2E（3 commit 連続 pure additive）** の 5 ケース以上を検証（約 400 行） |

### 3.2 変更

| パス | 変更概要 |
|------|----------|
| `skills/cmux-team/templates/ja/conductor-role.md` | Step 8 auto-resolve **ループ**追加 / Step 9 を PROJECT_ROOT 上の `checkout` + `pull --ff-only` + `merge --ff-only` に書き換え / main worktree dirty 検査追加 / `--success false` にすべて `--reason <id>` 明示 |
| `skills/cmux-team/templates/en/conductor-role.md` | 同上（英語版） |
| `skills/cmux-team/manager/main.ts` | `try-auto-resolve-conflict` サブコマンドを switch に追加（`--worktree` **必須** + 引数パース + `tryAutoResolveConflict()` 呼び出し + JSON 出力 + exit code） |
| `skills/cmux-team/manager/i18n.ts` | help テキスト（ja/en 両方）に `try-auto-resolve-conflict` を追記。`--worktree` 必須である旨を注記 |
| `skills/cmux-team/manager/daemon.test.ts` | reason 識別子の新集合（例: `merge_conflict_semantic`）での propagation を確認するテストを 1 ケース追加（T268 describe として独立） |

### 3.3 削除

なし。

### 3.4 触らないもの（明示）

- `skills/cmux-team/manager/daemon.ts` `handleConductorDone` — T263 で既に `opts.reason` を素通しする実装済み（`daemon.ts:1320` `reason: message.reason`、Case #9 `rebase_conflict` / Case #10 `missing_state` / Case #6 `late_false` で propagation 確認済み）
- `skills/cmux-team/manager/schema.ts` — `CONDUCTOR_DONE` スキーマは既に `reason: z.string().optional()` を受けている
- `skills/cmux-team/manager/conductor.ts` — `resetConductor` の `preserveWorktree` は既に T263 実装済み
- `CLAUDE.md` — Step 8 フォールバックに関する記述は現在存在しない（`rg "Step 8|ff-only|rebase" CLAUDE.md` で 0 ヒット）。必要になった場合のみ更新（Implementer 判断）

## 4. サブタスク分割

Design Review Finding 6 により、前版 Subtask 7（手動 verify.sh）は廃止し `auto-resolve-conflict.test.ts` の E2E ケースに吸収した。Subtask 番号は 1-6 の 6 本。

### Subtask 1: `auto-resolve-conflict.ts` 本体の実装

- **対象ファイル**: `skills/cmux-team/manager/auto-resolve-conflict.ts`
- **完了条件**:
  - `export async function tryAutoResolveConflict(worktreePath: string): Promise<{ resolved: string[]; rejected: Array<{ file: string; reason: string }>; status: "resolved" | "semantic_reject" | "internal_error" }>` を export
  - §2.3 のアルゴリズムに従い、stage 1/2/3 blob 取得 → **3 tmpfile 書き出し → `git merge-file --diff3 -p <ours> <base> <theirs>`** → BASE 空判定 → 書き戻し → `git add`
  - tmpfile は `os.tmpdir()` + `crypto.randomUUID()`、`try { ... } finally { await unlink(p).catch(() => {}) }` でリーク防止
  - 例外は全て `log("error", ...)` 経由で記録（CLAUDE.md「空の catch 禁止」原則）
- **検証コマンド**: `cd skills/cmux-team/manager && bunx tsc --noEmit auto-resolve-conflict.ts`

### Subtask 2: `auto-resolve-conflict.test.ts` の作成

- **対象ファイル**: `skills/cmux-team/manager/auto-resolve-conflict.test.ts`
- **完了条件**: 以下 7 ケースを含む（Finding 6 で E2E 吸収分 +1、Finding 2 で連続 rebase 分 +1）
  1. **pure additive（単一ファイル）** — T266 相当の「末尾に両側が独立 describe を追加」→ `status=resolved`、staged にマージ結果が入る
  2. **semantic conflict** — 同じ行の異なる修正 → `status=semantic_reject`、worktree 未変更
  3. **add/delete** — OURS は追加、THEIRS は削除 → `semantic_reject`
  4. **binary conflict** — 両側 PNG 差分 → `semantic_reject`
  5. **複数ファイル混在** — additive + semantic が同時 → `semantic_reject`（1 つでも semantic があれば全体 reject）
  6. **no conflict state** — clean worktree で呼んでも `status=resolved`（resolved は空配列）で exit 0
  7. **【新規・Finding 6/2 吸収】rebase E2E: 3 commit 連続 pure additive** — fixture で 3 commit 分の pure additive conflict を作り、`git rebase origin/main` → `tryAutoResolveConflict` → `git rebase --continue` を 3 回繰り返して完走することを検証。rebase 後の `git log --oneline` が期待通りになることも確認
- **検証コマンド**: `cd skills/cmux-team/manager && bun test auto-resolve-conflict.test.ts`

### Subtask 3: `try-auto-resolve-conflict` サブコマンドの追加

- **対象ファイル**: `skills/cmux-team/manager/main.ts`, `skills/cmux-team/manager/i18n.ts`
- **完了条件**:
  - `cmux-team try-auto-resolve-conflict --worktree <path> [--json]` が動作
  - **`--worktree` 必須**（欠落時は exit 2 + usage を stderr へ — Finding 8 対応）
  - 指定 path が main worktree の場合は exit 2（防御策）
  - `Result.status` に応じて exit code を 0 / 10 / 2 に分岐
  - `--json` 指定時は JSON、未指定時は人間可読のサマリーを stdout に出力
  - `help_try_auto_resolve_conflict` を `i18n.ts` に ja/en 両方追加（`--worktree` 必須である旨を明記）
  - `main.ts` の global help usage に 1 行追記
- **検証コマンド**: `cd skills/cmux-team/manager && bun run main.ts try-auto-resolve-conflict --help`

### Subtask 4: `conductor-role.md (ja)` の Step 8/9 更新

- **対象ファイル**: `skills/cmux-team/templates/ja/conductor-role.md`
- **完了条件**:
  - Step 8 の rebase 基準は `origin/{{MAIN_BRANCH}}` に据え置き（§2.1 (a) の Step 8 部分）
  - Step 8 rebase 失敗時に **while ループで auto-resolve → `--continue` を繰り返す**（§2.1 (b)、最大 10 回、超過時は `rebase_auto_resolve_loop_exceeded`）
  - auto-resolve 成功後: `bun test` → pass なら Step 9 へ / fail なら `git reset --hard ORIG_HEAD` + `test_failed_after_auto_resolve` で escalate / タイムアウト時は `test_timeout_after_auto_resolve` + `CMUX_TEAM_SKIP_POST_AUTO_RESOLVE_TEST=1` で skip できる分岐（Finding 5）
  - Step 9 local merge を **PROJECT_ROOT 上の操作** に書き換え（§2.1 (a) の Step 9 部分）:
    - (1) `CUR=$(git rev-parse --abbrev-ref HEAD)` で main worktree が `{{MAIN_BRANCH}}` 上か確認
    - (2) `git diff --quiet` + `git diff --cached --quiet` で dirty 検査
    - (3) いずれか失敗で `main_worktree_dirty` escalate
    - (4) `git pull --ff-only origin {{MAIN_BRANCH}}` 失敗で `main_pull_failed` escalate
    - (5) `git merge --ff-only <branch>` 失敗 → worktree に戻って `git rebase {{MAIN_BRANCH}}` → 再度 `merge --ff-only` → なお失敗なら `merge_ff_failed` escalate
  - `CONDUCTOR_DONE --success false` 送信箇所すべてに `--reason <id>` を明示
  - §D5 全 identifier（新集合 8 つ）が template 中に最低 1 回以上現れる
  - `{{MAIN_BRANCH}}` / `{{PROJECT_ROOT}}` の curly brace 展開ルールは従来通り維持
- **検証コマンド**（Finding 7 対応で強化）:
  ```bash
  # 1. --reason の総出現数が D5 の identifier 数（8）以上
  count=$(grep -c -- "--reason " skills/cmux-team/templates/ja/conductor-role.md)
  [ "$count" -ge 8 ] || { echo "FAIL: --reason count $count < 8"; exit 1; }
  # 2. 全 identifier が最低 1 回現れる
  for id in merge_conflict_semantic rebase_auto_resolve_loop_exceeded \
            test_failed_after_auto_resolve test_timeout_after_auto_resolve \
            merge_ff_failed main_worktree_dirty main_pull_failed rebase_aborted; do
    grep -q -- "--reason $id" skills/cmux-team/templates/ja/conductor-role.md \
      || { echo "MISS $id"; exit 1; }
  done
  ```

### Subtask 5: `conductor-role.md (en)` の Step 8/9 更新

- **対象ファイル**: `skills/cmux-team/templates/en/conductor-role.md`
- **完了条件**: Subtask 4 と 1:1 で対応する英語版更新
- **検証コマンド**: Subtask 4 と同一の for ループを ja → en に置換して実行 + `diff -u` で ja 版との構造一致確認

### Subtask 6: `daemon.test.ts` に reason 識別子集合の propagation テストを追加

- **対象ファイル**: `skills/cmux-team/manager/daemon.test.ts`
- **完了条件**:
  - `describe("T268: reason propagation for new reason set")` を新規 block として追加（T263 block の後、独立配置）
  - 新集合（§D5 の 8 identifier）の **代表 1 つ**（例: `rebase_auto_resolve_loop_exceeded`）を使って、`CONDUCTOR_DONE --success false --reason <id>` が `conductor_done_unresolved reason=<id>` に正確に反映されることを 1 ケース追加
  - 既存 Case #6/#9/#10 と重複しないことを確認（reason 文字列が新集合のもの）
- **検証コマンド**: `cd skills/cmux-team/manager && bun test daemon.test.ts -t "T268"`

## 5. リスク

### 5.1 既存機能への影響

| リスク | 対策 |
|--------|------|
| Step 9 の `git checkout` → `pull --ff-only` → `merge --ff-only` が main worktree の作業状態を壊す | 事前に `HEAD` ブランチ名 + `diff --quiet` + `diff --cached --quiet` の 3 点で clean 検査。いずれか失敗で `main_worktree_dirty` escalate（保守側倒し） |
| 複数 Conductor が同時に PROJECT_ROOT で checkout 競合 | `git checkout` / `merge --ff-only` は自動 serialize されないが、`merge --ff-only` の race は 2 回目の `merge --ff-only` で検出され `merge_ff_failed` で escalate。完全な排他は D1-C'（将来タスク）で対応 |
| auto-resolve の書き戻しで改行コードが変わる | worktree 内ファイルから直接読み書きするため、git 側の autocrlf 設定は尊重される。実装では Buffer バイナリ保持で扱い、文字列変換時は明示的に UTF-8 を指定（非 UTF-8 ファイルは binary 判定で reject） |
| 別プロジェクト（Dear 等）の template が古いまま | npm 版の `cmux-team` は template を自プロジェクトから読むのではなく install されたものを使う（`template.ts:findTemplateDir` の fromSelf フォールバック）。`cmux-team start` 再実行で反映 |
| `--worktree` 必須化で旧 template との互換性喪失 | 旧 template は存在せず（新機能）、破壊的変更は発生しない |

### 5.2 エッジケース

| ケース | 扱い |
|--------|------|
| 3-way conflict marker（diff3）の欠如 | 実装では `git merge-file --diff3 -p` を明示的に呼ぶため user の `merge.conflictStyle` 設定に依存しない |
| rename 衝突（stage 2/3 で path 違い） | `git ls-files -u` のパス列を全 stage で一致確認、異なれば reject |
| バイナリ conflict | blob の先頭 8KB を NUL 検索し、含まれていれば binary 判定で reject |
| submodule conflict（mode 160000） | mode 比較で reject |
| symbolic link conflict（mode 120000） | 同上 |
| conflict ファイル 0 件で呼ばれた | `resolved=[]` `status=resolved` で exit 0（no-op として許容） |
| 巨大ファイル（数十 MB） | MVP では 10 MB 上限を設けて超過時は reject、将来ストリーム処理化（別タスク） |
| worktree が git repo 外 / main worktree を指定 | Subtask 3 の防御で exit 2（internal_error） |
| rebase 中の複数 commit 連続 conflict | §2.1 (b) の while ループで各 stop に auto-resolve を適用、上限 10 超で `rebase_auto_resolve_loop_exceeded` escalate |
| auto-resolve 成功 → `bun test` fail | `git reset --hard ORIG_HEAD` で rebase 前に戻し、`test_failed_after_auto_resolve` で escalate。worktree は `preserveWorktree=true` で温存される |
| auto-resolve 成功 → `bun test` が極端に遅い（>5 分想定） | Implementer が `scripts.test` を事前確認。`CMUX_TEAM_SKIP_POST_AUTO_RESOLVE_TEST=1` で skip 可能。タイムアウト到達時は `test_timeout_after_auto_resolve` で escalate |
| PROJECT_ROOT の main worktree が別ブランチ / dirty | `main_worktree_dirty` で escalate（人間判断） |
| 他 Conductor が先行 push → `pull --ff-only` 失敗 | `main_pull_failed` で escalate（main ブランチに divergent な変更があるケース。人間判断） |
| Step 9 merge race（ff-only 1 回目失敗） | worktree に戻って `rebase {{MAIN_BRANCH}}` → 2 回目の `merge --ff-only`。2 回目も失敗なら `merge_ff_failed` |

### 5.3 テスト戦略

- **単体**: `auto-resolve-conflict.test.ts` で §2.3 の全判定パスを実 git リポジトリで網羅（Subtask 2 Case 1-6）
- **E2E（統合）**: `auto-resolve-conflict.test.ts` Case 7 に rebase → try-auto-resolve → `--continue` を 3 commit 分連続で実行するシナリオを追加（Finding 6 の verify.sh 吸収 + Finding 2 の複数 commit ループ検証）
- **結合**: `daemon.test.ts` に reason propagation の新ケース追加（Subtask 6）
- **回帰**: 既存 T263 テスト（Case #1/#6/#9/#10）を `bun test daemon.test.ts` で全 pass 維持
- **手動検証**: 廃止（Finding 6 対応で E2E テストへ吸収）

## 6. 既存型エラーの先読み

`bunx tsc --noEmit` を `skills/cmux-team/manager/` で実行した結果:

```
conductor.ts(197,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3650,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
```

### 6.1 本タスクのスコープで解消するエラー

なし。どちらも T268 の scope 外。新規作成する `auto-resolve-conflict.ts` / `auto-resolve-conflict.test.ts` は strict に pass させる（新規ファイルで既存エラーを増やさない）。

### 6.2 後続タスク（cleanup）に分離するエラー

| 場所 | 内容 | 扱い |
|------|------|------|
| `conductor.ts:197` | `initializeConductorSlots` の optional `layout: LayoutMode = "wide"` の後に required `mainBranch: string` が置かれている（TS1016） | T213/T253 起点の既存バグ。T268 で触る関数ではないため分離。別タスクで `mainBranch?: string` + ランタイム検証 or 全引数順の整理 |
| `daemon.test.ts:3650` | `source: "new_session"` は schema の union（`"startup" \| "resume" \| "clear" \| "compact"`）に無い | T260 系の broken conductor session テストで使われている値。schema 拡張 or テスト側の値修正が必要。別タスクで schema と同期する |

## 7. Decision Log

### D1: Step 8/9 の基準統一 — **採用: D1-B'（Step 8 は `origin/main` のまま、Step 9 で PROJECT_ROOT 上の ff を原子的実行）**

> **改訂:** 初版 D1（`git update-ref` で local main を ff）は Design Review Finding 1 で **撤回**。linked worktree からの main branch ref 書換えは modern git でも拒否されず、PROJECT_ROOT の index/作業ツリーを silent rollback する bug が実証された。

- **候補**:
  - D1-A': Step 9 local merge 廃止 + origin push のみで納品
  - **D1-B': PROJECT_ROOT 上で `checkout {{MAIN_BRANCH}}` → `pull --ff-only` → `merge --ff-only` を原子的実行（採用）**
  - D1-C': `cmux-team integrate-branch` + `.team/integrate.lock` で排他
  - D1（旧）: 撤回
- **採用理由**: D1-B' は update-ref を一切使わず Finding 1 を回避する最小変更案。main worktree が dirty / 別ブランチなら事前検査で escalate するため「保守側に倒す」CLAUDE.md 原則に合致。D1-A' は local merge を前提にした現行 UX の大幅変更でスコープ外、D1-C' は排他ロックの実装・運用コストが高く過剰（まず D1-B' で効果検証）
- **副次効果**: `git pull --ff-only` で他タスクの先行 push を自動取り込みできる。Step 8 〜 Step 9 間の race は worktree での 1 回 rebase リトライで救済
- **トレードオフ**: `git checkout` が失敗する条件（PROJECT_ROOT dirty / 他ブランチ）では人間介入が必要だが、それは受け入れる（保守側倒し）

### D2: conflict 自動解消の実装形態 — 採用: 独立 TS モジュール + `cmux-team` サブコマンド

- **候補**:
  - D2-A: template 内インライン bash（conflict marker parse を Conductor の heredoc で書く）
  - **D2-B: `skills/cmux-team/manager/auto-resolve-conflict.ts` + `cmux-team try-auto-resolve-conflict` サブコマンド（採用）**
  - D2-C: 独立スクリプト `skills/cmux-team/manager/try-auto-resolve-conflict.ts`（`bunx bun run` で直接呼ぶ）
- **採用理由**: D2-A は bash での marker parse が堅牢性を欠き、LLM 書き起こしで揺れる。D2-C は path 解決（installed package vs dev repo）で分岐が必要になる。D2-B は既存の `spawn-agent` / `close-agent` と同じパターンに乗り、`main.ts` の CLI switch に 1 分岐追加するだけで済む。単体テスト `auto-resolve-conflict.test.ts` で TS で書けるため回帰を防げる
- **CLAUDE.md との整合**: 「決定論的なものはコードで」原則に一致

### D3: 自動解消の判定アルゴリズム — 採用: stage 1/2/3 blob + `git merge-file --diff3 -p <ours-tmp> <base-tmp> <theirs-tmp>` で marker parse

> **Finding 4 対応:** 初版 §2.3 step 2.c は `/dev/stdin /dev/stdin /dev/stdin` と誤記していたが、`git merge-file` はファイルパス引数のみ受ける（stdin 非対応）。tmpfile ベースの記述に統一済み。

- **候補**:
  - D3-A: template 内インラインで conflict marker を parse（`merge.conflictStyle=diff3` 前提）
  - **D3-B + D3-C（採用）**: `git show :1/:2/:3:<file>` で blob を 3 tmpfile に書き出し、`git merge-file --diff3 -p <ours> <base> <theirs>` で diff3 形式出力を得て、BASE 空判定
- **採用理由**: D3-A は user の `merge.conflictStyle` 設定に依存し、設定が無いと base section が取れず判定不可能。D3-B/C の組み合わせなら設定非依存で safety。C で git 純正の merge アルゴリズムに乗ることで、rename 検出や whitespace 扱いを git に委ねられる
- **BASE 空判定の具体**: diff3 output の `<<<<<<<` 〜 `|||||||` = OURS、`|||||||` 〜 `=======` = BASE、`=======` 〜 `>>>>>>>` = THEIRS。BASE が空行のみならば pure additive

### D4: 自動解消後のテスト実行コマンド — 採用: `bun test` 全体実行 + 環境変数で skip できる逃げ道（Finding 5 対応）

- **候補**:
  - **D4-A + timeout/skip（採用）**: 全体 `bun test`（または `scripts.test`）実行、5 分タイムアウトで `test_timeout_after_auto_resolve` escalate、`CMUX_TEAM_SKIP_POST_AUTO_RESOLVE_TEST=1` で skip 可能
  - D4-B: 変更ファイルに関連するテストのみ
  - D4-C: テスト skip（auto-resolve を信頼）
- **採用理由**: D4-C は誤 resolve のリスクが顕在化したとき main へ伝播する。D4-B はテスト名推定の複雑さが auto-resolve の 10 倍になる。D4-A は遅いが、auto-resolve は Step 8 の失敗時のみ走る例外パスで、日常 hot path ではないため遅延許容。試験が fail なら `git reset --hard ORIG_HEAD` + `reason=test_failed_after_auto_resolve` で escalate
- **Finding 5 対応**: テスト実行が 5 分超の project（Dear 等で E2E 含む場合）に備え、timeout 到達で `test_timeout_after_auto_resolve` escalate 分岐を追加。`CMUX_TEAM_SKIP_POST_AUTO_RESOLVE_TEST=1` を env で渡せば skip できるバイパスも提供（Implementer / Inspector が project の `scripts.test` 所要時間を事前確認して判断）
- **project ごとの差異**: template では `package.json` の `scripts.test` があればそれを優先、なければ `bun test`。どちらも無ければ警告ログを出して skip

### D5: reason 識別子の命名規則 — snake_case、`<phase>_<kind>[_<modifier>]` 形式

**確定集合（新集合 — Step 8/9 Conductor 側で template から発火）:**

| identifier | 発火条件 | 初版からの差分 |
|-----------|---------|---------------|
| `merge_conflict_semantic` | auto-resolve が reject（BASE 非空 / rename / binary / mode 差等） | 変更なし |
| `rebase_auto_resolve_loop_exceeded` | auto-resolve ループが上限（10 回）を超過 | **新規（Finding 2）** |
| `test_failed_after_auto_resolve` | auto-resolve 成功 → テスト実行で fail | 変更なし |
| `test_timeout_after_auto_resolve` | auto-resolve 成功後のテスト実行が 5 分タイムアウト超過 | **新規（Finding 5）** |
| `rebase_aborted` | 予期しない rebase 失敗（conflict 以外、例: 権限 / I/O） | 変更なし |
| `merge_ff_failed` | Step 9 local merge の 2 回目リトライも失敗 | 変更なし |
| `main_worktree_dirty` | Step 9 で PROJECT_ROOT が {{MAIN_BRANCH}} 上に無い or dirty | **新規（Finding 1 → R1）** |
| `main_pull_failed` | Step 9 で `git pull --ff-only origin {{MAIN_BRANCH}}` が失敗（divergent） | **新規（Finding 1 → R1）** |

初版 4 identifier → 改訂版 **8 identifier**。

**既存 reason（T263 由来）との関係（Finding 9 対応）:**

| 既存 reason | 現在の用途 | 改訂方針 |
|------------|-----------|---------|
| `rebase_conflict` | `daemon.test.ts` Case #9 test fixture のみ（template 未使用） | **template からは新集合の `merge_conflict_semantic` を使う。`rebase_conflict` は deprecated として内部 test 用に残し、次期タスクで削除予定コメントを付与** |
| `late_false` | `daemon.test.ts` Case #6 test fixture のみ（daemon 内部状態遷移用の内部 reason） | **温存**（template 発火対象外。daemon 内部用として保持） |
| `missing_state` | `daemon.test.ts` Case #10 test fixture のみ（daemon 内部状態遷移用の内部 reason） | **温存**（同上） |

新集合 8 identifier は **template 発火専用**。daemon 側は reason を素通しするだけなので破壊的変更なし。

**命名原則:**
- snake_case
- 1 語目は失敗フェーズ（`merge` / `rebase` / `test` / `main`）
- 2 語目は失敗種別（`conflict` / `failed` / `aborted` / `worktree`）
- 3 語目以降は修飾（`semantic` / `auto_resolve_loop_exceeded` / `after_auto_resolve` / `ff_failed` / `dirty` / `pull_failed`）

---

## 付録: 実装時の注意メモ（Implementer 向け）

- `auto-resolve-conflict.ts` の `execFile` は `promisify(child_process.execFile)` ではなく `Bun.spawn` でもどちらでも可。既存の `cmux.ts` は `promisify(execFile)` を使っているので統一して `import { execFile as ef } from "child_process"; import { promisify } from "util"; const execFile = promisify(ef);` に揃える。
- tmpfile は `os.tmpdir()` + `crypto.randomUUID()` で。clean-up は `try { ... } finally { await unlink(path).catch(() => {}) }` の idiom。**3 ファイル分すべて finally で unlink**。
- `git merge-file --diff3 -p <ours> <base> <theirs>` の引数順序に注意（ours / base / theirs）。exit code は非 0 でも出力は有効（conflict が残っている正常ケース）。ENOENT / 権限エラー時のみ throw。
- conductor-role.md の bash サンプルは `{{MAIN_BRANCH}}` が curly brace 展開されることを忘れない。shell 変数展開を抑止したい場合は quoted heredoc（`'EOF'`）を使う — 既存 Agent spawn サンプル（`templates/ja/conductor-role.md:123`）と同じパターン。
- Step 9 の `cd {{PROJECT_ROOT}}` 後の `git checkout {{MAIN_BRANCH}}` は **既に {{MAIN_BRANCH}} 上ならば no-op**（`rev-parse --abbrev-ref HEAD` で事前判定しているため不要）。ただし checkout を省く場合でも `git diff --quiet` / `git diff --cached --quiet` の 2 点検査は必ず行う。
- while ループの上限 10 は `rebase_auto_resolve_loop_exceeded` 発火基準。過剰に大きくしない（無限ループ防止）。
- `daemon.test.ts` の T268 ケースは `describe("T268: reason propagation for new reason set")` を追加する形で。既存 T263 `describe` の後に独立 block として配置することで、将来 T263 と T268 の区別が付きやすい。
- cmux-team が複数プロジェクトで動く前提なので、`try-auto-resolve-conflict` サブコマンドはプロジェクトルート非依存（`--worktree` で worktree path を必須受け取り）に実装する。daemon への依存なし（直接 exec + 自己完結）。
- 「`--worktree` が main worktree を指しているか」の判定は `git rev-parse --git-common-dir` と `git rev-parse --git-dir` の比較、もしくは `git worktree list --porcelain` を parse して最初の `worktree <path>` を比較する方法が確実。
