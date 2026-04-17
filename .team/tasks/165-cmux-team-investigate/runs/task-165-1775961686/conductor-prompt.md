# タスク割り当て

## タスク内容

---
id: 165
title: プロジェクト内専用スキル: 別プロジェクトの挙動調査（cmux-team-investigate）
priority: medium
created_at: 2026-04-12T02:41:26.941Z
---

## タスク
## 背景

cmux-team 開発中、ユーザーから別プロジェクト（例: ~/git/mado, ~/git/Dear）の manager.log やエラーの原因調査を頼まれることが多い。毎回手順を思い出すのが非効率で、以下の定型手順を SKILL 化したい:

1. 対象 surface または repo path を特定
2. そのリポジトリの `.team/logs/manager.log` を確認
3. `.team/traces/traces.db`（SQLite FTS5）を `cmux-team trace` で検索
4. 必要なら `cmux read-screen --surface <id>` で画面直接確認
5. task-state.json や conductors/ で状態確認
6. 時系列相関分析してユーザーに報告

## 重要: 配布プラグインに含めない

このスキルは cmux-team の**開発者用**であり、npm publish される配布プラグインに含めてはならない。

**配置場所:** `.claude/skills/cmux-team-investigate/SKILL.md`（プロジェクトルートの `.claude/skills/`）

- `skills/` 配下ではなく `.claude/skills/` に置く
- `.claude/skills/` はプロジェクトローカルで、npm package.json の `files` に含まれていない（配布対象外）
- `.claude-plugin/plugin.json` の `skills: "./skills/"` は `skills/` だけを見るため、`.claude/skills/` 配下は plugin にバンドルされない
- → このプロジェクトで開発作業する時だけ Master セッションに読まれる

## SKILL 本文に含めるべき内容

### description（発動条件）
- ユーザーが「~/git/<別プロジェクト>で...」「madoでエラー」「Dearで...」など他リポジトリの問題を調査依頼
- manager.log や trace DB の相関分析が必要な場合
- 特定 surface の挙動調査

### 手順

1. **対象リポジトリの特定**
   - ユーザーが指定したパス（例: ~/git/mado）を受け取る
   - surface 指定の場合は \`cmux identify --surface <id>\` で workspace_ref → ワークスペースのCWD を取得
   - `.team/` が存在することを確認

2. **ログ収集**
   - \`cat <repo>/.team/logs/manager.log | tail -N\`
   - \`cat <repo>/.team/task-state.json\`
   - 必要に応じて \`ls <repo>/.team/conductors/\`

3. **trace DB 検索**
   - \`cmux-team trace --db <repo>/.team/traces/traces.db --search <query>\`
   - \`cmux-team trace --db <repo>/.team/traces/traces.db --task <id>\`
   - 注: \`--db\` オプションが無ければ、環境変数か cwd 切り替えで対応

4. **surface 直接参照**
   - \`cmux read-screen --surface <id> --workspace <workspace_ref>\`
   - 別 workspace のため必ず \`--workspace\` を付ける

5. **時系列相関**
   - manager.log のタイムスタンプを基準に trace DB のリクエストを紐付ける

### 注意事項（Master ロール固有）

- 調査中は Master としてのタスク作成責務を忘れない（原因特定したら修正タスクを作る）
- 対象プロジェクトの `.team/` は**読み取り専用**で扱う（間違っても書き込まない）
- trace DB はロックされる可能性あり → cp して読むか sqlite3 の \`-readonly\` モード検討

### CLAUDE.md への参照追加

CLAUDE.md の「コーディング規約」下あたりに以下を追記:

> ### 開発者用スキル
> 別プロジェクトの挙動調査は `.claude/skills/cmux-team-investigate/SKILL.md` を参照（このリポジトリのみ有効、配布外）。

## 完了条件

- `.claude/skills/cmux-team-investigate/SKILL.md` が作成され、description に適切な発動条件が書かれている
- 上記の手順 1〜5 が具体的なコマンド例とともに記述されている
- CLAUDE.md に参照ポインタが 1〜2 行追記されている
- `package.json` の `files` 配列に `.claude/` が**含まれていない**ことを確認（配布されないこと）
- `.claude-plugin/plugin.json` の `skills: "./skills/"` が変更されていないことを確認（plugin には含まれないこと）

## 検証方法

\`\`\`bash
# npm pack して中身確認（.claude/ が含まれないはず）
npm pack --dry-run 2>&1 | grep -i claude
\`\`\`

### skill-creator での検閲

作成後 `skill-creator` 等で SKILL.md の品質レビュー（description の具体性、手順の網羅性）を通すこと。


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-165-1775961686` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-165-1775961686
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-165-1775961686/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/165-cmux-team-investigate/runs/task-165-1775961686
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/165-cmux-team-investigate/runs/task-165-1775961686/summary.md` に書き出す。

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
