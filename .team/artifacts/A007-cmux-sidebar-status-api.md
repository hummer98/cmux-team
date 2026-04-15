---
id: A007
type: research
title: "cmux サイドバーステータス API 仕様"
created: 2026-04-10T15:00:00+09:00
author: master
tags: [cmux, sidebar, status, api]
---

# cmux サイドバーステータス API

cmux のサイドバー（ワークスペース一覧）にメタデータをピル（pill）形式で表示する機能。

## CLI コマンド

### set-status — ステータスエントリの設定

```bash
cmux set-status <key> <value> [flags]
```

| フラグ | 説明 | 例 |
|--------|------|-----|
| `--icon <name>` | SF Symbols アイコン名 | `sparkle`, `hammer`, `bolt.fill` |
| `--color <#hex>` | ピルの色（hex） | `#FF3B30`, `#4C8DFF` |
| `--workspace <id\|ref>` | 対象ワークスペース（デフォルト: `$CMUX_WORKSPACE_ID`） | `workspace:2` |
| `--priority <N>` | 表示優先度（大きいほど上） | `100` |
| `--url <url>` | リンク先 URL | `https://example.com` |
| `--format <plain\|markdown>` | テキスト形式 | `markdown` |
| `--tab <surface>` | タブ固有のステータス | `surface:13` |

**注意:** `--priority`, `--url`, `--format`, `--tab` は `--help` に記載がないが、エラーメッセージと実動作で確認済み。

```bash
# 基本
cmux set-status build "compiling" --icon hammer --color "#ff9500"

# 優先度付き
cmux set-status task "T042" --icon doc.text --color "#AF52DE" --priority 100

# ワークスペース指定
cmux set-status deploy "v1.2.3" --workspace workspace:2
```

### list-status — ステータスエントリの一覧

```bash
cmux list-status [--workspace <id|ref>]
```

出力形式:
```
key=value icon=name color=#hex [priority=N] [url=...] [format=...]
```

実例:
```
claude_code=Running icon=bolt.fill color=#4C8DFF
task=T042 icon=doc.text color=#AF52DE priority=100
```

### clear-status — ステータスエントリの削除

```bash
cmux clear-status <key> [--workspace <id|ref>]
```

## claude-hook 連携

Claude Code は `cmux claude-hook` 経由で `claude_code` キーのステータスを自動管理する。

| サブコマンド | ステータス変化 | アイコン | 色 |
|-------------|--------------|---------|-----|
| `session-start` / `active` | `Running` | `bolt.fill` | `#4C8DFF` |
| `stop` / `idle` | `Idle` | `pause.circle.fill` | `#8E8E93` |
| `notification` | `Needs input` | `bell.fill` | `#4C8DFF` |
| `prompt-submit` | `Running` | `bolt.fill` | `#4C8DFF` |

```bash
echo '{"session_id":"abc"}' | cmux claude-hook session-start
echo '{}' | cmux claude-hook stop
echo '{"title":"Done","body":"message"}' | cmux claude-hook notification
echo '{}' | cmux claude-hook prompt-submit
```

## 特性

- **複数エントリ同時表示**: 異なる `key` で複数のピルを同時に表示可能
- **キーの一意性**: 同じ `key` で `set-status` すると値が上書きされる
- **ワークスペーススコープ**: ステータスはワークスペースごとに管理される
- **空文字不可**: `value` が空文字だとエラー
- **アイコン**: SF Symbols の名前をそのまま使用可能（`person.3.fill`, `cpu`, `exclamationmark.triangle` 等）

## cmux-team での活用案

| key | 用途 | 例 |
|-----|------|-----|
| `team` | チーム全体の状態 | `3 tasks running` |
| `conductor_1` | Conductor 1 の状態 | `T042 implementing` |
| `conductor_2` | Conductor 2 の状態 | `T043 reviewing` |
| `conductor_3` | Conductor 3 の状態 | `idle` |
| `queue` | キュー状態 | `2 queued` |

## 自動連携の無効化

環境変数 `CMUX_CLAUDE_HOOKS_DISABLED=1` を設定すると、`cmux claude-hook` の呼び出しが全てスキップされ、`claude_code` キーの自動ステータス更新が無効になる。

cmux-team では Conductor/Agent spawn 時にこの環境変数を explicit な `export` として直接注入し、サブエージェントが個別にサイドバーステータスを書き換えないようにしている（T130 で実装）。T212 で worktree への `.envrc` (`source_up`) 自動生成経路は削除され、spawn 時の `export` が authoritative な注入経路となった。

```bash
# 無効化
export CMUX_CLAUDE_HOOKS_DISABLED=1

# 有効化（デフォルト）
unset CMUX_CLAUDE_HOOKS_DISABLED
```
