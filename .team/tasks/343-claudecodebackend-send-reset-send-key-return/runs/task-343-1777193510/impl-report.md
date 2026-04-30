# T343 — claude-code-backend.ts send/reset に send-key return を追加

## サマリー

リファクタ commit `09492cf` で欠落していた `cmux send-key return` の呼び出しを `ClaudeCodeBackend.send()` / `reset()` に再導入した。これにより長文プロンプトが Claude Code TUI で確定されないバグを修正。`spawn()` のシェル経路は既存挙動を維持（\n で実行）。

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/claude-code-backend.ts` | `send()` / `reset()` を `cmux.send(raw)` → `cmux.sendKey(surface, "return")` の 2 段呼び出しに変更。`\n` 末尾は剥がす。`spawn()` の `cmux.send` 直前に TUI 経路と区別する 1 行コメントを追加（任意指示） |
| `skills/cmux-team/manager/claude-code-backend.test.ts` | 新規作成（14 ケース）。send / reset / spawn の cmux 呼び出し順序・引数を invocationCallOrder で時系列検証 |
| `skills/cmux-team/manager/conductor.test.ts` | T232 テストの assertion を更新（line 178 周辺）。`/clear\n` → `/clear` に修正し、`sendKey return` 呼び出しも検証 |

## テスト実行結果

### `claude-code-backend.test.ts`（新規）

```
14 pass / 0 fail / 47 expect() calls
```

主な検証項目:
- AC1: `send()` が `cmux.send(surface, body)` → `cmux.sendKey(surface, "return")` の順で呼ぶ（invocationCallOrder で時系列検証）
- 入力に `\n` 末尾がある／無い場合の `cmux.send` への引数（剥がし／そのまま）
- 80 char / 200 char の長文プロンプトでも同じ順序で確定される
- AC2: `reset()` が `/clear` → return → 500ms wait → prompt → return の 4 ステップで呼ぶ（経過時間 >= 450ms も検証）
- AC4: `spawn()` のシェル経路は `\n` 付き raw send のみで `sendKey return` を呼ばない
- `disposed` 後の `send` / `reset` は throw する

### `conductor.test.ts`（既存・assertion 更新）

```
38 pass / 0 fail / 144 expect() calls
```

T232（`assignTask 状態遷移`）の `/clear\n` 期待値を新挙動に追従させた以外、他のテストは無変更で全て green。

## AC1-AC5 達成状況

| AC | 内容 | 達成 |
|----|------|------|
| AC1 | 長文 prompt（80 char 以上）を `backend.send()` で送ると `cmux.send` → `cmux.sendKey(surface, "return")` の順 | ✅ `claude-code-backend.test.ts` の `AC1 (long prompt)` / `AC1 (long prompt + \n)` で検証 |
| AC2 | `backend.reset()` 経由で `/clear` → enter → 500ms wait → prompt → enter の順 | ✅ `claude-code-backend.test.ts` の `AC2: /clear → return → 500ms wait → prompt → return` で検証 |
| AC3 | 既存テスト（`conductor.test.ts` の `assignTask` ログ順序）が green | ✅ 38 / 38 pass。T232 テストの assertion を新仕様に追従させた |
| AC4 | `spawn()` のシェル起動経路は影響を受けない | ✅ `spawn()` のロジックは未変更（コメント 1 行追加のみ）。テストでも `sendKey return` が呼ばれないことを検証 |
| AC5 | 過去 2 日間に拾い損ねた他の `\n→enter` 依存箇所が無いことを grep で確認 | ✅ 後述の通り問題なし |

## AC5 — `cmux.send` 利用箇所の経路判定

`grep -rn 'cmux\.send' skills/cmux-team/manager --include='*.ts' | grep -v '\.test\.ts'` の結果を分類:

### シェル経路（`\n` で execute、修正不要）

| 箇所 | 用途 |
|---|---|
| `main.ts:2772` | `export ${exportVars} \n`（環境変数） |
| `main.ts:2777` | `cd ${worktreePath}\n` |
| `main.ts:2779` | `direnv allow 2>/dev/null\n` |
| `main.ts:2822` | `claudeCmd + "\n"`（claude CLI 起動） |
| `main.ts:4247` | `export CMUX_SURFACE=... \n`（abort-task 後の Conductor 再起動） |
| `main.ts:4249` | `cmux-team conductor\n`（同上） |
| `main.ts:4444` | `export CMUX_SURFACE=... \n`（reset-conductor） |
| `main.ts:4446` | `cmux-team conductor\n`（同上） |
| `master.ts:115` | `cmux-team spawn-master\n` |
| `claude-code-backend.ts:96` | `spawn()` の `export ${envStr}\n` |
| `claude-code-backend.ts:101` | `spawn()` の `launchCmd`（自動 `\n` 付加済） |

これらはすべて **シェルへのコマンド送信** であり、シェルは `\n` で execute するため `send-key return` は不要。

### TUI 経路（`send-key return` で確定が必要）

| 箇所 | 用途 | 状態 |
|---|---|---|
| `claude-code-backend.ts:125-126` | `send()` の `cmux.send(body)` + `cmux.sendKey(return)` | ✅ 本タスクで修正 |
| `claude-code-backend.ts:140-141` | `reset()` の `/clear` + `return` | ✅ 本タスクで修正 |
| `claude-code-backend.ts:144-145` | `reset()` の prompt + `return` | ✅ 本タスクで修正 |
| `claude-code-backend.ts:174, 177` | `reply()` の `return` / `q`（パーミッション応答） | ✅ 既に `sendKey` 経由 |
| `main.ts:3135 + :3138` | `send-agent` CLI（caller → target Agent への message 中継） | ✅ 既に `cmux.send(message)` 後 `cmux.sendKey(target, "return")` を呼ぶ実装（`--no-return` フラグ時のみスキップ） |

### 結論

**TUI 経路で `\n` 依存に取り残された箇所は無い。** 本タスクで修正した `claude-code-backend.ts` の `send()` / `reset()` 以外の TUI 経路（`reply()` / `send-agent`）は既に正しく `sendKey return` を呼んでいる。

## 設計判断

1. **`\n` 末尾の剥がしを backend 内部で行う**
   - 呼び出し側（conductor.ts 等）は引き続き「プロンプト末尾に `\n` を付けるか付けないか」を意識せずに済む。backend が一貫して raw text + send-key return に正規化する。
   - 旧実装の `message.endsWith("\n") ? message : `${message}\n`` の代わりに `slice(0, -1)` で剥がす対称的な実装にした。

2. **`spawn()` は据え置き**
   - シェルへのコマンド送信なので `\n` で execute される。タスク仕様通り変更不要。
   - TUI 経路との混同を避けるため、`cmux.send` 直前にコメント 1 行を追加（任意指示部分）。

3. **既存テスト T232 の assertion 更新**
   - 旧 assertion (`expect(sendSpy.mock.calls[0]?.[1]).toBe("/clear\n")`) は旧バグ込みの挙動を固定していたため、新仕様 (`/clear` + `sendKey return`) に追従させた。コメントも `M3-a` 由来から T343 を参照する説明に更新。
   - 行追加で `sendKey return` の呼び出しも併せて検証するようにした。

4. **テストでの呼び出し順序検証は `invocationCallOrder` を採用**
   - `sendSpy` と `sendKeySpy` は別々の mock のため、互いの相対順序は別配列の長さでは検証できない。Bun の mock が提供する `invocationCallOrder`（グローバル単調増加カウンタ）を使い、両 spy のイベントを単一タイムラインに統合して検証する。

## 残課題・懸念

- **無し**。実装・テスト・grep 確認すべて完了。
- 副次的観察: `main.ts:3135` の `send-agent` には `--no-return` オプションがあるが、これは「プロンプトを途中入力したまま enter を打たない」用途として意図的に分岐されており、本タスクのスコープ外。
- `T232` テストの T343 由来の assertion 変更は他の test/run には影響なし（同 file 内の closure に閉じている）。
