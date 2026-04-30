# T355 検品レポート

**Inspector**: surface178-inspector-1777260182
**対象タスク**: 355 ANTHROPIC_CUSTOM_HEADERS を改行区切りに修正して role/surface 汚染を止める
**worktree**: `/Users/yamamoto/git/cmux-team/.worktrees/task-355-1777259174` (branch `task-355-1777259174/task`)
**作成日時**: 2026-04-27

---

## 1. 結論

**GO**

plan.md の要件（master/conductor surface の改行区切り化、agent surface 据え置き）は完全に満たされている。
追加テスト（main.test.ts T355 regression、proxy.test.ts 分離保存テスト）はタウトロジーになっておらず、
実装側がカンマ区切りに退行した瞬間に fail する形に組まれている。
`bun test main.test.ts proxy.test.ts` は 231 pass / 0 fail。
TypeScript エラーは pool-header-display.test.ts の既存 18 件のみで、本タスク変更ファイル由来の新規 TS エラーはゼロ。
「やってほしくないこと」（DB migration、proxy.ts:619-623 改変、DB スキーマ変更、他環境変数改変）はいずれも犯していない。

---

## 2. 検品結果

### 検品ポイント 1: plan.md の要件を満たしているか

**Pass**

| 対象 | 期待 | 実装 | 結果 |
|------|------|------|------|
| `main.ts:1958` (master) | `, ` → `\n` 連結 | `` `x-cmux-role: master\nx-cmux-surface: ${surface}` `` | ✅ |
| `main.ts:2116` (conductor) | `, ` → `\n` 連結 | `` `x-cmux-role: conductor\nx-cmux-surface: ${surface}` `` | ✅ |
| `main.ts:2044` (agent) | 変更しない（単一値のため） | `"x-cmux-role: agent"` のまま | ✅ |

`grep -rn ANTHROPIC_CUSTOM_HEADERS skills/cmux-team/` で他の連結箇所が無いことも再確認済み。
templates/ 配下にも `ANTHROPIC_CUSTOM_HEADERS` / `x-cmux-role` / `x-cmux-surface` の grep ヒットは無く、修正漏れ無し。

コメントには `T304/T323/T355` と理由（カンマ区切りで送ると SDK が 1 ヘッダー値として送り role 列が汚染される）が日本語で記録されており、後続の保守者が経緯を追える状態になっている。

### 検品ポイント 2: テストの妥当性

**Pass**

#### main.test.ts
- L1895-1897 (master): expected を `"x-cmux-role: master\nx-cmux-surface: surface:100"` に更新
- L1911-1913 (conductor): expected を `"x-cmux-role: conductor\nx-cmux-surface: surface:200"` に更新
- L1923-1928 (agent): 変更なし（単一値のため）
- L1931-1945 に T355 regression `describe` を新設し、master / conductor 両方について
  - `not.toContain(", x-cmux-surface")` ← カンマ + 半角スペースが混入していないこと
  - `toContain("\n")` ← 改行が含まれていること

  の 4 アサーションを行っている。実装側を `, ` 連結に戻した瞬間に明確に落ちる構造で、タウトロジーではない。

#### proxy.test.ts
- L1109-1166 に新規テスト 1 件を追加。`describe("api_usage (T305)")` 配下に置かれており、`db` / `testDir` のスコープも beforeEach で正しく確保されている。
- 検証内容:
  1. 分離ヘッダー (`x-cmux-role: master` + `x-cmux-surface: surface:123`) を fetch で送信
  2. `getApiUsage(db, { taskId: "T355" })` で DB から 1 行取得
  3. `row.role === "master"`, `row.surface === "surface:123"`
  4. `row.role` に `"x-cmux-surface"` も `","` も含まれない（汚染検出）
- `start()` の signature (`{ taskId, db }`) は proxy.ts:354-365 と整合。
- upstream を Bun.serve で立てて `ANTHROPIC_API_URL` を上書き → 後始末で復元する既存パターンを踏襲。
- `safeInsertApiUsage` の遅延 INSERT を 100ms 待ってから読み取る既存テストと同じ流儀。

意義: proxy.ts は元々 `req.headers.get("x-cmux-role")` と `req.headers.get("x-cmux-surface")` を別々に拾える設計のため、このテストは現状でも pass する性質のもの。**将来 proxy 側で何らかの仕様後退（例: `req.headers.get("x-cmux-role")` の取得方法を変えてしまう、汚染値を保存し始める等）が発生した際に検出するための regression net** として価値がある。タウトロジーではない。

### 検品ポイント 3: タスクの「やってほしくないこと」を破っていないか

**Pass**

- ✅ DB の物理 migration 無し（trace-store.ts への変更ゼロ、SQL 文の追加・変更ゼロ）
- ✅ `proxy.ts:619-623` の `x-cmux-role` 取得ロジックは無改変（git diff 上でも proxy.ts は対象外）
- ✅ DB スキーマ変更無し（schema 定義ファイルへの差分ゼロ）
- ✅ `ANTHROPIC_CUSTOM_HEADERS` 以外の環境変数（`CMUX_*`, `ANTHROPIC_*` 系）への変更ゼロ

`git diff --name-only`:
```
package-lock.json
skills/cmux-team/manager/main.test.ts
skills/cmux-team/manager/main.ts
skills/cmux-team/manager/proxy.test.ts
```

### 検品ポイント 4: テスト実行

**Pass**

```
$ bun test --timeout 30000 main.test.ts proxy.test.ts
 231 pass
 0 fail
 642 expect() calls
Ran 231 tests across 2 files. [19.32s]
```

T355 タグでフィルタした結果:
```
$ bun test --timeout 30000 -t "T355" main.test.ts proxy.test.ts
 6 pass
 225 filtered out
 0 fail
 17 expect() calls
```

TypeScript 検査:
```
$ bunx tsc --noEmit 2>&1 | wc -l
18
$ bunx tsc --noEmit 2>&1 | grep -vE "pool-header-display\.test\.ts"
(empty)
```

18 件は全て `pool-header-display.test.ts(L,C): error TS2532: Object is possibly 'undefined'` の既存エラー。
`git stash` で本タスク変更を退避してから tsc を再実行しても同じく 18 件で、本タスク変更ファイル（main.ts / main.test.ts / proxy.test.ts）由来の TS エラーはゼロであることを確認済み。

### 検品ポイント 5: スコープ外変更の混入チェック

**Pass（注意事項あり）**

- 変更ファイル 4 件のうち 3 件 (`main.ts`, `main.test.ts`, `proxy.test.ts`) は plan.md と完全一致。
- `package-lock.json` は `"version": "4.12.1"` → `"4.14.0"` の 2 行のみの差分。これは `chore: release v4.14.0` (HEAD = 06d58d6) で `package.json` だけが 4.14.0 に bump され `package-lock.json` が同期されていなかった状態を、worktree 立ち上げ時の `bun install` が補正したもの。**T355 とは無関係**で、依存パッケージの追加・削除も無し。
- 実害は無いが、コミット時には別コミットに分けるか、release コミットに含めるべきだった旨の判断材料として記録（minor 指摘 1 参照）。

### 検品ポイント 6: コーディング規約準拠

**Pass**

- コメントは日本語、コード（変数名・関数名・コマンド）は英語: ✅
- 不要な「タスク説明用コメント」: 残っていない。コメントはすべて将来の保守で必要な「なぜ改行区切りなのか」「なぜカンマだとダメなのか」「公式仕様 URL」を記載しており、T355 の経緯がコードを読んだだけで理解できる。CLAUDE.md の「How / Why は残し、What は残さない」方針と整合。
- 既存パターン整合性: ✅ T304/T323 のコメント書式 (`// T304/T323/T355: ...`) を踏襲し、proxy.test.ts の追加テストは既存 T305 系テスト群の Bun.serve + `start()` + `getApiUsage` パターンを忠実に再利用。

---

## 3. Fix Required

なし（GO のため）。

---

## 4. minor 指摘（GO でも残す）

### minor 1: package-lock.json の差分はコミット分離が望ましい

`package-lock.json` の `4.12.1 → 4.14.0` 差分は HEAD (`06d58d6 chore: release v4.14.0`) で同期し損ねていたものを worktree 立ち上げが補正したもので、T355 とは無関係。
このまま T355 のコミットに混ぜると後で git blame したときに誤解を招く可能性がある。Conductor がコミットする際は次のいずれかを推奨:

- (推奨) 別コミット `chore: sync package-lock.json with v4.14.0 release` として分離
- もしくは T355 コミットには含めず、release プロセスのバグ修正として別タスクで処理

### minor 2: agent surface のコメントに T355 言及を追記する選択肢

`main.ts:2042-2044` (agent surface) は単一値のため今回触っていないが、将来 agent にも `x-cmux-surface` を追加する人が「カンマ連結すれば良い」と誤解しないよう、コメントに `T355: 将来 surface を追加する場合は必ず \n 区切り` の一行を残すと事故防止になる。
plan.md でも「コメント追記不要としていた」とある通り Critical ではない。指針として残しておく価値はあるが、過剰コメントの懸念もあるため Conductor の判断に委ねる。

### minor 3: 実機検証 (plan.md 検証手順 3-6) は未実施

これは Inspector のスコープ外で Conductor 側で実施すべきものだが、レビュー観点として記録:
- `cmux-team start` で Manager を再起動 → master/conductor/agent から実 API リクエスト発行
- `sqlite3 .team/traces/traces.db "SELECT DISTINCT role FROM api_usage WHERE timestamp > datetime('now','-5 minutes')"` で `master` / `conductor` / `agent` の 3 値のみになることを確認

特に Claude Code SDK が改行区切り `ANTHROPIC_CUSTOM_HEADERS` を実際に分離ヘッダーで送ってくれることは公式仕様への依存であり、実機検証で確証を得るまでは「仕様通りなら動くはず」の段階に留まる。close-task 前に必ず実施することを推奨。

---

## 結論再掲

**GO**

実装は plan.md と完全整合し、テスト・型検査・スコープ・規約のいずれも通過。minor 3 件はいずれも close-task 後または別コミット運用で吸収可能なレベル。
