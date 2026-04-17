# 実装計画書: Conductor の cmux send / send-key を PreToolUse hook でブロック

関連 issue: hummer98/cmux-team#21
対象ファイル: `skills/cmux-team/manager/main.ts`（`generateConductorSettings` 関数）

## 1. 背景と目的

Conductor は Agent を起動するとき **`cmux-team spawn-agent`** を使うべきだが、生の `cmux send` / `cmux send-key` を直接呼び出して他 surface を操作するケースが発生している。

これは `conductor-role.md` に自然言語で禁止事項として書かれているだけで、実行時に強制する仕組みがない。PreToolUse hook で Bash tool 実行前に `cmux send` / `cmux send-key` を検出して `exit 2` でブロックする。

## 2. 既存実装の現状

`skills/cmux-team/manager/main.ts` の `generateConductorSettings(projectRoot, surface)`（L765 付近）は、既に以下の hooks を注入している：

- `SessionStart` (matcher: "startup") → `cmux-team send SESSION_STARTED`
- `Stop` (matcher: "") → `cmux-team send SESSION_IDLE`
- `SessionEnd` (matcher: "clear" / "logout|prompt_input_exit") → `cmux-team send SESSION_CLEAR` / `SESSION_ENDED`

生成される JSON は `.team/prompts/<surface>-settings.json` に書き出され、`claude --settings <path>` で読み込まれる。

`PreToolUse` は未定義なので、今回ここに追加する。

## 3. Claude Code PreToolUse hook の仕様

- フック実行時、stdin に JSON が渡される。形式は `{"tool_name": "Bash", "tool_input": {"command": "..."}, ...}`
- コマンドの exit code:
  - `0` → pass（ツール実行続行）
  - `2` → block（ツール実行を中止し、stderr の内容を Claude に表示）
  - それ以外 → 警告扱い（pass）
- `matcher` に tool 名を書くと、その tool だけフックが動く。`"Bash"` を指定して Bash tool のみ対象にする。
- `command` は shell コマンドとして評価される（`type: "command"`）。既存の hooks 同様 `bash -c '...'` で記述する。

## 4. ブロック対象の設計

### 4.1 ブロックするパターン

`tool_input.command` が以下の **いずれか** にマッチしたら block する（単語境界で判定）：

| 正規表現 | マッチ例 |
|---------|---------|
| `\bcmux[[:space:]]+send[[:space:]]` | `cmux send <surface> ...`, `cmux  send foo` |
| `\bcmux[[:space:]]+send-key[[:space:]]` | `cmux send-key <surface> return` |

### 4.2 通すパターン（重要）

- **`cmux-team send`** / **`cmux-team spawn-agent`** / **`cmux-team send-key`** — `cmux-team` は別バイナリ（hyphen 付き）。`\bcmux[[:space:]]+` は `cmux ` にしかマッチしないので `cmux-team` は自然に除外される。
- **`cmux read-screen` / `cmux tree` / `cmux list-status` / `cmux close-surface` / `cmux identify` / `cmux new-split` / `cmux rename-tab`** — 読み取り系・レイアウト系は subcommand が `send` / `send-key` ではないので通る。
- **pipe / grep 等に埋め込まれた文字列** — 例: `grep "cmux send" file.log` は **ブロックしたくない** が、単純な正規表現では誤検知する。
  - **判定の簡略化**: `tool_input.command` は Claude がこれから実行するコマンド全体。Conductor が文字列検索で `cmux send` を grep するケースは稀で、誤検知を許容する方がリスクが低い（誤検知時は「grep のクォート外し」等で回避可能、代替案を stderr で案内する）。
  - 将来必要になれば「行頭 or `;` `&&` `||` `|` 直後のみ」という追加条件を入れて強化する余地を残す。

### 4.3 stdin 解析方法

hook 内で `tool_input.command` を抽出する。jq の可用性は環境依存なので、**jq 依存を避けて bash + grep** で実装する：

```bash
bash -c '
  input="$(cat)"
  # tool_input.command を雑に抽出（Claude Code stdin は1行JSON想定）
  cmd="$(printf "%s" "$input" | grep -oE "\"command\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed -E "s/^\"command\"[[:space:]]*:[[:space:]]*\"//; s/\"$//")"
  if printf "%s" "$cmd" | grep -qE "(^|[^-[:alnum:]_])cmux[[:space:]]+(send|send-key)([[:space:]]|$)"; then
    echo "cmux send / cmux send-key は Conductor から使用禁止です。エージェント起動は cmux-team spawn-agent を使ってください。" >&2
    exit 2
  fi
  exit 0
'
```

**ポイント**:
- `(^|[^-[:alnum:]_])cmux` で `cmux-team` の `-` を除外（`-` は `[^-...]` で弾かれる）
- `(send|send-key)` の直後に space or 行末を要求し、`sender` のような誤マッチを防ぐ
- JSON パースを簡易化するため `grep -oE` で `"command":"..."` 部分だけ抜き出す（ネストされた JSON や escape された `\"` を含むコマンドには弱いが、Bash tool のコマンドにそのような内容は通常含まれない）

**懸念と代替**: JSON 抽出の堅牢性が必要なら Node.js 1-liner (`node -e '...'`) で parse してもよい。ただし Node 起動コストで hook が遅くなる。Impl フェーズで計測し、grep 版で問題があれば切り替える。

## 5. 実装変更点

### 5.1 `generateConductorSettings` への追加

`conductorSettings.hooks` に以下を追加：

```ts
PreToolUse: [
  {
    matcher: "Bash",
    hooks: [{
      type: "command",
      command: "bash -c '<上記スクリプト>'",
      timeout: 3000,
    }],
  },
],
```

既存の `SessionStart` / `Stop` / `SessionEnd` と同じオブジェクト内に同居させる。

### 5.2 エラーメッセージ

```
cmux send / cmux send-key は Conductor から使用禁止です。エージェント起動は cmux-team spawn-agent を使ってください。
```

Claude は stderr をそのまま読んで次の行動を決めるので、**代替手段を明示する** のが重要。

### 5.3 Bash タイムアウト

- hook 実行時間が長いと tool 実行が遅延するため `timeout: 3000`（3秒）。
- 通常は数ミリ秒で完了する想定。

## 6. テスト方針

### 6.1 単体テスト（Impl が書く）

`generateConductorSettings` を直接呼んで戻り値のパスを読み、JSON を parse して以下を assert：

- `hooks.PreToolUse` が配列として存在
- `[0].matcher === "Bash"`
- `[0].hooks[0].command` に `cmux` / `send` / `exit 2` の文字列が含まれる
- 既存の `SessionStart` / `Stop` / `SessionEnd` が残っていること（regression 防止）

### 6.2 hook スクリプト単体の挙動確認

hook の shell コマンドを `bash -c '...'` で直接実行し、stdin に擬似 JSON を流してブロック/パスを検証：

| 入力 `tool_input.command` | 期待 exit code | 期待 stderr |
|--------------------------|--------------|------------|
| `cmux send surface1 hello` | 2 | 禁止メッセージ |
| `cmux send-key surface1 return` | 2 | 禁止メッセージ |
| `cmux-team spawn-agent implementer` | 0 | なし |
| `cmux-team send SESSION_STARTED` | 0 | なし |
| `cmux read-screen surface1` | 0 | なし |
| `cmux tree` | 0 | なし |
| `echo "cmux send something"` | **2（誤検知、許容）** | 禁止メッセージ |

最後の誤検知ケースは「docs/spec の確認」ではドキュメント化するだけで、Impl ではそのまま通す。

### 6.3 E2E（手動）

1. `cmux-team start` で Conductor を起動
2. 生成された `.team/prompts/<surface>-settings.json` に `PreToolUse` が入っていることを確認
3. Conductor に `cmux send other-surface hello` を実行させる prompt を投げ、ブロックされることを確認
4. `cmux-team spawn-agent` で通常のエージェント起動が動くことを確認

## 7. 実装上の懸念

| 懸念 | 対応 |
|------|------|
| 既存 Conductor は起動時の settings.json を読み込むため、hook 追加の効果は **再起動後** に初めて適用される | ドキュメントに明記。`cmux-team stop` → `start` が必要。 |
| hook が誤動作して全 Bash をブロックすると Conductor が詰む | 正規表現を厳密に書き、テストで `ls`, `git status`, `npm test` 等の一般コマンドが通ることを確認する |
| jq 非依存にしたが grep による JSON 抽出の脆さ | command に `"` や `\n` を含む入力は通常来ない想定。問題があれば Node 1-liner に切替 |
| Master 側にも同じ制約が必要になる可能性 | 今回の scope 外。必要なら別 issue で `generateMasterSettings` にも同じ hook を追加。Conductor 問題が先に顕在化しているので Conductor だけを対象にする |
| `cmux-team send` 内部で `cmux send` を子プロセスとして呼ぶ設計 | hook は Claude Code の Bash tool だけに作用する。`cmux-team` バイナリ内部の子プロセスは hook 対象外なので影響なし |

## 8. 納品物

- `skills/cmux-team/manager/main.ts` の `generateConductorSettings` に `PreToolUse` hook 追加
- 単体テスト（`skills/cmux-team/manager/*.test.ts` の既存構成に合わせる。既存テストが無い場合は Impl が判断）
- CHANGELOG.md に「Conductor の `cmux send` / `cmux send-key` を hook でブロック」エントリ追加
- コミットメッセージ: `feat(conductor): block cmux send/send-key via PreToolUse hook (#21)`

## 9. 実装しないこと（out of scope）

- `cmux-team send-key` のような `cmux-team` サブコマンド側の制限
- Master / Agent セッションへの同hook展開
- `conductor-role.md` からの禁止事項記述の削除（hook で強制されても文書での説明は残す）
- jq を使った堅牢な JSON パーサへの置換（必要になってから）
