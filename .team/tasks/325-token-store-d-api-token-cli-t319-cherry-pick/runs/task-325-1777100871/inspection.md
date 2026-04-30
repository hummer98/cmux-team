# Inspection Report — T325

## Verdict

- **GO**

critical / 必須項目はすべて pass。Option C 制約は遵守、auth_hash 12 文字 prefix 仕様も維持されている。test 設計は plan §2-A の 5 軸復旧パターン（readline / fetch / process.argv / process.exit / Keychain / HOME）に厳格に従っており、補強 2 ケースも plan §1.1 の指定通り追加されている。軽微な懸念（推奨 15 件未達 / 変更が unstaged のまま / `bun test` 一括実行は未実施）は plan / summary.md で既に明示・合意済みであり、本タスクの納品判断を妨げない。

## Test Run Results

| 検証 | 結果 |
|---|---|
| `bun test skills/cmux-team/manager/token-store.test.ts` | **68 pass / 1 skip / 0 fail / 134 expect** (Ran 69 tests, 1035ms) |
| `bun test skills/cmux-team/manager/token-cli.test.ts` | **13 pass / 4 skip / 0 fail / 52 expect** (Ran 17 tests, 93ms) |
| `bun test skills/cmux-team/manager/proxy.test.ts` | **36 pass / 0 fail / 136 expect** (Ran 36 tests, 1.91s) |
| `bun test skills/cmux-team/manager/daemon.test.ts` | **165 pass / 0 fail / 576 expect** (Ran 165 tests, 18.96s) |
| `bun test skills/cmux-team/manager/main.test.ts` | **148 pass / 0 fail / 396 expect** (Ran 148 tests, 11.79s) |
| `bunx tsc --noEmit -p tsconfig.json` | **エラー 0 件** (exit=0) |

token-cli.test.ts の active 13 件内訳: cmdTokenAdd 5 / cmdTokenList 2 / cmdTokenRemove 2 / cmdTokenRotate 1 / cmdTokenSetPlan 3 — plan §1.2 の見積もりと一致。skip 4 件はすべて R1〜R3 引用付き inline コメント記載。

## Critical Findings (NOGO の場合のみ)

該当なし。

## Compliance Check

### Option C 制約 (main token-cli.ts / proxy / spawn-agent 不変)

```
$ git diff main -- skills/cmux-team/manager/token-cli.ts \
                    skills/cmux-team/manager/proxy.ts \
                    skills/cmux-team/manager/spawn-agent.ts
(empty output)
```

→ 3 ファイルとも main から **完全に不変**。Option C 遵守を確認。

### auth_hash 12 文字 prefix 整合

token-cli.test.ts で `expect(tok?.auth_hash).toMatch(/^[a-f0-9]{12}$/)` を 3 箇所で assert（add/credentials 経路 line 278, manual 経路 line 396, rotate 経路 line 579）。abort 版の 64 hex regex への書き戻し誤りはない。

D 系列関数 (`updateTokenAuth`) は `auth_hash` の長さや形式に依存しない pure update 関数として実装されており、main 側 `computeAuthHash`（`token-cli.ts:34-36`）の 12 文字 prefix 仕様と非干渉。

### main 既存 schema との整合

token-store.ts の追加部分（`@@ -340,6 +340,51 @@`、`listTokens` 直後）:

- `deleteToken`: 1 transaction で `leases → usage_snapshots → tokens` の順に明示 DELETE。`ON DELETE CASCADE` なしの main schema に整合。
- `updateTokenAuth`: `UPDATE tokens SET auth_hash = ? WHERE id = ?` のみ。
- `updateTokenPlan`: `UPDATE tokens SET plan = ?, plan_ratio = ? WHERE id = ?` のみ — `selectable / tags / handle / organization_id / auth_hash` は維持。

3 関数とも abort 版から copy 通りで、main の既存 export (`getTokenByAuthHash` line 325 等) との衝突はない。

### skip 理由の妥当性

| skip テスト | 引用リスク | 妥当性 |
|---|---|---|
| `cmdTokenAdd > tags=auto 警告` (line 408) | R1 | main の `cmdTokenAdd` (`token-cli.ts:117-235`) には tags=auto 警告分岐がない。Option C 遵守のため移植不能。妥当。 |
| `cmdTokenAdd > Keychain 失敗 → DB 巻き戻し` (line 413) | R3 | main に補償 tx なし。abort 版の `__setKeychainTestFailureMode` フックも main token-cli.ts に存在しない。妥当。 |
| `cmdTokenRotate > organization_id 不一致は exit 1` (line 590) | R2 | main の `cmdTokenRotate` (`token-cli.ts:351-398`) に org_id check 未実装。妥当。 |
| `cmdTokenRotate > Keychain 失敗 → 旧 auth_hash 復元` (line 594) | R3 | main の rotate に補償 tx なし。妥当。 |

4 件とも「main 側機能仕様の不在」を理由としており、Option C 制約下では正当な skip 判断。reviewer が独立検算可能な inline コメント形式で記載されている。

### plan §1.1 補強 2 件の取り込み

- **candidate 1** (`deleteToken: leases / usage_snapshots 片方が空でも tokens 削除`): token-store.test.ts:943-963 に追加 ✓
- **candidate 2** (`updateTokenAuth + getTokenByAuthHash の往復整合性`): token-store.test.ts:996-1006 に追加。`getTokenByAuthHash` は `import` 行 (line 18) にも追記 ✓

### plan §6 二大書き換えポイント

- **R7 auth_hash regex** → `/^[a-f0-9]{12}$/` に書き換え済み（3 箇所）
- **R9 credential_source** → `"claude-credentials"` (line 279) / `"manual"` (line 397) に書き換え済み

両ポイントとも abort 版から main 仕様への書き換え漏れなし。

### mock 5 軸復旧の検証

| 軸 | 実装箇所 | 評価 |
|---|---|---|
| readline | top-level `mock.module("readline", ...)` (line 47-55) + closure `askAnswers` を `setReadlineAnswers` で詰め替え | hoisting 対策 (R5) を plan §2-A-Pre 通り採用 |
| fetch | `withMockedFetch` ヘルパ (line 197-210) で `try/finally` 退避・復元 | R4 / §8 通り `mock.module` を使わない安全 pattern |
| process.argv | `beforeAll` で `originalArgv = process.argv.slice()` (line 111) + `afterEach` で `process.argv = originalArgv.slice()` 完全置換 (line 169) | R8 の fresh copy 代入を厳守 |
| process.exit | `TestExitError` 例外化 (line 104-108, 163-165) + `afterEach` で `process.exit = originalExit` 復元 | abort 版と同パターン |
| Keychain | `process.env.KEYCHAIN_TEST_MODE = "1"` + `__resetInMemoryKeychainForTest()` を `beforeEach` で呼び出し | token-store.ts の in-memory mode 経路を活用 |
| HOME / homedir | `process.env.HOME = testDir` に加えて `mock.module("os", ...)` で `homedir()` を override (line 57-62) | summary.md「実装上の知見」で plan §2-A の HOME 経路だけでは不足と明示。Bun の `os.homedir()` 動的不変問題への対症処理として妥当 |

`afterEach` (line 168-187) で全軸を完全に復元しており、test 間の副作用混入リスクは抑えられている。`afterAll` (line 125-137) でも同様に originalEnv / fetch / console / stdout を復元。

## Quality Findings (Fix Required)

該当なし。

## Quality Findings (Suggested)

1. **推奨 15 件には未達（active 13 件）**  
   plan §0 / design-review §残リスク 1 で既に許容済み。本タスクの blocker ではないが、もし Master が「推奨ライン到達」を求める場合の追加候補は、design-review §残リスク 1 が示す通り (a) `cmdTokenList` の plan_ratio 表示まわり、(b) `cmdTokenSetPlan` の plan_ratio 連動、(c) `cmdTokenRotate` の `credential_source` 維持確認。フォローアップタスクで対応する位置づけが妥当。

2. **変更が unstaged**  
   `git status` 上、3 ファイル（token-store.ts modified / token-store.test.ts modified / token-cli.test.ts untracked）はすべて未コミット。後段で Conductor がコミット・PR 作成を担う想定だが、検品時点でコミットツリーに載っていないため、PR レビュー時に必ずこの 3 ファイル + 行数（+45 / +165 / +667）が反映されていることを確認すべき。

3. **`bun test` 全体実行は未実施**  
   summary.md にて「`direnv-check.test.ts` / `envrc-prompt.test.ts` 系の副作用テストが長時間スピンするため個別実行に切り替え」と明示されている。本検品でも token-store / token-cli / proxy / daemon / main の 5 ファイルを個別実行し regression なしを確認。`grep -rn "deleteToken\|updateTokenAuth\|updateTokenPlan" --include="*.ts"` 結果は token-store.ts / token-cli.ts / token-store.test.ts の 3 ファイルのみで、token-cli.ts は `deleteTokenFromKeychain` 用途のみ（D 系列 production consumer は 0 件、R11 の通り）。影響範囲は 5 ファイルに収まると判定でき、追加 regression リスクは低い。

4. **D 系列 3 関数の production consumer 不在 (R11)**  
   `cmdTokenRemove` は引き続き直接 SQL で 3 連発削除（`token-cli.ts:331-333` 想定）しており、本タスクで追加した `deleteToken` は CLI 経路で呼ばれない。plan §5 完了条件 #6（`T319 D系列を cmdTokenRemove に配線する` フォローアップ起票）が必須。summary.md の「フォローアップタスク（推奨）」セクションに記載済みだが、Conductor / Master が起票を忘れると dead code 化リスクが残る。

5. **手動検証 #3 (remove → 即 add 同 handle) は部分確認**  
   summary.md で「テストの分割確認に留まる」と自己申告。Keychain test mode の in-memory 経路では検証されているが、本物 macOS Keychain での失敗ケースは plan §残リスク 4（design-review §残リスク 4）の通り Option C 制約上カバー困難。フォローアップ補償 tx タスクで吸収する設計。

## 検証コマンド実行ログ抜粋

### git diff (Option C 確認)

```
$ git diff main -- skills/cmux-team/manager/token-cli.ts \
                    skills/cmux-team/manager/proxy.ts \
                    skills/cmux-team/manager/spawn-agent.ts
(no output — files unchanged)

$ git diff main -- skills/cmux-team/manager/token-store.ts | head
diff --git a/skills/cmux-team/manager/token-store.ts b/skills/cmux-team/manager/token-store.ts
index 83e0bee..f8d9064 100644
--- a/skills/cmux-team/manager/token-store.ts
+++ b/skills/cmux-team/manager/token-store.ts
@@ -340,6 +340,51 @@ export function listTokens(
   return rows.map(rowToToken);
 }
 
+/**
+ * tokens / usage_snapshots / leases から token_id に紐付く全レコードを削除する。
...
```

→ 追加 +45 行（D 系列 3 関数のみ）、`listTokens` 直後・`usage_snapshots` セクション直前という plan §1.1 指定位置に配置。

### bun test (token-store)

```
$ bun test skills/cmux-team/manager/token-store.test.ts
bun test v1.3.12 (700fc117)

 68 pass
 1 skip
 0 fail
 134 expect() calls
Ran 69 tests across 1 file. [1035.00ms]
```

既存 57 + 新規 11 = 68 pass。1 skip は既存（D 系列 11 ケースには skip なし）。

### bun test (token-cli)

```
$ bun test skills/cmux-team/manager/token-cli.test.ts
bun test v1.3.12 (700fc117)

 13 pass
 4 skip
 0 fail
 52 expect() calls
Ran 17 tests across 1 file. [93.00ms]
```

最低基準 12 件を超え、推奨 15 件には未達（plan §R1 で許容済み）。skip 4 件は R1/R2/R3 inline コメント付き。

### bun test (regression)

```
$ bun test skills/cmux-team/manager/proxy.test.ts
 36 pass / 0 fail / 136 expect() calls

$ bun test skills/cmux-team/manager/daemon.test.ts
 165 pass / 0 fail / 576 expect() calls

$ bun test skills/cmux-team/manager/main.test.ts
 148 pass / 0 fail / 396 expect() calls
```

T320 / T321 / Manager 配線への regression なし。

### tsc --noEmit

```
$ bunx tsc --noEmit -p tsconfig.json
exit=0 (no output)
```

型エラー 0 件。

### grep (D 系列の参照箇所)

```
$ grep -rn "deleteToken\|updateTokenAuth\|updateTokenPlan" \
        skills/cmux-team/manager --include="*.ts" -l
token-store.ts
token-cli.ts
token-store.test.ts

$ grep -n "deleteToken\|updateTokenAuth\|updateTokenPlan" \
        skills/cmux-team/manager/token-cli.ts
22:  deleteTokenFromKeychain,
337:    deleteTokenFromKeychain(handle);
```

token-cli.ts は `deleteTokenFromKeychain`（Keychain 用、別系統）のみ。本タスクで追加した `deleteToken / updateTokenAuth / updateTokenPlan` への参照は 0 件 = plan §R11 (production consumer 不在) を裏付け。フォローアップ起票が必須。

### git status

```
$ git status --short
 M skills/cmux-team/manager/token-store.test.ts
 M skills/cmux-team/manager/token-store.ts
?? skills/cmux-team/manager/token-cli.test.ts
```

3 ファイルとも unstaged。本検品は実装内容のレビューであり、コミット・PR 作成は後段 Conductor の責務。
