---
id: 336
title: CI test workflow を整備（prepublishOnly 削除の埋め合わせ）
priority: medium
created_by: surface:42
created_at: 2026-04-26T00:16:54.850Z
---

## タスク
T334 のリリース作業で v4.9.0 が npm OIDC publish 段階で 30 分以上 hang した。原因は package.json の prepublishOnly = "cd skills/cmux-team/manager && bun test" が GHA Publish ステップの暗黙トリガーで全体実行され、A021（T327）に記録された bun test 全体実行 O(N^2) 級劣化問題に常時引っかかっていたこと。v4.9.1 では prepublishOnly を削除して release を通したが、これでリリース時のテスト実施ポイントが消えた。

## やること

PR / main push trigger で bun test を回す独立 GitHub Actions workflow を新設する。release.yml の Publish ステップとは独立させる（リリースを test の hang で詰まらせない）。

## 技術メモ

- bun test 全体実行は A021 で記録された O(N^2) 級劣化問題があり 13 分以上 hang する
- 暫定回避策（A021 §再現手順 5）: 個別ファイル iteration（`for f in *.test.ts state-machine/*.test.ts; do bun test "$f"; done`）なら 68 秒で全 pass
- CI 上では `--reporter=dots` も併用すると進捗が見える
- root cause（module-level singleton 累積疑い）の解消は別タスク

## 完了条件

- `.github/workflows/test.yml` 等で PR / main push 時に bun test が走る
- CI 経過時間が安定（5 分以内目標）
- 失敗時にちゃんと fail する（暫定回避ループでも個別ファイル fail を集約）
- `bun test` 全体実行は禁忌として README/CLAUDE.md に追記してよい

## 関連

- A021（T327）: bun test 全体実行ハング調査
- T334: v4.9.1 リリース（このタスクの起源）
