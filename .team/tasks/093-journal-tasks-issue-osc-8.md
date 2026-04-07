---
id: 093
title: ダッシュボードのJournal/Tasksでissue番号をOSC 8リンク化
priority: medium
created_at: 2026-04-06T10:45:07.981Z
---

## タスク
## 概要

ダッシュボード TUI の Journal セクションと Tasks セクションに表示される GitHub issue 番号（#1234 等）を、cmd+click で GitHub の issue URL を開けるようにする。

## 技術方針

OSC 8 ターミナルハイパーリンクを使用:
```
\e]8;;https://github.com/owner/repo/issues/1234\e\\#1234\e]8;;\e\\
```

## 実装内容

1. `dashboard.tsx` の Journal / Tasks 表示部分で、テキスト内の `#[0-9]+` パターンを検出
2. git remote origin の URL からリポジトリの owner/repo を取得（`git remote get-url origin` → パース）
3. 検出した issue 番号を OSC 8 リンクでラップ
4. リポジトリ情報はダッシュボード起動時に1回取得してキャッシュ

## 参考

- 既存実装: コミット 1f94843 で OSC 8 リンク化の実績あり
- OSC 8 フォーマット: `\x1b]8;;URL\x1b\\表示テキスト\x1b]8;;\x1b\\`
- cmux は Ghostty ベースなので OSC 8 対応済み

## 注意

- rezi-ui の Text コンポーネントが OSC 8 エスケープシーケンスを透過するか確認が必要。直接 stdout に書く必要がある場合は代替手段を検討
- Task ID（T089 等）もリンク化するか検討（ローカルファイルなので URL がない → 対象外でよい）
