---
id: 26
title: 全テスト実行 + リリース
priority: medium
status: ready
created_at: 2026-03-28T00:10:00Z
depends_on: [24, 25]
---

## 概要

タスク #23〜#25 の変更を統合した後、ユニットテスト・型チェック・E2E テストを実行し、問題があれば修正してからリリースする。

## 手順

1. **型チェック**: `cd skills/cmux-team/manager && ./node_modules/.bin/tsc --noEmit`
2. **ユニットテスト**: `bun test`
3. **修正**: 失敗があれば修正してコミット
4. **E2E テスト**: `./e2e.ts sequential` で基本フローを検証
5. **リリース**: `/release` コマンド相当の処理を実行
   - コミット分析 → バージョン自動判定
   - CHANGELOG.md 更新
   - plugin.json バージョン更新
   - コミット・push
   - `gh release create`
   - marketplace キャッシュ更新
   - 旧キャッシュ削除
   - plugin reinstall
   - bun install

## 完了条件

- [ ] 型チェック通過
- [ ] ユニットテスト全パス
- [ ] E2E テスト sequential パス
- [ ] GitHub Release 作成済み
- [ ] plugin 更新済み

## Journal

- summary: 型チェック・ユニットテスト(44件)・E2Eテスト(sequential 3タスク)全パス確認後、v2.11.0としてリリース完了。plugin reinstall済み。
- files_changed: 3
