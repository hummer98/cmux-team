---
id: 328
title: 新プロジェクト: パッケージ名・プロジェクト名を決定
priority: medium
created_at: 2026-04-25T21:49:05.625Z
---

## タスク
## 目的
issue hummer98/cmux-team#41 の新独立プロジェクトのパッケージ名 (= GitHub repo 名 = npm package 名) を決定する。

## 背景
- `aide` は AIDE IDE と衝突するため使用不可
- npm 単名 or スコープ付き (@hummer98/xxx) どちらでも可
- CLI コマンド名としても使うので短く明快なものが望ましい

## 候補案（参考）
| 名前 | 意味 | 備考 |
|---|---|---|
| `aver` | 「〜であると明言する」(assert/declare) | 短い、postcondition の意味に合う |
| `herald` | 状態変化を告げる使者 | 意味が良い |
| `warrant` | 保証する | やや長い |
| `affirm` | 確認・肯定する | 直感的 |
| `dex` | Declarative EXecutor | 略語系 |
| `statex` | state executor | 直接的 |

## 完了条件
- パッケージ名が1つに確定している
- ユーザーの承認を得ている
- タスク T_REPO（リポジトリ作成）を ready に昇格する
