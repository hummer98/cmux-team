# タスク割り当て

## タスク内容

---
id: 317
title: probe: CLAUDE_CODE_OAUTH_TOKEN 切り替えと proxy 識別の実機検証
priority: high
created_by: surface:1062
created_at: 2026-04-24T21:12:24.807Z
---

## タスク
## 目的

後続の「グローバルトークンプール機能」（~/.cmux-team/tokens.db による burnout ベースのトークン選択）の前提となる挙動を実機で確認し、設計判断の未知要素を潰す。

## 背景

Master / Conductor / Agent の 4 層構造のうち、**Agent 起動時に限り** CLAUDE_CODE_OAUTH_TOKEN を複数プールから選択して注入する構想がある。選択軸は以下:

- 7d / 5h window の残量（バーンアウトスコア最小）
- プロジェクトタグ適合性（any / org:xxx / oss-only 等）
- cmux-team 本体の 5h limiter と整合

グローバル pool は \`~/.cmux-team/tokens.db\`（SQLite）で複数 cmux-team プロジェクトから共有。proxy が Authorization header の hash でリクエストと tokens レコードを紐付け、usage/rate_limit を throttled で upsert する。

これらが成立するために、実機で確認すべき未知項目がある。

## 検証項目

### 1. CLAUDE_CODE_OAUTH_TOKEN の切り替え動作

- Agent spawn 時に env: \`CLAUDE_CODE_OAUTH_TOKEN=<別 subscription のトークン>\` を渡すと、Master と別のサブスクリプション quota が使われるか
- 使用量・rate limit の帰属先が切り替え先になっているか（Anthropic Console / \`/cost\` / proxy の api_usage で確認）
- subscription → subscription の切り替えが可能か（API key 専用の挙動ではないか）

### 2. Authorization header の観測

- proxy が実際に受け取る Authorization header の形式（Bearer sk-ant-oat-... 等）
- proxy.ts の該当箇所に capture ログを一時追加し、1 リクエスト分を取得して形式を記録（後で revert する想定）
- トークンごとに異なる hash が取れることを確認

### 3. Rate limit ヘッダーの subscription 挙動

- 切り替えた subscription で \`anthropic-ratelimit-tokens-remaining\` / \`-limit\` / \`-reset\` 等が返るか
- \`.team/traces/traces.db\` の api_usage テーブルに subscription でも値が埋まるか（T305 の延長確認）

### 4. Master 継承（env 未注入）時の識別可能性

- spawn-agent で CLAUDE_CODE_OAUTH_TOKEN を渡さない場合、Agent は Claude Code の credential file を継承するはず
- その際 proxy が見る Authorization header は Master と同一 hash になるか
- auto-discover（未登録 hash を tags: [\"auto\"], selectable: false で登録）方針の妥当性確認

## 成果物

- \`.team/artifacts/Axxx-token-pool-probe.md\` に以下を記載:
  - 各検証項目の結果（YES/NO + 根拠となる header 値・/cost 出力・Console 表示）
  - 発見した制約・制限
  - 後続実装タスク（tokens.db CRUD / \`cmux-team token add\` CLI / spawn-agent selection ロジック / proxy の throttled upsert）の設計に影響する判明事項

## Out of scope

- tokens.db の schema / CRUD 実装
- \`cmux-team token\` CLI 実装
- spawn-agent の selection ロジック実装
- Keychain 連携

## 制約

- proxy.ts に追加する capture ログは調査終了時に必ず revert する（PR では消えていること）
- 2 つ目の subscription を準備できない場合は、Anthropic API key を使った切り替えで代替検証してよい。その旨を artifact に明記する

## 検証方法

- \`cmux-team status\` で現在のトークン・usage を確認
- 検証用に small Agent タスクを 2〜3 本走らせ、proxy の api_usage と Console の usage を突合
- Authorization header の hash が期待通り分岐するかを sqlite で確認


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-317-1777065230` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-317-1777065230
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-317-1777065230/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/317-probe-claude-code-oauth-token-proxy/runs/task-317-1777065230
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/317-probe-claude-code-oauth-token-proxy/runs/task-317-1777065230/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
