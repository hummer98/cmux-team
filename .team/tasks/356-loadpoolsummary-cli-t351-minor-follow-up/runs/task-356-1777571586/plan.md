# T356 実装計画 — loadPoolSummary 失敗時の CLI ログ復元

- 対象タスク: T356 / minor follow-up of T351
- 作業 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-356-1777571586`
- 関連 commit: `935b2a3` (T351 Step 2、旧 in-line ロジック削除)

## 1. 課題分析

### 現状の問題点

`cmux-team status` 実行時に tokens.db が破損したり読み取り権限が無いと、ユーザーに**何も表示されない**まま pool セクションが消える。OFF と区別できないため、ユーザーは「pool 機能が無効化されたのか」「DB 破損なのか」を判別できない。

### 根本原因

T351 のリファクタで旧 in-line catch (`main.ts:1485-1487`)

```ts
} catch (e: any) {
  console.log(`  (token pool read failed: ${e?.message ?? e})`);
  poolHandleData = null;
}
```

を `pool-summary.ts:139-159` の `loadPoolSummary` に集約した際、内部 catch (`pool-summary.ts:156-158`) を以下のように silent fallback にしてしまった:

```ts
try {
  const db = initTokenDB();
  const policy = await buildSelectTokenPolicy(projectRoot);
  return buildPoolSummary(db, nowIso, policy);
} catch {
  return null;          // ← 失敗を握りつぶし
}
```

CLI 側 (`main.ts:1484-1492`) は `null` を「OFF と同じ」として扱うため、エラーが消滅する。

### 影響範囲

| 経路 | 失敗時の挙動 | 評価 |
|------|------------|------|
| daemon (`refreshPoolSnapshot` / `daemon.ts:434-445`) | `state.pool=null` + `log("error", "refreshPoolSnapshot failed: …")` | OK（manager.log に痕跡） |
| CLI (`loadPoolSummary` 経由 / `main.ts:1484`) | `null` を返すだけで何も出力せず | **NG（旧挙動からのリグレッション）** |

daemon は `buildPoolSummary` を直接呼ぶため、本タスクで修正対象になるのは **CLI 経路 (`loadPoolSummary` + `cmdStatus`)** のみ。

## 2. 技術アプローチ

### 採用方針: callback 注入 (`onError?: (e: Error) => void`)

**Decision: callback 案を採用する。** 比較は §7 Decision Log 参照。

#### 設計

`loadPoolSummary` の signature を以下のように変更:

```ts
export async function loadPoolSummary(
  projectRoot: string,
  nowIso?: string,
  options?: { onError?: (e: Error) => void },
): Promise<PoolSummary | null>
```

- gate (`isTokenPoolEnabled`) 失敗 → 従来どおり silent OFF（`onError` を呼ばない）。これは「設定が読めない=OFF として安全側に倒す」設計意図を保つ。
- build (`initTokenDB` / `buildSelectTokenPolicy` / `buildPoolSummary`) 失敗 → `onError(e)` を呼んでから `null` を返す。`onError` 未指定なら従来どおり silent。

ホワイト・ブラック双方の callback 例:

```ts
// CLI (main.ts cmdStatus) — 旧挙動を復元
const poolSummary = await loadPoolSummary(PROJECT_ROOT, undefined, {
  onError: (e) => console.log(`  (token pool read failed: ${e?.message ?? e})`),
});

// daemon は loadPoolSummary を呼ばないので影響なし（buildPoolSummary を直接利用）
```

### 既存パターンとの整合性

| パターン | 例 | 本変更との整合 |
|---------|----|--------------|
| daemon 側 catch | `daemon.ts:434-445` で `try { … } catch (e) { log("error", …); }` | `loadPoolSummary` は CLI 専用 wrapper なので daemon 経路には触れない（`buildPoolSummary` は signature 据え置き） |
| `cmdStart` の token DB open | `try { state.tokenDb = initTokenDB(); } catch (e: any) { log("error", `initTokenDB failed: ${e?.message ?? e}`); }` | 同じ `?.message ?? e` フォーマットを CLI 側でも踏襲する |
| `loadPoolSummary` 既存の gate catch | `try { isTokenPoolEnabled } catch { enabled = false; }` | この catch は維持（OFF 同等扱い） |

cmux-team の支配的パターンは「**呼び出し側が log の流路を決める**」(daemon は `log("error", …)` / CLI は `console`)。callback 注入はこの分離をライブラリ側で受け止める最小手段になる。

### 旧 console.log フォーマット復元

旧 commit `935b2a3` 削除前の文字列をそのまま再現する:

```text
  (token pool read failed: <e?.message ?? e>)
```

- 先頭 2 スペース インデント（旧コードと一致、`main.ts` の他 pool 行と揃う）
- 失敗詳細は `e?.message ?? e` を直挿入（旧実装と同じテンプレート）
- i18n 化はしない（旧実装も hard-coded、`t()` キー追加は scope outside）

## 3. 変更対象

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/pool-summary.ts` | `loadPoolSummary` に第 3 引数 `options?: { onError?: (e: Error) => void }` を追加。内部 build catch を `(e) => { options?.onError?.(e instanceof Error ? e : new Error(String(e))); return null; }` に修正。JSDoc の「DB open / read / policy 解決で例外が出たら null を返す」記述に「`onError` が渡されていれば呼ぶ」を追記 |
| `skills/cmux-team/manager/main.ts` (`cmdStatus` / 1484 行付近) | `loadPoolSummary` 呼び出しに `{ onError: (e) => console.log(`  (token pool read failed: ${e?.message ?? e})`) }` を渡す |
| `skills/cmux-team/manager/pool-summary.test.ts` | 新規 case G: tokens.db 破損 → `onError` が呼ばれ、戻り値が `null` になる。新規 case H: `onError` 未指定 → throw せず `null` 返却（後方互換）。新規 case I: gate 失敗 (`tokenPool.enabled=false`) → `onError` を呼ばずに `null`（gate と build の挙動分離保証） |
| daemon 呼び出し側 (`daemon.ts:434-445`) | **変更なし**（`buildPoolSummary` 直呼びで `loadPoolSummary` は経由しない） |

## 4. サブタスク分割

### S1. `loadPoolSummary` に `onError` callback を追加

- 対象: `skills/cmux-team/manager/pool-summary.ts:139-159`
- 完了条件:
  - signature が `(projectRoot, nowIso?, options?: { onError?: (e: Error) => void }) => Promise<PoolSummary | null>` になる
  - 内部 build catch で `options?.onError?.(...)` を呼ぶ
  - gate catch は `onError` を呼ばない（silent OFF 維持）
  - 既存呼び出し（main.ts、test）が引数追加なしでもコンパイルできる（後方互換）
- 検証: `bunx tsc --noEmit`（pool-summary.ts / main.ts エラー 0）

### S2. CLI `cmdStatus` で旧挙動を復元

- 対象: `skills/cmux-team/manager/main.ts:1484` 行
- 完了条件:
  - `loadPoolSummary(PROJECT_ROOT, undefined, { onError: (e) => console.log(`  (token pool read failed: ${e?.message ?? e})`) })` の形に書き換わる
  - 失敗時は warning 1 行のみ出力し、後続 (Master / Conductors / Tasks / Rate Limit セクション) はそのまま続く（旧挙動と同じ）
- 検証: 手動確認 — tokens.db を欠損させた状態で `cmux-team status` を実行し、warning が出てかつ status 全体は完走することを確認。`bun build skills/cmux-team/manager/main.ts --outfile=/dev/null --target=bun` でビルド確認

### S3. 単体テストの追加

- 対象: `skills/cmux-team/manager/pool-summary.test.ts`
- 追加する case:
  - **case G (build failure に onError が呼ばれる)**: `.team/config.json` で `tokenPool.enabled=true` にし、`CMUX_TEAM_TOKENS_DB` (もしくは projectRoot 配下に書き込み不可な tokens.db を配置) で `initTokenDB` が throw する状況を作る。`onError` モックで呼び出しを captured し、`expect(captured).toHaveLength(1)` & `expect(returned).toBeNull()`
  - **case H (callback 未指定で silent fallback)**: 同条件で `onError` 渡さずに `loadPoolSummary` を呼ぶ → throw せず `null` を返す
  - **case I (gate OFF では onError を呼ばない)**: `.team/config.json` で `enabled=false` & env で OFF。`onError` モックを渡しても呼ばれない（既存 case F の派生でよい）
- DB 破損の再現は **mock 経由ではなく実 DB 経路** で行う:
  - 候補 1: `initTokenDB` の dirPath を read-only に chmod
  - 候補 2: 環境変数 `CMUX_TEAM_TOKENS_DB` を不正パス（ディレクトリを指す等）に設定
  - 候補 3: tokens.db の中身を非 SQLite なゴミバイトで上書き → `listTokens` 等で throw
  - **第一候補は 3** （SQLite open 自体は通って query 時に throw、real-world 破損に近い）。実装段階で安定する手段を実装者が選択し、選択理由を report.md に書く
- 完了条件: 上記 3 case が PASS。既存 case A〜F は無修正で継続 PASS
- 検証コマンド:
  ```bash
  cd /Users/yamamoto/git/cmux-team/.worktrees/task-356-1777571586/skills/cmux-team/manager
  bun test --timeout 30000 pool-summary.test.ts
  ```

### S4. 全体 regression 確認

- 完了条件:
  - `bunx tsc --noEmit` がエラー 0 を維持
  - `pool-summary.test.ts` / `pool-cli.test.ts` / `pool-status-header.test.ts` が PASS
- 検証コマンド:
  ```bash
  cd /Users/yamamoto/git/cmux-team/.worktrees/task-356-1777571586/skills/cmux-team/manager
  for f in pool-summary.test.ts pool-cli.test.ts pool-status-header.test.ts pool-throttle.test.ts; do
    bun test --timeout 30000 "$f" || break
  done
  bunx tsc --noEmit
  ```

> Note: CLAUDE.md 既知注意点に従い `bun test` 全体実行は禁忌。pool 関連の test ファイルのみを順次実行する。

## 5. リスク

| ID | リスク | 影響 | 対策 |
|----|--------|------|------|
| R1 | daemon 経路で挙動変化 | 高（refreshPoolSnapshot の log("error") が二重発火 / 消滅する） | daemon は `buildPoolSummary` を直呼びしており `loadPoolSummary` は経由しない (grep 検証済み: §1 影響範囲表)。本変更の対象外で挙動不変 |
| R2 | tokens.db 破損テストが flaky | 中 | mock では「実装の握りつぶし」を見抜けないため real DB で行う。S3 で 3 候補から最も安定する手段を選択し、選択理由を report.md に記録する |
| R3 | 旧 console.log フォーマット差異 | 低 | commit `935b2a3` の old 側 hunk から正確に転記済（先頭 2 スペース、`e?.message ?? e` テンプレート）。test では文字列前方一致 (`startsWith("  (token pool read failed: ")`) でアサート |
| R4 | gate 失敗を error 扱いしてしまう過剰報告 | 中 | gate catch は `onError` を呼ばない（既存仕様維持）。`isTokenPoolEnabled` の失敗は config 構文エラー等であり、OFF として扱うのが従来意図 |
| R5 | callback 内例外で全体クラッシュ | 低 | 旧実装も `console.log` だけで try/catch なし。callback 例外は呼び出し側責任。実装でも `try { options?.onError?.(e) } catch {}` 等の防御は加えない（YAGNI） |

## 6. 既存型エラーの先読み

worktree 内で `bunx tsc --noEmit` を skills/cmux-team/manager/ で実行した結果、`pool-summary.ts` / `main.ts` ともに既存エラー 0。

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-356-1777571586/skills/cmux-team/manager
bunx tsc --noEmit 2>&1 | grep -E "^(pool-summary\.ts|main\.ts)" || echo "(no errors)"
# → (no errors)
```

### 6.1 本タスクのスコープで解消するエラー

該当なし。

### 6.2 後続タスク（cleanup）に分離するエラー

該当なし。

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | callback 注入 vs throw 切替 | **callback 注入** | (1) 既存 return 契約 (`null = no data, returned normally`) を保てる。throw は OFF と error を分離するために caller 側で 2 通りの分岐が必要になる。(2) 既存の gate catch (`isTokenPoolEnabled` 失敗 → silent OFF) を残せる — throw 一択にすると gate 失敗も伝播してしまい OFF 意図と齟齬する。(3) daemon は `buildPoolSummary` 直呼びで影響範囲外、CLI (`loadPoolSummary`) のみが log 流路を必要とする → callback はその差分を最小限で表現する道具として適切 |
| D2 | console.log vs console.error vs log() 経由 | **console.log** | 旧実装 (`935b2a3` 削除前 main.ts:1485-1487) が `console.log`。`status` コマンドは stdout 全体に dashboard を吐くため、warning も同じ stream に乗せて崩れない。`logger.log()` は manager.log への記録機能で daemon 用、CLI から呼ぶと意図しないログ汚染になる |
| D3 | warning フォーマット | **`  (token pool read failed: ${e?.message ?? e})`** （先頭 2 スペース） | 旧実装と完全一致。i18n キー追加は scope outside。先頭インデントは pool ヘッダー他行 (`buildPoolHeaderLines` 出力) との揃え |
| D4 | gate 失敗 (`isTokenPoolEnabled` 例外) を `onError` 経由で報告するか | **報告しない** | 旧 in-line 実装でも gate catch は `console.log` を出さなかった（外側 catch、内側 catch が別々）。gate 失敗 = 設定構文エラー or global yaml 不在 で「OFF と等価」が cmux-team の意図 |
| D5 | テストでの DB 破損再現方法 | **実 DB を破損させる** （第一候補: tokens.db を非 SQLite バイトで上書き） | mock では「内部 catch の握りつぶし」自体を再現できない。実 DB なら refactor 耐性も高い。実装段階で 3 候補から flaky でない手段を選択、決定根拠を report.md に残す |
| D6 | callback signature: `(e: Error) => void` か `(e: unknown) => void` か | **`(e: Error) => void`** + 内部で `e instanceof Error` 判定 → `Error(String(e))` でラップ | 呼び出し側が `e.message` を安全に参照できる。Error への wrap は内部実装。signature は `Error` 限定で型安全性を確保 |

## 8. 完了の定義 (DoD)

- [ ] `loadPoolSummary` に `onError` 引数が追加され、build 失敗時のみ呼ばれる
- [ ] `cmdStatus` で旧 console.log フォーマット (`  (token pool read failed: ...)`) が復元される
- [ ] `pool-summary.test.ts` に case G / H / I の 3 件が追加され PASS
- [ ] 既存 case A〜F が無修正で継続 PASS
- [ ] `pool-summary.ts` / `main.ts` で `bunx tsc --noEmit` エラー 0
- [ ] daemon 経路 (`refreshPoolSnapshot`) は無変更で挙動不変
