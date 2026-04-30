---
id: 331
title: 新プロジェクト: docs/seed.md 作成（AI 申し送り用プロンプト）
priority: medium
created_at: 2026-04-25T21:49:31.460Z
---

## タスク
## 目的
新プロジェクトを引き継ぐ AI エージェントが「なぜ作るか・何を作るか・どう作るか」を一読で理解できる申し送り文書を作成する。
cmux-team の CLAUDE.md に相当する「構想の格子」。

## 含めるべき内容
1. **プロジェクトミッション**: transformer の state tracking 弱さ × CLI の silent state mutation 問題を解く
2. **参照 issue**: hummer98/cmux-team#41 の全文要約
3. **配布アーキテクチャ**: 各エージェントプラットフォームのネイティブプラグインとして配布（Claude Code Plugin / OpenCode Plugin 等）
4. **実装言語**: Go（static binary → plugin bundle が最もシンプル）
5. **設計原則**: issue#41 の設計原則セクションをそのまま転記
6. **MVP スコープ**: 最初の 3 コマンド候補（chdir / git-switch / env-set）
7. **SKILL.md の位置づけ**: Anthropic Agent Skills 仕様準拠、nudge 駆動で CLI 採用を促す
8. **ディレクトリ構造と役割**
9. **コーディング規約**: コメント日本語、コード英語（cmux-team に準ずる）
10. **次にやること（open questions）**: issue#41 のオープンな問いをそのまま引継ぎ

## 完了条件
- docs/seed.md が ~/git/<project-name>/ に存在し push 済み
- タスク T_WORKSPACE（cmux workspace 作成）を ready に昇格する
