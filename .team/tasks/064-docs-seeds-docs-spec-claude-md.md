---
id: 064
title: docs/seeds/ を docs/spec/ にリネームしCLAUDE.mdを更新
priority: medium
created_at: 2026-04-04T00:58:48.414Z
---

## タスク
## 概要

T062（ドキュメント同期）完了後に実施。docs/seeds/ は設計フェーズのシードドキュメントだったが、実装と同期済みで統合仕様書となった。フォルダ名を実態に合わせる。

## 前提

- T062 が完了していること

## やること

1. `docs/seeds/` を `docs/spec/` にリネーム（git mv）
2. CLAUDE.md 内の `docs/seeds/` への参照を全て `docs/spec/` に更新
3. CLAUDE.md のリポジトリ構造セクションを更新
4. CLAUDE.md に統合仕様書の存在と役割を明記する
   - 実装と同期された仕様書であること
   - コード変更時に参照すべきであること
   - 各ファイルの概要（00〜06）
5. 他のファイルで docs/seeds/ を参照している箇所があれば更新
