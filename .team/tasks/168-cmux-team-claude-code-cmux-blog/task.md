---
id: 168
title: cmux-team ソースから Claude Code 外部操作 / cmux の blog ネタを発掘
priority: medium
created_at: 2026-04-12T04:04:38.468Z
---

## タスク
# 背景

`/Users/yamamoto/git/zenn-content/tips/blog-tips.md` に Claude Code を外部から操作するための tips を集めている。
cmux-team は Claude Code を subscription 以外の経路で多重起動し、Proxy・hook・statusline・`--settings`・`--session-id` 固定・`onBoardingSkip`・`trustFolder`・OAuth トークン注入など、かなり踏み込んだ使い方をしている実装の宝庫。

既存エントリ（抜粋）:
- ANTHROPIC_BASE_URL で Proxy を立ててヘッダからトークンリミット取得
- session-id の鶏卵問題（Proxy または output-stream jsonl の最初のレスポンス、任意 UUID を起動オプション指定）
- statusline で任意 shell 出力、`--settings` で hook 差し替え
- cmux 通知の切り方（wrapper + hook + 環境変数）
- subscription ではなく OAuth（setup-token）で動かすときの注意点

この observation「こういう知見が詰まっている」という観点で **cmux-team 本体のソースコードと templates を読み漁り、blog ネタになりそうな tips を抽出してほしい。**

# 調査対象

以下を重点的に読む（他にも気づいたものがあれば追加 OK）:

- `skills/cmux-team/manager/` 配下（特に `proxy.ts`, `cmux.ts`, `conductor.ts`, `master.ts`, `daemon.ts`, `trace-store.ts`, `template.ts`）
- `skills/cmux-team/templates/*.md`
- `bin/cmux-team.js`, `bin/postinstall.js`
- `.claude-plugin/plugin.json`, `marketplace.json`
- `commands/*.md`
- `skills/cmux-agent-role/SKILL.md`
- （参考）`.team/` 生成物のサンプル構造

# 求めるアウトプット

**`/Users/yamamoto/git/zenn-content/tips/blog-tips.md` に直接追記する形で提出**してほしい。

追記する tips の条件:

1. **既存エントリと重複しない**（上記の既存項目は除外。派生・深掘りは OK だが明記すること）
2. **blog ネタとして成立する粒度** — 「こういう課題があって、cmux-team ではこう解決している」まで書ける具体性
3. **ソースでの裏付け** — どのファイルの何行目でその仕組みが実装されているかを各 tip に付記（例: `skills/cmux-team/manager/proxy.ts:123`）。後で記事を書く時に参照できるように
4. **対象は「Claude Code の外部操作 / cmux 使いこなし」に役立つもの** — cmux-team 固有のアーキテクチャ説明ではなく、他プロジェクトでも使える汎用テクニックとして切り出せるもの

既存ファイルの末尾に新セクションを追加する形で、見出し（`# セクション名`）＋箇条書き＋ソース参照、の構造で書いてくれればよい。

# 参考: 想定されそうなネタの方向性（ヒント、これに縛られず自由に）

- Proxy を挟むことでどこまで観測・介入できるか（トレース、メタデータヘッダ伝播、本文保存、再送など）
- hook の発火タイミング・使い分け（PreToolUse / PostToolUse / SessionStart / Notification など）
- Claude Code を「デーモンとして」動かすための工夫（Idle 判定、Trust 承認自動化、crash 検出）
- `cmux send` 系コマンドで複数行テキストを送り込むときの罠と回避策
- worktree 隔離・direnv・env 伝播の工夫
- `.claude/settings.json` を動的生成して Claude に渡す使い方
- Claude Code 側のコマンド（`/clear`, `/compact` 等）を外部プロセスから制御する方法
- `cmux-team trace` の仕組み（SQLite FTS5 を使った検索）
- templates のプロンプトエンジニアリング上の工夫（共通ヘッダ分離、変数展開、role 別プロンプト）

# 完了条件

- blog-tips.md に最低 5 件以上の新規 tip を追記
- 各 tip にソース参照（ファイルパス、関数名 or 行番号）が付いている
- 既存エントリとの重複がない
- 一覧（どの tip を追記したか）を summary に記載

# 作業メモ

- `git/zenn-content` は別リポジトリ。cmux-team の worktree からは出ないと編集できないので、worktree 内から絶対パスで直接 Edit してよい（このタスクの例外的運用）
- 調査対象のコードは `$PROJECT_ROOT`（cmux-team 本体）に対して git 変更を起こさない。blog-tips.md の追記のみが成果物
- コミットは不要。ファイル編集のみで納品してよい
