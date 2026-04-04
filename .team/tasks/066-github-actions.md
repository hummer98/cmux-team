---
id: 066
title: GitHub Actions リリースワークフロー追加
priority: medium
created_at: 2026-04-04T01:04:58.063Z
---

## タスク
## 概要

タグ push をトリガーに npm publish + GitHub Release を自動実行するワークフローを追加する。npm OIDC Trusted Publishing を使用（トークン不要、npmjs.com 側の設定は済み）。

## やること

`.github/workflows/release.yml` を作成:

- トリガー: `push: tags: ['v*']`
- permissions: `contents: write`（GitHub Release）、`id-token: write`（npm OIDC）
- steps:
  1. checkout
  2. setup-node (v22, registry-url: https://registry.npmjs.org)
  3. `npm publish --provenance --access public`
  4. CHANGELOG から該当バージョンのセクションを抽出して `gh release create` 

## 注意

- npm CLI v11.5.1 以上が必要（setup-node の node 22 なら含まれる）
- --provenance フラグで署名付き公開
- トークンは不要（OIDC 認証）
- 既存の /release スキルの npm publish ステップと GitHub Release ステップは手動実行不要になるが、CHANGELOG 更新・バージョン更新・コミット・タグ・push は引き続き /release スキルで行う
