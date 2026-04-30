# タスク割り当て

## タスク内容

---
id: 350
title: docs/spec/glossary.md を新設して用語集を一元化
priority: medium
created_by: surface:123
created_at: 2026-04-26T21:11:48.590Z
---

## タスク
# 背景

cmux-team の用語定義（4層アーキテクチャ・Task FSM の state 名・Token Pool 用語・テンプレート変数・Artifact vs Task の対比など）は現状 `docs/spec/00`〜`09` および `CLAUDE.md` に散在しており、「シェアモードって何と呼んでる？」のような問い合わせに答えるのに横断 grep が必要になっている。

専用の glossary を新設して、用語 → 一次定義場所 へのインデックスとして機能させたい。

# やること

`docs/spec/glossary.md` を新設し、cmux-team で使われている主要用語をアルファベット順または日本語五十音順に整理する。各エントリは:

- 見出し: 用語名（英語表記が一次なら英語、日本語が一次なら日本語）
- 1〜3 行の簡潔な定義
- 一次定義へのリンク（`docs/spec/XX.md#section` 形式または相対パス）
- 関連用語があれば「関連: ◯◯」を併記

# カバー範囲（最低限含めるもの）

以下を `docs/spec/` 配下と `CLAUDE.md` から拾い上げて整理すること。網羅的でなくてよいが、以下のカテゴリは必ずカバー:

1. **4層アーキテクチャ層**: Master / Manager / Conductor / Agent — 一次: `docs/spec/00-project-overview.md`
2. **Task 関連**: Task / Artifact / Deliverable / TaskRun / taskRunId / surface — 一次: `docs/spec/00, 08, CLAUDE.md`
3. **Task FSM 状態**: draft / ready / assigned / closed / aborted / deleted / disconnected — 一次: `docs/spec/07-state-machine.md`
4. **Task 属性**: run_after_all / exclusive / depends_on — 一次: `CLAUDE.md` + `docs/spec/07`
5. **Conductor FSM 状態**: idle / assigned / waiting / done など — 一次: `docs/spec/07`
6. **Token Pool 用語**: handle / plan / plan_ratio / selectable / tags（hint 体系） / project default-include-exclude / auto-discover / lease / pool_capacity — 一次: `docs/spec/09-token-pool.md`
7. **テンプレート変数**: `{{VARIABLE}}` 一覧の入口 — 一次: `docs/spec/04-templates.md`
8. **Sync state**: diverged / uncommitted / detached / behind-ff / no-remote / Ready sync guard — 一次: `docs/spec/07, 05`
9. **Worktree / start-point**: explicit / config-local-ahead / config-origin / config-local / head-fallback — 一次: `docs/spec/05-install-and-infrastructure.md`
10. **コミュニケーション系**: Trace DB / hook / EventBus / queue / done marker — 一次: `CLAUDE.md` + 各 spec

# 出力先

- `docs/spec/glossary.md`（新規作成）
- `docs/spec/00-project-overview.md` の「リポジトリ構造」or 冒頭セクションに glossary.md への 1 行参照を追加
- `CLAUDE.md` の「リポジトリ構造」表 (docs/spec/ の表) に glossary.md の行を追加

# 方針メモ

- glossary は **二次資料**（リンク集）として作る。定義の本体は spec 側に置いたままにし、glossary では 1〜3 行の要約 + リンクに留める
- 同じ概念に複数の呼び方がある場合（例: 「シェアモード」← 正式には Token Pool の tags（hint 体系））は、両方を立項して一方をリダイレクト記述にする
- 全部を網羅しようとせず、「複数候補が出る用語」「会話で頻出する用語」を優先。残りは将来追加で OK

# 完了条件

- `docs/spec/glossary.md` が存在し、上記カテゴリ 1〜10 を網羅している
- `docs/spec/00-project-overview.md` と `CLAUDE.md` から glossary への参照がある
- `bunx tsc --noEmit` / 既存の docs リンクチェックがあれば pass


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-350-1777237908` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-350-1777237908
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-350-1777237908/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/350-docs-spec-glossary-md/runs/task-350-1777237908
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/350-docs-spec-glossary-md/runs/task-350-1777237908/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
