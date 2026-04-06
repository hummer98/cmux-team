---
id: 091
title: E2Eテスト spike: 最小シナリオスクリプトの作成と実行
priority: high
created_at: 2026-04-06T07:05:51.091Z
---

## タスク
## 目的

cmux-team の E2E テスト自動化の PoC。最小限のスクリプトを作って実際に動かし、テストアプローチの実現可能性を検証する。

## やること

1. `tests/e2e/spike.ts` に Bun スクリプトを作成
2. 以下のシナリオを実装:
   - tmpdir に fixture repo を作成（git init + 最小限の CLAUDE.md）
   - `cmux new-window` でテスト用 window を作成（隔離のため）
   - その window 内で `cmux-team start` を実行
   - `manager.log` を polling して `boot_completed` を待つ（timeout 60s）
   - `conductor_ready` が 3 回出ていることを確認
   - `team.json` の conductors が全て idle であることを確認
   - cleanup: `cmux-team stop` → `cmux close-window` → tmpdir 削除
3. 結果を stdout に出力（PASS/FAIL + 詳細）

## 技術方針

- Bun + TypeScript（manager/ と同じランタイム）
- cmux CLI をラップして操作（`Bun.spawn` 経由）
- `waitFor` パターン: ファイルを polling して特定条件を満たすまで待つ
- アサーションは簡素に（`assert` or 手書き）

## 重要

- **main にマージしない**。spike 検証のみ。worktree 内で実行して結果を報告する
- cmux-team start は新しい window 内で実行するため、現在のセッションに影響しない
- fixture repo は /tmp 配下に作成し、テスト後に削除する
