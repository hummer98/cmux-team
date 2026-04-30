---
id: 313
title: README に npm バッジ（version / 月間DL / 総DL）を追加
priority: low
created_by: surface:969
created_at: 2026-04-24T12:59:04.467Z
---

## タスク
## 目的

README.md / README.ja.md に npm 関連の shields.io バッジを追加し、現在の公開バージョンとダウンロード数が一目で見えるようにする。

## 追加するバッジ

npm パッケージ名は **`@hummer98/cmux-team`**（scoped）。既存の License バッジと同じ行に 3 つ追加する:

```markdown
[![npm version](https://img.shields.io/npm/v/@hummer98/cmux-team.svg)](https://www.npmjs.com/package/@hummer98/cmux-team)
[![npm downloads](https://img.shields.io/npm/dm/@hummer98/cmux-team.svg)](https://www.npmjs.com/package/@hummer98/cmux-team)
[![npm total downloads](https://img.shields.io/npm/dt/@hummer98/cmux-team.svg)](https://www.npmjs.com/package/@hummer98/cmux-team)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
```

順番は **version → monthly DL → total DL → License** を推奨（公開状況 → 利用状況 → ライセンスの流れ）。

## 変更対象

1. `README.md` — L5 付近の License バッジ行を上記 4 バッジに差し替え
2. `README.ja.md` — 同箇所を同じフォーマットで差し替え

両ファイルで**バッジ行が完全に一致する**ことを確認（URL・順序とも）。

## 確認方法

- `grep -n "shields.io" README.md README.ja.md` で同じ 4 行が並ぶことを確認
- GitHub 上で rendering を目視確認するのは後回しでよい（URL が正しければ shields.io 側でレンダーされる）

## 補足

- scoped package の DL 統計は npm 側の集計に遅延がある。publish 直後は `dm`/`dt` が 0 や "unknown" になることがあるが、バッジ URL 自体は正しいのでそのまま追加する
- このタスクではバージョンバンプやリリースは行わない（次回 release 時にバッジ付き README が公開される）

## 受け入れ条件

- README.md / README.ja.md 両方にバッジ 4 つが表示される
- バッジ URL / 順序が両ファイルで一致する
- 既存の見出し・本文に影響なし
