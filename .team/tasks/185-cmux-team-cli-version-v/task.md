---
id: 185
title: cmux-team CLI に --version / -v オプション追加
priority: medium
created_at: 2026-04-14T02:59:33.446Z
---

## タスク
# cmux-team CLI に --version / -v オプション追加

## 背景

現在 `cmux-team --version` は `Unknown command: --version` で失敗する。cmux 本家 CLI (`cmux --version` → `cmux 0.63.2 (79)`) と揃え、インストール済みバージョンを確認できるようにする。

## 実装スコープ

### 1. `skills/cmux-team/manager/main.ts` のサブコマンド dispatch に `--version` / `-v` を追加

- `package.json` の `version` フィールドを読み取り出力する
- フォーマット: `cmux-team X.Y.Z`（シンプルに）
- `--help` 出力の 1 行目付近に `cmux-team --version` も追記

### 2. バージョン取得方法

`package.json` の場所は `bin/cmux-team.js` の起点から相対で解決する。`import.meta.url` を使うか `fileURLToPath` で解決する。Bun 実行なので `await Bun.file(...)` でも可。

### 3. テスト（手動）

```
bun skills/cmux-team/manager/main.ts --version
# → cmux-team X.Y.Z

bun skills/cmux-team/manager/main.ts -v
# → cmux-team X.Y.Z
```

インストール後も確認:

```
npm run build などなければ直接:
cmux-team --version
cmux-team -v
```

### 4. `--help` の更新

Usage 表示の最初のほうに以下を追加:

```
cmux-team --version                          バージョン表示
```

## 注意

- サブコマンドより先にフラグを解釈する（`cmux-team start --version` のような組み合わせは考慮不要、`--version` 単独のみ対応）
- エラー時（package.json 読めない等）は `cmux-team (version unknown)` でも可
