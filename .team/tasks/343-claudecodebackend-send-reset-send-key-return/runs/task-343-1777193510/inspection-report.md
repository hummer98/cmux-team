# T343 検品レポート

## 判定: NOGO

理由: 機能・テスト・grep は問題なく AC1〜AC5 はすべて満たすが、**新規追加された `claude-code-backend.test.ts` 内に tsc 新規エラーが 16 件**発生しており、検品項目「tsc 型エラー（必須）」の "self-touched ファイル基準で新規エラー無し" を満たさない。

## 検品結果

### コードレビュー

`skills/cmux-team/manager/claude-code-backend.ts` を直接確認。実装は仕様どおり：

- **`send()` (line 121-127)**: `disposed` チェック → `body = message.endsWith("\n") ? message.slice(0, -1) : message` で末尾 `\n` を剥がす → `cmux.send(surface, body)` → `cmux.sendKey(surface, "return")`。順序・引数とも正しい。
- **`reset()` (line 135-147)**: `disposed` チェック → `cmux.send(surface, "/clear")` (raw, no `\n`) → `cmux.sendKey(surface, "return")` → `setTimeout(500)` → prompt の `\n` 末尾剥がし → `cmux.send(surface, body)` → `cmux.sendKey(surface, "return")`。仕様どおり 4 ステップ。
- **`spawn()` (line 88-103)**: 既存挙動を維持。`launchCmd` が `\n` で終わらなければ自動付加し `cmux.send` のみ呼ぶ（`sendKey` は呼ばない）。`env` 指定時は `export ... \n` を先に送って 500ms 待つ。
- **JSDoc**: `send()` / `reset()` のコメントは新仕様（raw text + `sendKey return`、長文プロンプトは末尾 `\n` だけでは確定されない、500ms 待ち）と整合。`spawn()` line 99 に「シェル経路は `\n` で execute」のコメントが追加され TUI 経路との区別が明示されている。
- **`disposed` チェック**: `send` / `reset` 双方の冒頭で `if (this.disposed) throw new Error("ClaudeCodeBackend: already disposed")` が確認できる。

### テスト

manager ディレクトリで実行（CLAUDE.md の禁忌指定どおり対象ファイルのみ）。

| ファイル | 結果 |
|---|---|
| `claude-code-backend.test.ts` | **14 pass / 0 fail** (47 expect calls, 2.52s) |
| `conductor.test.ts` | **32 pass / 0 fail** (127 expect calls, 19.57s) ※`./conductor.test.ts` 指定時 |

- 順序検証は `bun:test` の `mock.invocationCallOrder` を使い、`sendSpy` と `sendKeySpy` を単一タイムラインに統合した上で比較しており適切（mock 配列長の比較ではない）。
- AC1 検証: `AC1: cmux.send → cmux.sendKey(return) の順で呼ぶ` で 2 イベントの kind / args / order を確認、さらに `AC1 (long prompt)` (120 char) / `AC1 (long prompt + \\n)` (200 char + `\n`) で長文ケースもカバー。
- AC2 検証: `AC2: /clear → return → 500ms wait → prompt → return の順で呼ぶ` で 4 イベントを `toMatchObject` で順序検証、加えて `elapsed >= 450ms` で 500ms wait も確認。
- AC4 検証: `spawn()` の 3 ケースで `sendKeySpy.mock.calls.length === 0`、env 指定時は `export ... \n` の先送りも検証。

### AC1-AC5

| AC | 達成 | 根拠 |
|---|---|---|
| AC1 | ✅ | `claude-code-backend.test.ts` の `AC1: cmux.send → cmux.sendKey(return) の順で呼ぶ` (line 52-64) と `AC1 (long prompt)` (line 82-93)、`AC1 (long prompt + \\n)` (line 95-102) の 3 ケースで順序を invocationCallOrder で検証。長文 (120 char / 200 char) でも順序維持を確認。 |
| AC2 | ✅ | `AC2: /clear → return → 500ms wait → prompt → return の順で呼ぶ` (line 112-127) で 4 イベントの kind/args を順序検証し、`elapsed >= 450ms` で wait も確認。長文版 `AC2 (long prompt)` (line 142-150) も pass。 |
| AC3 | ✅ | `conductor.test.ts` 32 / 32 pass。T232 (`assignTask 状態遷移`) の assertion を `/clear\n` → `/clear` + `sendKey return` の新仕様に追従させた diff を確認 (line 173-183)。 |
| AC4 | ✅ | `spawn()` の実装は未変更（コメント 1 行追加のみ）。テスト 3 ケースで `sendKeySpy.mock.calls.length === 0` を確認、`launchCmd` の `\n` 自動付加と `\n` 既存パスの分岐、env 経路 (`export ... \n` 先送り + 500ms wait) も検証。 |
| AC5 | ✅ | 下記 grep の通り、TUI 経路で `sendKey return` 後続漏れの箇所は無し。 |

### tsc

```
cd skills/cmux-team/manager && bunx tsc --noEmit
```

**新規エラー 16 件、すべて `claude-code-backend.test.ts` 由来**（既存エラーは 0 件）：

| 行 | エラー | 内容 |
|---|---|---|
| 40, 45 | TS2322 | `invocationCallOrder[i]` が `number \| undefined` で `number` に代入不可 |
| 58, 59, 60, 61, 62, 63 | TS2532 | `events[0]` / `events[1]` が `Object is possibly 'undefined'` |
| 89, 90, 91, 92 | TS2532 | 同上（長文プロンプトテストの `events[0]` / `events[1]`） |
| 167, 181, 192 | TS2345 | `spawn()` の引数オブジェクトに `role` / `prompt` / `workdir`（`SpawnOptions` の必須フィールド）が欠落 |

エラーはすべて self-touched ファイル（新規作成された `claude-code-backend.test.ts`）に帰属するため、**検品基準「self-touched ファイル基準で tsc 新規エラー無し」を満たさない**。

なお、`claude-code-backend.ts` / `conductor.test.ts` には新規 tsc エラー無し。

### grep (AC5)

```
grep -rn 'cmux\.send' skills/cmux-team/manager --include='*.ts' | grep -v node_modules | grep -v '\.test\.ts'
```

| 箇所 | 経路 | 評価 |
|---|---|---|
| `main.ts:2772, 2777, 2779, 2822, 4247, 4249, 4444, 4446` | シェル経路（`\n` で execute） | OK — 修正不要 |
| `master.ts:115` (`cmux-team spawn-master\n`) | シェル経路 | OK |
| `claude-code-backend.ts:96, 101` (`spawn()` 内 `export...\n` / `launchCmd`) | シェル経路 | OK — 既存挙動維持 |
| `claude-code-backend.ts:125-126` (`send()`) | TUI 経路 | ✅ 本タスクで修正 — `cmux.send(body)` → `cmux.sendKey(return)` |
| `claude-code-backend.ts:140-141, 144-145` (`reset()`) | TUI 経路 | ✅ 本タスクで修正 — `/clear` + return、prompt + return |
| `claude-code-backend.ts:174, 177` (`reply()`) | TUI 経路 | OK — 既に `sendKey` 直接呼び出し |
| `main.ts:3135, 3138` (`send-agent` CLI) | TUI 経路 | OK — `cmux.send(message)` 直後に `cmux.sendKey(targetSurface, "return")` を呼ぶ実装 (`--no-return` フラグ時のみスキップ) |

**TUI 経路で `\n→enter` 依存に取り残された箇所は無い。** Implementer のレポートと一致。

### git status / diff stat

```
modified:   skills/cmux-team/manager/claude-code-backend.ts          (+13/-6)
modified:   skills/cmux-team/manager/conductor.test.ts                (+6/-2)
new file:   skills/cmux-team/manager/claude-code-backend.test.ts      (新規 207 行)
```

- 変更ファイルは指示書（タスク背景）と完全一致。意図しない変更なし。
- `conductor.test.ts` の diff は T232 assertion の `/clear\n` → `/clear` 修正と `sendKey return` 検証追加のみ。問題なし。

### 設計判断のレビュー

- **`\n` 末尾剥がしを backend 内で行う判断**: 妥当。呼び出し側（conductor.ts 等）は引き続き `\n` の有無を意識せずに済み、backend が一貫して raw text + `sendKey return` に正規化する。`message.slice(0, -1)` による剥がしも `endsWith("\n")` ガード付きで安全。
- **`spawn()` 据え置き**: 妥当。シェル経路は `\n` で execute されるため変更不要。コメント追加で TUI 経路との区別を明示したのも好ましい。

## Fix Required (NOGO の場合のみ)

### 修正 1: invocationCallOrder の型ガード

- ファイル: `skills/cmux-team/manager/claude-code-backend.test.ts`
- 行: 40, 45
- 内容: `(sendSpy.mock as any).invocationCallOrder as number[]` で取得した配列の `[i]` access が `number | undefined` 型になる。`events.push({ ..., order: sendOrders[i]! })` のように non-null assertion を付けるか、`order: sendOrders[i] ?? 0` でフォールバックする（順序は前から順に push しているので非 undefined が保証される）。

### 修正 2: events[i] の null ガード

- ファイル: `skills/cmux-team/manager/claude-code-backend.test.ts`
- 行: 58, 59, 60, 61, 62, 63, 89, 90, 91, 92
- 内容: `events[0]`, `events[1]` の access が `noUncheckedIndexedAccess` で `undefined` の可能性ありとなる。直前で `expect(events.length).toBe(2)` (line 57, 88) を実行しているため実害はないが、tsc は narrow しない。`events[0]!.kind` のように non-null assertion を付ける、または分割代入 `const [first, second] = events; expect(first?.kind).toBe(...)` に書き換える。

### 修正 3: spawn() 呼び出しに必須フィールドを追加

- ファイル: `skills/cmux-team/manager/claude-code-backend.test.ts`
- 行: 167-170, 181-184, 192-196
- 内容: `ClaudeCodeSpawnOptions extends SpawnOptions` のため `role: SessionRole`, `prompt: string`, `workdir: string` が必須。実装 (`claude-code-backend.ts:88-103`) は `surface` / `launchCmd` / `env` しか参照しないため、テストでは型を満たすためのダミー値を渡せばよい：

  ```ts
  await backend.spawn({
    surface: SURFACE,
    launchCmd: "cmux-team conductor",
    role: "conductor",
    prompt: "",
    workdir: "/tmp",
  });
  ```

  3 箇所（line 167, 181, 192）すべてに同様の追加が必要。

### 補足

修正 1, 2 は実害のない型安全性のみの問題、修正 3 は将来 `SpawnOptions` の必須フィールドが実装で参照された場合にテストが現実とズレる潜在リスクがある。いずれも tsc を pass させるためには必須。
