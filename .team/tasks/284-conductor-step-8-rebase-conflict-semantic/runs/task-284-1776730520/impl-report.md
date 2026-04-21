# Implementation Report: T284 — Conductor Step 8 rebase conflict の semantic 自動解決

実装者: Implementer Agent（task-284-1776730520）
作業ブランチ: task-284-1776730520/task
作業ディレクトリ: `/Users/yamamoto/git/cmux-team/.worktrees/task-284-1776730520`

plan.md §8 の ST-1 〜 ST-7 を順番に実装完了。並列実装は行わず、template / docs / コードの相互参照整合性を保った。

---

## 1. 変更ファイル一覧

| # | ファイル | 変更概要 |
|---|---------|---------|
| 1 | `skills/cmux-team/manager/conductor.ts` | ST-1: worktree 作成直後に `git config --worktree rerere.enabled true` → 失敗時 `--local` フォールバック（best-effort、`rerere_enabled` / `rerere_enable_failed` ログ）を追加 |
| 2 | `skills/cmux-team/templates/ja/conductor-role.md` | ST-2: Step 8 を semantic resolution フロー（PRE_REBASE / ALL_CONFLICT_FILES / scope_violation 検知 / rollback 分岐 / conflict-resolution.md 出力）に書き換え |
| 3 | `skills/cmux-team/templates/en/conductor-role.md` | ST-3: ST-2 と 1-to-1 対応の英訳（7 キーワードすべて ja と同出現数） |
| 4 | `docs/spec/04-templates.md` | ST-4: conductor-role.md 節末尾に Step 8 要約追加 + `conflict-resolution.md` フォーマット節新設 |
| 5 | `CLAUDE.md` | ST-5: エラーリカバリ節に「Step 8 rebase conflict の semantic 自解決（T284）」節を追加、CONDUCTOR_DONE 遷移表に T284 脚注、ロギングポリシーに `rerere_enabled` / `rerere_enable_failed` 追記 |
| 6 | `CHANGELOG.md` | ST-6: `## [Unreleased] ### Changed (Breaking)` に T284 エントリ追加（Rollout 時の注意含む） |

### 意図的に変更しなかったファイル

- `skills/cmux-team/templates/{ja,en}/conductor-task.md`（Step 8 の記述は conductor-role.md 側にしかないため）
- `skills/cmux-team/templates/{ja,en}/conductor.md`（deprecated）
- `skills/cmux-team/manager/daemon.ts` / `task.ts`（T269 の state 遷移は T284 でも不変で継承、escalation 経路を共有）

---

## 2. 申し送り 3 点の処理結果

review-v2.md で Implementer に引き渡された 3 点の運用判断:

### 1. ALLOWED 集合の確定 → **案 B 採用**

ST-2 §8-4 の scope_violation 構造的検知で、ALLOWED は以下の式で算出する形で conductor-role.md に焼き付けた（ja/en 共通）:

```bash
CHERRY_PICK_CHANGES=$(git diff --name-only "$PRE_REBASE"..ORIG_HEAD | sort -u)
ALLOWED=$(printf '%s\n%s\n' "$ALL_CONFLICT_FILES" "$CHERRY_PICK_CHANGES" | sort -u | sed '/^$/d')
CHANGED=$(git diff --name-only "$PRE_REBASE"..HEAD | sort -u)
EXTRA=$(comm -23 <(printf '%s\n' "$CHANGED") <(printf '%s\n' "$ALLOWED"))
```

`ALL_CONFLICT_FILES` は Step 8 冒頭で空文字列に初期化し、8-1 iteration loop 内で `CUR_CONFLICTS=$(git diff --name-only --diff-filter=U | sort -u)` を積み上げる設計。これで cherry-pick 元 commit が touched だが conflict にはならなかったファイルも ALLOWED 側に入り、EXTRA 誤検知（review-v2.md §追加で発見された問題 #1）を回避。

### 2. iteration 内 scope 制約の文言強化 → **独立段落 + bold + 警告アイコン**

ST-2 / ST-3 の §8-3 で以下の独立段落を追加した（ja 側原文）:

> ⚠️ **iteration 内で conflict marker が出ていないファイルを編集してはいけない。**
>
> `git diff --name-only --diff-filter=U` の現在の結果に含まれないファイルへの Edit / Write は、たとえ「ついでに直しておきたい」誘惑に駆られても禁止。これは `failure_mode=scope_violation` として 8-4 で検知・escalation される。新規ファイルの作成、既存機能のリファクタリング、generated file の再生成はいずれも本ステップのスコープ外。

en 側も 1-to-1 対応の英訳を入れ、キーワード一致チェック（`scope_violation` ja=9 en=9）で整合を確認済み。

### 3. Decision Log #6 の追記 → **任意のため本実装では見送り**

plan.md 本文（ST-1 §122-131）が `--worktree` 優先・失敗時 `--local` フォールバックの運用を詳細に書いており、ST-1 の実装自体もそれに準拠している。Decision Log は設計判断の記録で、ST-1 本文が最新情報を持っていれば Implementer の参照上の齟齬は生じない。review-v2.md も「本指摘は Approved 判定を覆すものではない」「ST-1 本文が最新情報を持っているため運用には支障しない」と明示。plan.md は成果物ではなく本タスクの設計記録のためここでは書き換えない。

---

## 3. 検証結果

### 3-1. TypeScript 型検査

```
$ bunx tsc --noEmit
conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3720,9): error TS2322: Type '"new_session"' is not assignable to ...
daemon.ts(1538,22): error TS2352: Conversion of type 'string | undefined' to type ...
```

**既存エラー 3 件のみ（plan.md §6 で明示されていた T279 / T283 時点から残る既知エラー）。新規エラー 0 件**。T284 のスコープ外のため本タスクでは触れない。

### 3-2. テスト実行

```
$ cd skills/cmux-team/manager && bun test
 844 pass
 0 fail
 2014 expect() calls
Ran 844 tests across 28 files. [36.92s]
```

**全テスト pass。既存 regression なし**。

conductor.test.ts 単独でも 32 pass（実装中に一度確認、最終 run で全体に統合）。

### 3-3. template キーワード一致（ja/en）

ST-3 検証コマンドを走らせた結果:

```
OK: conflict-resolution.md ja=2 en=2
OK: failure_mode ja=15 en=15
OK: ITERATION_LIMIT ja=2 en=2
OK: git rebase --abort ja=1 en=1
OK: git reset --hard ja=1 en=1
OK: PRE_REBASE ja=6 en=6
OK: scope_violation ja=9 en=9
--- Total mismatches: 0 ---
```

7 キーワードすべて ja/en で出現数一致。

### 3-4. マークダウン間の言及整合

```
$ grep -rl "conflict-resolution.md" skills/cmux-team/templates/ docs/spec/ CLAUDE.md CHANGELOG.md
skills/cmux-team/templates/ja/conductor-role.md
skills/cmux-team/templates/en/conductor-role.md
docs/spec/04-templates.md
CLAUDE.md
CHANGELOG.md
```

5 ファイルすべてで `conflict-resolution.md` の言及あり。

### 3-5. ST-5 / ST-6 sanity check

- CLAUDE.md の T284 言及: 4 箇所（エラーリカバリ節 1 + CONDUCTOR_DONE 脚注 1 + ロギングポリシー 1 + 他 1）
- CLAUDE.md §ロギングポリシー節に `rerere_enabled`: 1 箇所
- CLAUDE.md §CONDUCTOR_DONE 遷移節に T284 言及: 1 箇所
- CLAUDE.md の `| \`false\` |` 表行数: 2（増減なし、脚注方式を徹底）
- CHANGELOG.md `## [Unreleased]` 内の T284 エントリ: 1 件
- CHANGELOG.md `## [Unreleased]` 内の「Rollout 時の注意」: 1 件

---

## 4. トラブル事項

**なし**。以下は実装上のメモ:

- ST-1: conductor.ts の rerere 追加位置は `worktreeCreated = true;` の直後（既存 `rev-parse HEAD` の前）。既存 best-effort パターン（`rev-parse HEAD`）と同じ catch + log 構造でネストブロックを作り、失敗しても throw しない。
- ST-2 / ST-3: Step 8 セクションの書き換えは 8-1 の `PRE_REBASE` キャプチャを必ず `git rebase "$REBASE_TARGET"` の**前**に置く（review-v1 Critical F1 対応）。`ALL_CONFLICT_FILES=""` も同じ場所で初期化。
- ST-5: CLAUDE.md §エラーリカバリ節への「Step 8 rebase conflict の semantic 自解決（T284）」追加は既存の「起動時 resume 不可検出（T264）」節の直前に挿入（`**異常検出**:` 段落直下）。既存テキストは一切削除していない。
- ST-6: CHANGELOG.md では既存 T283 エントリの上に T284 エントリを追加（新しいほど上の既存慣例に従う）。

---

## 5. 後続タスクへの申し送り

### Inspector への申し送り

plan.md §ST-7 / review-v2.md Inspector 事前連絡事項に従い、以下を前提に GO 判定してよい:

- **task.md 完了条件 #3（新規 rebase conflict シナリオでの手動検証）は本タスクの scope 外**
- 本タスクの scope は **template / docs / conductor.ts 配線変更のみ**
- 手動検証は Master が Inspector GO 後に後続タスク（例: `T28X follow-up: Step 8 semantic resolution 手動検証`、2 並列タスクで textually disjoint / semantic 衝突それぞれのケースを再現）として自動起票する運用

### Master への申し送り

Inspector GO 後、以下 2 つを実施すること（plan.md §ST-7 Minor 推奨 6 より）:

1. `T28X follow-up: Step 8 semantic resolution 手動検証` タスクを起票（2 並列タスクで textually disjoint / semantic 衝突それぞれのケースを再現）
2. task.md 本文に「手動検証は後続タスクで実施」の注記を追加（Master / Inspector の責務、Implementer が編集してはいけないため）

### Rollout 注意（CHANGELOG にも記載）

旧プロンプトを抱えた Conductor が Claude Code のセッション resume で復帰すると古い指示（即 abort）を実行し得るため、リリース後は `cmux-team restart` または各 Conductor ペインで `/clear` を実行して新プロンプトを読み込ませること。T274 と同趣旨。

---

## 6. 次フェーズ

Conductor が本 impl-report.md を参照し、Inspector Agent を spawn する。
