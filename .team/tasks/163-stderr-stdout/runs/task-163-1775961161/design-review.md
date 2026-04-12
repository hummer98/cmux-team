# Design Review: Task 163

## 判定: Changes Requested

軽微な実装上の不整合・抜け漏れがあるため修正後 Approved。方針自体は妥当で、影響範囲もほぼ網羅できている。

## 観点別評価

### 1. 方針の妥当性: ✅ 妥当

ラッパー（`runCmux`）内で stderr/stdout を含む新しい `Error` を throw する方針は適切。

- 呼び出し元（`e.message` 参照箇所 30+）の改修ゼロで原因情報がログに伝播する
- `cause` チェーンと `__cmuxWrapped` フラグで原因 Error も追跡可能
- 二重 wrap 防止フラグの導入意図も妥当

### 2. 影響範囲の網羅性: ✅ ほぼ網羅（独立 grep 確認済み）

worktree 内で `execFile|execFileSync` を grep した結果、計画の A〜F 節と一致：

| ファイル | 計画記載 | grep 結果 | 評価 |
|---------|---------|----------|------|
| `cmux.ts` | 14 箇所 | 14 箇所（line 16, 27, 36, 48, 59, 69, 75, 84, 93, 102, 160, 179, 192, 200） | ✅ 一致 |
| `conductor.ts` | 7 箇所 | 7 箇所（247, 280, 288, 391, 396, 437, 447） | ✅ 一致 |
| `daemon.ts` | 2 箇所 | 2 箇所（1122, 1133） | ✅ 一致 |
| `main.ts` | 6 箇所 | 6 箇所（66, 293, 305, 892, 961, 1017, 1662, 1673）※305/1673 は補助系 | ✅ 列挙 OK |
| `preflight.ts` | 1 箇所 | 1 箇所（29） | ✅ 一致 |
| `dashboard.tsx` / `trace-store.ts` | 計画外 | execFile を含まない（grep の false positive — `executable` 等の単語ヒット） | ✅ 計画外で正しい |
| `e2e.ts` | 対象外と明記 | テストハーネス | ✅ OK |

### 3. 既存テストとの整合: ✅ 影響なし

- `cmux.test.ts` は `validateSurface` のリトライ動作を fake cmux で検証している。`runCmux` ラッピング後も内部で catch → リトライ → false 返却の挙動は不変なので壊れない
- `daemon.test.ts:704` は execFile を import しているのみ、`preflight.test.ts` はテスト用 git init で execFile を使うため、いずれもラッパー化と無関係
- 新規追加するテスト（fake cmux で stderr → throw された Error.message に `stderr=...` が含まれること）は適切

### 4. ログフォーマット: ⚠️ 妥当だが一点要注意

- ` | ` 区切り、改行 → スペース、空文字省略、2KB 切り捨ては「1 行 1 イベント」ルールに準拠しており妥当
- ただし呼び出し元の既存ログ（`logger.ts` の `key=value` 形式）と組み合わさると、`last_error=Command failed: ... | stderr=... | stdout=` の `... | stderr=...` 部分は `key=value` パターンの解釈境界が曖昧になる。実害はないが、ログ解析する場合 `last_error` の値がスペースを含む末尾値である前提を維持する必要あり
- 2KB 切り捨ては妥当（行末 `...(truncated)` マーカーで明示）

### 5. リスク対策: ⚠️ 実装に明示的反映が必要

| リスク | 計画の対策 | 評価 |
|---|---|---|
| 機密情報マスキング | optional 扱い | 現状 cmux/git/npm/direnv の標準出力に Bearer/API キーが乗らないため optional で問題なし。ただし `ANTHROPIC_BASE_URL` 経由の proxy エラーが将来 stderr に出ないかは別途確認を |
| 二重ラップ防止 | `__cmuxWrapped` フラグで判定 | Step 1 のサンプルコードに該当ロジックが書かれていない。**実装時に必ず追加すること** |
| Buffer/string 揺れ | `sanitizeForLog` で両対応 | OK（execFileSync の `e.stdout`/`e.stderr` は Buffer のため必須） |

## Recommendations

以下を実装段階で反映してください：

1. **二重ラップ防止フラグの実装明記**
   `runCmux` ヘルパーの冒頭で `if ((e as any).__cmuxWrapped) throw e;` を入れ、wrap 後の Error には `(wrapped as any).__cmuxWrapped = true;` を立てる。Step 1 サンプルコードに追記すること。

2. **`formatExecError` 共通化の徹底**
   計画では「`logger.ts` 隣に `exec-error.ts` を新設」とあるが、Step 1 の `runCmux` 内には `sanitizeForLog` がインライン実装されている。共通化するなら `runCmux` も新設の `formatExecError` / `sanitizeForLog` を import して使うよう統一すること（重複実装を残さない）。

3. **`preflight.ts` の対応方針を明確化**
   `checkGitRepo`（line 27-43）は catch で `PreflightIssue` を返すのみで `log()` 呼び出しがない。stderr を含めるなら `issue.context` または `issue.hint` に追記する形になる。「ログする」のではなく「issue メッセージに混ぜる」という設計判断を明示し、必要性の薄い場合は対象外として除外しても良い。

4. **`daemon.ts:1133` の `npm install -g` callback**
   現状 `(err)` のみで `stdout`/`stderr` を捨てており、計画でも `(err, stdout, stderr)` への変更は記載済み。**併せて成功時にも更新が走った旨をログすべき**（現状ログがゼロのため、自動更新が動いたか不明になる）。これは Task 163 のスコープ外だが、同じ箇所を触るので付随対応として推奨。

5. **`main.ts` の execFileSync catch のうち未 catch 箇所**
   line 66（startup の `npm prefix -g`）と line 892/961/1017（`claude` spawn）は現状 try/catch があるか不明。catch がない箇所は throw が上位に伝播するため stderr が message に含まれていれば自然にログに乗るが、明示的に検証して計画の Step 5 で「catch 追加」が必要かどうかを判定すること。

6. **テスト追加箇所の具体化**
   Step 7.1 のユニットテストは `tree()` で stderr 検証する案だが、`tree()` は `validateSurface` 経由で 3 回リトライするためテスト時間が延びる。代わりに `send()` や `setStatus()` 等の即時 throw 系で検証する方が高速。
