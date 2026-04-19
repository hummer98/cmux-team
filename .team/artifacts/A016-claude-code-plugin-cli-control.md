---
id: A016
type: research
title: "Claude Code CLI でプラグインを 1 セッションだけ制御する方法"
created: 2026-04-19T10:39:00+09:00
author: surface:unknown
tags: [claude-code, plugins, cli, settings, using-cmux]
---

## 背景

`using-cmux` プラグインの `SessionStart` hook がターミナルタブ名を `[N] Claude Code` に書き換える挙動を切り分けるため、**「新しく起動する 1 つの claude セッションだけ 特定プラグインを無効化」**する最小侵襲な方法を調査した（他の稼働中セッションには影響させない）。

## 調査結果

### 1. `--disable-plugin <name>` のような CLI フラグ

**存在しない。** `claude --help` 全量、[CLI reference](https://code.claude.com/docs/en/cli-reference) どちらにも該当フラグなし。

### 2. `--plugin <name>` のような「単独有効化」フラグ

**存在しない。**

### 3. `--plugin-dir <path>` の挙動

**追加（additive）モード。** 「Load plugins from a directory **for this session only**」。インストール済みプラグインを無効化する機能はなく、空ディレクトリを渡しても既存プラグインは生き続ける。同名プラグインがあれば local copy が優先されるだけ。

### 4. `--settings <file-or-json>` で `enabledPlugins` を上書き

**可能。** [Settings precedence](https://code.claude.com/docs/en/settings#settings-precedence) は `Managed > CLI args > Local > Project > User` で、CLI args 層 (`--settings`) は User settings より強い。`enabledPlugins` は `"plugin@marketplace": boolean` の map で deep-merge される。リーフ単位で `true → false` 上書きが可能。

### 5. `--setting-sources <sources>` で `user` を除外

**可能だが全滅する。** `--setting-sources project` のように渡すと指定ソースのみ読まれ User settings は無視されるが、User の `enabledPlugins` 全体が失われるため他プラグインも全部無効化される。特定 1 つだけ切りたい用途には不適。

### 6. `claude plugin disable <name> --scope local`

`.claude/settings.local.json` の `enabledPlugins` を `false` に書き込むだけ。**そのリポジトリ内で新規起動する claude セッションに恒久的に効く。** プロセス単位のフラグではなく、別プロジェクトの既存セッションには影響しない（起動時スナップショットで動くため）。

## 推奨手段（最小侵襲・1 セッションだけ）

```bash
claude --settings '{"enabledPlugins":{"using-cmux@hummer98-using-cmux":false}}'
```

| 特性 | 効果 |
|------|------|
| 他セッション | 無影響（プロセス固有の CLI args） |
| User settings | 書き換えない（恒久化なし） |
| keychain / auth | 通常通り（`--bare` と違い認証が生きる） |
| 無効化範囲 | プラグイン全体（hook / command / skill 全部 OFF） |

### 実機検証（2026-04-19, surface:205）

- `cmux new-split down --surface surface:33` で `surface:205` を作成
- `claude --dangerously-skip-permissions --settings /tmp/disable-using-cmux.json` 起動
- `/tmp/disable-using-cmux.json` の内容: `{"enabledPlugins":{"using-cmux@hummer98-using-cmux":false}}`
- タブ名を `[205] TEST` に設定 → 35 秒以上経過しても rename されず。using-cmux SessionStart hook が発火しないことを確認。

## 参考 URL

- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/settings （Settings precedence, enabledPlugins）
- https://code.claude.com/docs/en/plugins
- https://code.claude.com/docs/en/plugins-reference （plugin disable / scope）
- https://code.claude.com/docs/en/discover-plugins

## 関連

- A001: tab title overwrite conflict
- A002: claude-code-hook-events
