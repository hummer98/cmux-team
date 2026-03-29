---
id: 007
title: npm パッケージの品質改善: テスト除外・prepublishOnly・スコープ名
priority: high
created_at: 2026-03-29T06:13:27.754Z
---

## タスク
## 目的

npm パッケージとしての品質を改善する。@hummer98/firex を参考に。

## 変更内容

### 1. テストファイルを配布から除外
- files フィールドの skills/ を細分化するか、.npmignore に *.test.ts を追加して効かせる
- 現状 files が優先されて .npmignore の *.test.ts 除外が効いていない
- 対象: daemon.test.ts, proxy.test.ts, queue.test.ts, task.test.ts
- npm pack --dry-run で除外を確認

### 2. prepublishOnly スクリプト追加
- package.json に prepublishOnly を追加
- 内容: テスト実行（bun test）で publish 前の安全チェック
- ビルドステップは不要（bun で直接 TS 実行するため）

### 3. スコープ名への変更
- name を cmux-team から @hummer98/cmux-team に変更
- bin 名は cmux-team のまま維持（ユーザーが叩くコマンド名は変わらない）
- README 等のインストール手順を更新: npm install -g @hummer98/cmux-team

### 4. 確認
- npm pack --dry-run でテストファイルが除外されていること
- パッケージサイズが削減されていること
- bin/cmux-team.js が正しく動作すること

## 参考
- ~/git/firex の package.json を参照
- postversion や release スクリプトは不要（リリースは手動）
