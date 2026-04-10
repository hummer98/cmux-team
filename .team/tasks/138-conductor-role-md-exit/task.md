---
id: 138
title: conductor-role.md に /exit 禁止を明記する
priority: high
created_at: 2026-04-10T19:22:09.910Z
---

## タスク
## 背景

Dear プロジェクトで Conductor (surface:35) が T114 完了後に自発的に `/exit` を実行し、セッションが終了した。
Conductor は常駐セッションであり、タスク完了後も生き続けて次のタスク割り当てを待つのが正しい動作。

CLAUDE.md・メモリ・settings に汚染はなく、Claude が「タスク完了 → セッション終了」と自発的に推論した結果。
conductor-role.md には最初のバージョンから /exit 禁止が書かれていなかった（仕様の穴）。

## 修正内容

`skills/cmux-team/templates/conductor-role.md` に以下2箇所を追加:

### 1. 完了時の処理 ステップ9 を強化

現在:
> 9. **❯ プロンプトに戻る。次のタスクの割り当てを待つ。** daemon がリセット処理（`/clear` 送信）を行う。

変更後（/exit 禁止を明記）:
> 9. **❯ プロンプトに戻る。次のタスクの割り当てを待つ。** daemon がリセット処理（`/clear` 送信）を行う。**`/exit` でセッションを終了してはならない。Conductor は常駐セッションであり、タスク完了後もセッションを維持すること。**

### 2. 「やらないこと（厳守）」セクションに追加

> - **`/exit` でセッションを終了する** — Conductor は常駐セッション。タスク完了後は ❯ プロンプトで待機し、daemon の `/clear` を待つ
