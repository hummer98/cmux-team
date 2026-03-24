---
id: 001
title: "README の旧表記を修正"
priority: high
created_at: 2026-03-24T12:05:00Z
---

## タスク

README.md と README.ja.md に残っている旧アーキテクチャの表記を修正する。

## 修正内容

1. "Conductor mode" / "Conductor モード" → 削除または "Master mode" に修正
2. "Conductor (parent Claude)" / "Conductor（親 Claude）" → "Master" に修正
3. "Orchestration knowledge for Conductor" → "4-tier architecture definition" に修正
4. その他、旧2層構造を前提とした表記があれば 4層構造に合わせて修正

## 対象ファイル

- README.md
- README.ja.md

## 完了条件

- grep で "Conductor mode" "Conductor モード" が 0 件
- 4層アーキテクチャの説明と矛盾する表記がないこと
- コミット＆push まで完了
