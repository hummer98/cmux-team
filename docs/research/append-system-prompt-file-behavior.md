# `--append-system-prompt-file` の挙動調査

調査日: 2026-03-29

## 概要

Claude Code CLI の `--append-system-prompt-file` フラグがセッションライフサイクルの各シナリオでどう振る舞うかを調査した。cmux-team では Master と Conductor のロール定義永続化にこのフラグを使用している。

## 基本動作

`--append-system-prompt-file` で指定したファイルの内容は、API リクエストの **システムプロンプト層** に追加される。CLAUDE.md のようなユーザーメッセージ層ではなく、実際のシステムプロンプトレイヤーに挿入される。

## シナリオ別の挙動

| シナリオ | 維持? | 備考 |
|---------|-------|------|
| `/clear` | ✅ 維持 | 会話履歴のみリセット。system prompt は残る |
| コンテキスト圧縮 (`/compact`) | ✅ 維持 | system prompt は圧縮対象外 |
| `--resume` | ❌ 失われる | 再開時に再指定が必要 |
| `-c` (continue) | ❌ 失われる | 同上 |
| fork (`cfork`, `--fork-session`) | ❌ 失われる | fork 先に引き継がれない |

## cmux-team への影響

### 設計上の利点

- Conductor: `--append-system-prompt-file conductor-role.md` でロール定義を永続化。daemon が `/clear` + 新タスクプロンプトを送信しても、ロール定義は維持される
- Master: 同様に `--append-system-prompt-file master.md` でロール定義を永続化

### 既知の問題

**cfork 後に Master ロールが失われる**: Master セッションを `cfork` すると、fork 先のセッションには `--append-system-prompt-file` の設定が引き継がれない。Master ロール定義が消失し、素の Claude Code として動作してしまう。

### 回避策

fork 後に `/cmux-team:master` を実行すれば、Master ロール定義をコマンド経由で再読み込みできる。ただしこれはコマンド実行時の一時的な指示であり、コンテキスト圧縮で薄れる可能性がある。

### resume 時の対応

`--resume` や `-c` でセッションを再開する場合、`--append-system-prompt-file` を再指定する必要がある:

```bash
# 正しい再開方法
claude --resume <session-id> --append-system-prompt-file .team/prompts/master.md

# これだと system prompt が失われる
claude --resume <session-id>
```

## 参考

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference.md)
- [GitHub Issue #6153 - Add --append-system-prompt-file argument](https://github.com/anthropics/claude-code/issues/6153)
