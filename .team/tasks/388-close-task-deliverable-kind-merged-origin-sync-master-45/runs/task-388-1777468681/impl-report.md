# T388 実装レポート

## Completed Tasks

1. **ja master.md にプロトコル本体と例外を追記**
   - §「やらないこと（基本方針）」git 書き込み禁止行に「Deliverable sync プロトコル」例外注記を追加
   - §「明示指示があっても禁止（厳守継続）」`git push` 行に同例外への参照注記を追加
   - §「`await-task` の使い分け」の「使ってよい場面」リストに `merged` deliverable の completion 捕捉用途を追加
   - §「`await-task` の使い分け」直後 / §「排他タスクの提案」直前に新セクション `## Deliverable sync プロトコル` を挿入（小見出し: deliverable_kind の見極め / merged タスクの sync フロー / sync 手順（closed (merged) のとき）/ 並行 merged の serialize（push 競合対策）/ rescue 委譲（sync 失敗時 / aborted 時））

2. **en master.md に同等内容を反映**
   - ja と一対一対応する 4 箇所の変更（"What NOT to Do" 例外 / "Still Prohibited" 注記 / "When to use `await-task`" 用途 / "## Deliverable sync protocol" セクション）
   - 既存語彙（"Still Prohibited" / "When to use `await-task`" / "Cases where this is appropriate"）と整合
   - `### ` 見出し数は ja/en 一致（diff 差分ゼロ）

3. **i18n.ts の `help_close_task` を両言語更新**
   - 英語版（L389–393 付近）の `merged` Examples ブロック先頭に 2 行 NOTE 追加
   - 日本語版（L1199–1203 付近）の `merged` Examples ブロック先頭に対応する 2 行 NOTE 追加
   - Notes 本体は触らず、バッククォート文字列内のエスケープも非破壊

4. **README.md / README.ja.md に Master responsibilities 段落を追加**
   - README.md: `### Communication` 表の直下、`## Project-Specific Agent Instructions` の前に `### Master responsibilities (origin sync)`（3 文程度）を新設
   - README.ja.md: `### 通信モデル` 表の直下、`### エージェントロール` の前に `### Master の責務（origin sync）`（同等内容）を新設
   - 両者ともテンプレート master.md の §「Deliverable sync プロトコル」 / §"Deliverable sync protocol" を参照先として明示

5. **summary.md にランタイムプロンプト再生成手順を明記** — `summary.md` で実施

6. **summary.md に `Closes #45` 指示を明記** — `summary.md` で実施

## Files Changed

| パス | 変更概要 |
|---|---|
| `skills/cmux-team/templates/ja/master.md` | (a) §やらないこと git 書き込み禁止行に Deliverable sync プロトコル例外を追記。(b) §明示指示があっても禁止 の `git push` 行に同例外への参照注記を追記。(c) §`await-task` の使い分け の「使ってよい場面」に 1 項目追加。(d) 新セクション `## Deliverable sync プロトコル` を §「`await-task` の使い分け」直後に追加。 |
| `skills/cmux-team/templates/en/master.md` | ja と 1:1 対応の英訳。同セクション・同箇条数。新セクション見出し `## Deliverable sync protocol`。 |
| `skills/cmux-team/manager/i18n.ts` | `help_close_task` 英語版 (L389–393 付近) と日本語版 (L1199–1203 付近) の `merged` Examples ブロック先頭に 2 行 NOTE 追加。Notes 本体は不変。 |
| `README.md` | `### Communication` 表直下に `### Master responsibilities (origin sync)` 段落（3 文）を新設。 |
| `README.ja.md` | `### 通信モデル` 表直下に `### Master の責務（origin sync）` 段落（3 文）を新設。 |

## Verification Results

```
$ grep -n "Deliverable sync プロトコル" skills/cmux-team/templates/ja/master.md
39:    実行してよい（§「Deliverable sync プロトコル」参照）。`push --force` / `reset --hard` 等の
68:  ※ §「Deliverable sync プロトコル」の例外を除く（merged deliverable closed 直後の
184:- **`merged` deliverable の completion を捕捉し、Master が origin sync (fetch / pull / push) を行うため**（§「Deliverable sync プロトコル」参照）
202:## Deliverable sync プロトコル

$ grep -n "Deliverable sync protocol" skills/cmux-team/templates/en/master.md
38:    (see §"Deliverable sync protocol"). Destructive ops such as `push --force` / `reset --hard`
66:  — Except for the §"Deliverable sync protocol" carve-out (only `git push origin <base>`
182:- **To capture completion of a `merged` deliverable so that Master can perform origin sync (fetch / pull / push)** (see §"Deliverable sync protocol")
201:## Deliverable sync protocol

$ grep -nE "git push origin <base>" skills/cmux-team/templates/ja/master.md skills/cmux-team/templates/en/master.md
skills/cmux-team/templates/en/master.md:37:    run `git fetch origin <base>` / `git pull --ff-only origin <base>` / `git push origin <base>`
skills/cmux-team/templates/en/master.md:66:  — Except for the §"Deliverable sync protocol" carve-out (only `git push origin <base>`
skills/cmux-team/templates/en/master.md:233:git push origin <base>   # the only `git push` that is allowed
skills/cmux-team/templates/ja/master.md:38:    `git fetch origin <base>` / `git pull --ff-only origin <base>` / `git push origin <base>` を
skills/cmux-team/templates/ja/master.md:69:    `git push origin <base>` のみ許容。`push --force` は引き続き全面禁止）
skills/cmux-team/templates/ja/master.md:232:git push origin <base>   # 共有ブランチへの push を限定的に許可

$ grep -nE "Master is expected to fetch|origin への fetch/pull/push は Master|await-task" skills/cmux-team/manager/i18n.ts | head -20
391:  # NOTE: After this exits, Master is expected to fetch/pull/push origin/<base>
392:  #       via the await-task flow (see master.md "Deliverable sync protocol").
631:cmux-team await-task -- wait for a task to complete (closed/aborted)
634:  cmux-team await-task --task-id <id> [options]
646:  cmux-team await-task --task-id 108
647:  cmux-team await-task --task-id 108,109 --timeout 7200
731:  cmux-team await-task --task-id <id> [--timeout <sec>]    wait for task completion
1203:  # 注: クローズ後の origin への fetch/pull/push は Master が
1204:  #     await-task フローで担当します（master.md「Deliverable sync プロトコル」参照）。
1443:cmux-team await-task -- タスクの完了（closed/aborted）を待機する
1446:  cmux-team await-task --task-id <id> [options]
1458:  cmux-team await-task --task-id 108
1459:  cmux-team await-task --task-id 108,109 --timeout 7200
1544:  cmux-team await-task --task-id <id> [--timeout <sec>]    タスク完了待ち

$ grep -nE "Master responsibilities|Master の責務" README.md README.ja.md
README.md:253:### Master responsibilities (origin sync)
README.ja.md:268:### Master の責務（origin sync）

$ bunx tsc --noEmit 2>&1 | grep -E "^skills/cmux-team/manager/i18n.ts" || echo "i18n.ts: tsc OK"
i18n.ts: tsc OK

# 追加（plan §4 サブタスク 1 / 2 の検証コマンド）
$ grep -nE "rescue: T\{id\} merged" skills/cmux-team/templates/ja/master.md
253:- title: `"rescue: T{id} merged 後の origin sync"`

$ grep -nE "rescue: origin sync after T\{id\} merged" skills/cmux-team/templates/en/master.md
256:- title: `"rescue: origin sync after T{id} merged"`

$ diff <(grep -c "^### " skills/cmux-team/templates/en/master.md) <(grep -c "^### " skills/cmux-team/templates/ja/master.md)
(empty diff — ja/en の `### ` 見出し数は一致)
```

## Issues Encountered

なし。文字列リテラル追記中心のためビルド・型エラーは発生せず、`bunx tsc --noEmit` も既存通り i18n.ts はクリーン。

設計レビュー指摘の minor 2 点（サブタスク 5 に grep 検証追加 / D6 二重記述）は計画書本体の校正領域であり、本実装の scope 外につき未対応（plan.md に記載のとおり任意対応）。
