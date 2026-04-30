# T315 実装レポート: .team/.gitignore テンプレートに daemon.pid と gh-cache.db* を追加

## Completed Tasks

- [x] **S1. 新規生成テンプレートに 4 項目追加** (`skills/cmux-team/manager/daemon.ts`)
  - `proxy-port` の直後に `daemon.pid` を splice
  - グループ末尾付近（`e2e-results/` の直後）に `gh-cache.db` / `gh-cache.db-shm` / `gh-cache.db-wal` を追加
- [x] **S2. migration ブロックに daemon.pid 追記判定を追加** (`skills/cmux-team/manager/daemon.ts`)
  - anchor = `proxy-port`。未発見時は `lines.push` にフォールバック
  - 判定は T227/T229 と同じ `lines.some(t === X && !startsWith("#"))` パターン
- [x] **S3. migration ブロックに gh-cache.db 系 3 項目の追記判定を追加** (`skills/cmux-team/manager/daemon.ts`)
  - 3 項目を `for (const name of [...])` で 1 ループ処理
  - anchor 探索順: `gh-cache.db-wal` → `gh-cache.db-shm` → `gh-cache.db` → `rate-limit.json` → `proxy-port` → `push`
  - 各項目を `added.push(name)` で個別に可視化
- [x] **S4. team_gitignore_migrated ログ検証**
  - コード変更なし（既存の `added.join(",")` 出力で自動的に混ざる）
  - テストで `team_gitignore_migrated` ログ 1 行内に 4 項目が現れることを assert
- [x] **S5. ローカル worktree での動作確認**
  - plan.md §5「テスト戦略」に従い unit test で代替（手動起動は daemon 多重起動リスクがあるため不要）
- [x] **S6. テスト新設** (`skills/cmux-team/manager/daemon.test.ts`)
  - `describe("initInfra: .team/.gitignore (T315)")` を末尾に新設
  - 5 ケース: 新規生成 / migration / 新規生成冪等 / migration 冪等 / コメントアウト行扱い
- [x] **S7. 最終検証**
  - `bun test` 全 pass（1231 tests / 41 files）
  - `bunx tsc --noEmit` エラー数は着手前と同じ 3 件（plan §6.2 の既存エラーのみ残存）

## Files Changed

| ファイル | 変更規模 | 内容 |
|---------|---------|------|
| `skills/cmux-team/manager/daemon.ts` | +52 行 | template 配列に 4 項目追加 / migration ブロックに daemon.pid と gh-cache.db* 判定追加 |
| `skills/cmux-team/manager/daemon.test.ts` | +128 行 | `describe("initInfra: .team/.gitignore (T315)")` 新設 (5 テスト) |

### 変更詳細

**`daemon.ts` template 配列 (L504–L527):**
- `proxy-port` の直後に `daemon.pid` を挿入
- `e2e-results/` の直後に `gh-cache.db` / `gh-cache.db-shm` / `gh-cache.db-wal` を挿入

**`daemon.ts` migration ブロック (L586–L638 付近):**
- T229 masters/ 判定直後、`if (changed)` 直前に 2 つのブロックを追加
  1. `daemon.pid` — `proxy-port` anchor 直後に splice
  2. `gh-cache.db` 系 3 項目 — `for` ループで順次追加（後続 entry を anchor 候補として利用）

## TDD Cycles / Verification Results

### RED フェーズ
```
$ bun test daemon.test.ts -t "T315"
 2 pass
 3 fail
 6 expect() calls
```
- `新規生成` / `migration` / `コメントアウト行扱い` の 3 ケースが expected "daemon.pid" を検出できず fail（期待通り）
- 冪等性 2 ケースは実装変更前の内容同士の比較なので偶然 pass（実装後も pass を維持すれば妥当）

### GREEN フェーズ
```
$ bun test daemon.test.ts -t "T315"
 5 pass
 0 fail
 19 expect() calls
```

### 全体テスト
```
$ bun test
 1231 pass
 0 fail
 3010 expect() calls
Ran 1231 tests across 41 files. [54.89s]
```

### tsc
```
$ bunx tsc --noEmit
conductor.ts(201,3): error TS1016
daemon.test.ts(3870,9): error TS2322  ← plan §6.2 既存エラー
daemon.ts(1610,22): error TS2352     ← plan §6.2 既存エラー（本タスクで +52 行入れたため 1558 → 1610 にシフト）
```
- 着手前 3 件（conductor.ts:201, daemon.test.ts:3870, daemon.ts:1558）
- 着手後 3 件（同上、daemon.ts だけ行番号が 1610 にシフト）
- エラー数・内容は不変。plan §6.2 の既存エラーは本タスク対象外（別 cleanup タスクに分離）

## Issues Encountered

### Minor: plan §6.2 の事前エラー件数と実測の差異

plan.md §6 では着手前のエラーを 2 件（daemon.test.ts:3870 / daemon.ts:1558）と記載しているが、
実測では `conductor.ts(201,3): error TS1016` も含めて 3 件あった。
この 3 件目（`conductor.ts` の optional parameter order）も本タスクとは無関係で、
変更後も同じ内容のまま残存しているため、plan の「着手前と同数またはそれ以下」の意図に照らして
問題なしと判断した。必要なら別 cleanup タスクで集約対応を提案する。

### スコープ外として手を入れなかった点

- リポジトリルートの `.gitignore` は変更していない（plan §「スコープ外」）
- 本 worktree の `.team/.gitignore` も手動編集していない（migration 経路でのみ更新される想定を維持）
- plan §6.2 の既存型エラーには触れていない
