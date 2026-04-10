# --session-id 仕様調査結果

## 調査日: 2026-04-10

## 1. `claude --help` の記載

```
--session-id <uuid>     Use a specific session ID for the conversation (must be a valid UUID)
```

- 型制約: 有効な UUID であることが必須
- 新規セッション開始時のオプション

関連オプション:
```
--fork-session          When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)
-r, --resume [value]    Resume a conversation by session ID, or open interactive picker with optional search term
```

## 2. UUID v4 の受理テスト

```bash
$ uuid_v4=$(python3 -c "import uuid; print(uuid.uuid4())")
$ echo "Generated UUID: $uuid_v4"
Generated UUID: 0bda4742-6189-4265-b07a-5de357efdeb0

$ claude --session-id "$uuid_v4" --print "hello" --max-turns 1
こんにちは！何かお手伝いできることはありますか？
```

**結果: 受理される。** `crypto.randomUUID()` 相当の UUID v4 が使用可能。

## 3. ハイフンなし UUID のテスト

```bash
$ uuid_no_hyphens=$(python3 -c "import uuid; print(uuid.uuid4().hex)")
$ echo "UUID without hyphens: $uuid_no_hyphens"
UUID without hyphens: 08dc94ce36194f5fbc46031b009e51db

$ claude --session-id "$uuid_no_hyphens" --print "hello" --max-turns 1
Error: Invalid session ID. Must be a valid UUID.
```

**結果: 拒否される。** ハイフン付き標準形式（8-4-4-4-12）が必須。

## 4. UUID 以外の文字列テスト

```bash
$ claude --session-id "task-042-1712345678" --print "hello" --max-turns 1
Error: Invalid session ID. Must be a valid UUID.
```

**結果: 拒否される。** UUID 形式以外の文字列は使用不可。taskRunId をそのまま session-id として使うことはできない。

## 5. `--session-id` + `--resume` 併用テスト

```bash
$ uuid_test=$(python3 -c "import uuid; print(uuid.uuid4())")
$ claude --session-id "$uuid_test" --resume "$uuid_test" --print "hello" --max-turns 1
Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.
```

**結果: エラー。** `--session-id` は `--resume` / `--continue` と直接併用できない。`--fork-session` を追加すれば可能。

## 追加テスト: --session-id → --resume の流れ

```bash
$ uuid_test=$(python3 -c "import uuid; print(uuid.uuid4())")
$ claude --session-id "$uuid_test" --print "Say the word 'PINEAPPLE' and nothing else" --max-turns 1
PINEAPPLE

$ claude --resume "$uuid_test" --print "What was the last word I asked you to say?" --max-turns 1
PINEAPPLE
```

**結果: 成功。** `--session-id` で指定した UUID は `--resume` で再開可能。

## 追加テスト: --continue + --session-id

```bash
$ claude --continue --session-id "$uuid_test" --print "..." --max-turns 1
Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.
```

**結果: エラー。** `--continue` との併用も `--fork-session` が必要。

## まとめ

| 項目 | 結果 |
|------|------|
| UUID v4（ハイフン付き） | 受理 |
| UUID（ハイフンなし） | 拒否 |
| UUID 以外の文字列 | 拒否 |
| `--session-id` + `--resume` | エラー（`--fork-session` が必要） |
| `--session-id` → 後から `--resume` | 成功 |
| `--session-id` + `--continue` | エラー（`--fork-session` が必要） |

### 設計上の影響

1. **UUID 生成**: `crypto.randomUUID()` で生成可能。Bun の `Bun.randomUUIDv7()` も使用可能だが、標準の v4 で十分
2. **taskRunId との関連**: taskRunId（`task-042-1712345678`）は session-id として使えないため、別途 UUID を生成して紐付ける必要がある
3. **resume フロー**: `--session-id <uuid>` で開始 → `--resume <uuid>` で再開、が正常に動作する
4. **`/clear` との関係**: `/clear` は SessionEnd + SessionStart をトリガーし、新しいセッション ID が生成される可能性が高い。そのため、タスク割り当て時に `/clear` + プロンプト送信ではなく、Claude プロセスの再起動が必要（案A/案C の方向性）
