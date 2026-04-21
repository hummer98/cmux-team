# T275 検品レポート

## 判定: GO

## 検品結果

### plan.md との整合性

| 項目 | 評価 | 備考 |
|---|---|---|
| schema.ts の enum 追加 | ✓ | `"config-local-ahead"` が `"config-origin"` の直前に追加（schema.ts:365） |
| worktree-base.ts の ahead 判定 | ✓ | `resolveWorktreeBase` が plan 通りのフロー: origin/local 存在を boolean 化 → 両方存在時に `merge-base --is-ancestor` → SHA 比較 → 分岐 |
| 新優先順位の順番 | ✓ | explicit → (origin/local 存在 & ahead) config-local-ahead → config-origin → config-local → head-fallback。コード上の分岐順も正しい（worktree-base.ts:100-147） |
| `worktree_base_local_ahead_check_failed` の発火条件 | ✓ | `is-ancestor` の exit 1 は沈黙、未知例外のみログ。`rev-parse` の例外もログ対象（plan の「純粋な SHA 取得」より保守的で妥当） |
| refspec 表記統一 | ✓ | 存在確認は `^{commit}` peel、ancestor/rev-parse は shorthand |

### テストの妥当性

plan 記載の 5 ケースがすべて追加され、期待される分岐を直接検証している:

1. `local が origin より strict ahead なら config-local-ahead` — `merge-base --is-ancestor` 成功 + `rev-parse` で異なる SHA（"aaa" vs "bbb"）→ `config-local-ahead` 採用を確認
2. `local と origin が完全同一 SHA なら config-origin` — `is-ancestor` 成功だが両 SHA が "sameabc" で一致 → `config-origin` にフォールバック
3. `local が origin の strict ancestor なら config-origin` — `is-ancestor` が `e.code=1` で throw → 沈黙して `config-origin`（exit 1 を明示してスタブしており、plan 準拠）
4. `local が存在しない（origin のみ）` — `refs/heads/main^{commit}` が throw → `merge-base` が呼ばれないことを `calls.find((c) => c[0] === "merge-base")` で担保
5. `is-ancestor が未知例外` — code を設定せず throw → `config-origin` フォールバック

テストは実 git に依存せず、stub 関数の `args` 分岐で完結しており CI で安定。plan で触れられていた「call-count 変更」（既存 line 54 テスト）も適切に更新され、「`merge-base` が呼ばれないこと」のアサーションに置換されている（意図を明示する方向の改善で、plan.md 議論通り）。

### 既存テスト破壊なし

```
$ bun test worktree-base.test.ts
 17 pass / 0 fail / 26 expect()

$ bun test
 664 pass / 0 fail / 1679 expect()
Ran 664 tests across 26 files.
```

既存 12 件の worktree-base テストは全て pass。trace-store.test / conductor.test の `base_source` 参照（"config-origin"/"config-local"）も無影響。

### ドキュメント更新

- **`docs/spec/05-install-and-infrastructure.md` line 424** — 4 段 → 5 段に更新、`config-local-ahead` を (2) に挿入、条件と目的の補足文が追記されている。plan 準拠。
- **`CLAUDE.md` 「worktree 作成時の start-point 解決（T242 / T275）」節** —
  - 見出しに `T242 / T275` 併記 ✓
  - 5 段箇条書き（各行に由来注釈付き）✓
  - 注意書きが `config-local-ahead` の説明に差し替え済み ✓
  - ログフォーマットの enum 列挙に `config-local-ahead` 追加 ✓

### コード品質

- 新規ロジックは既存スタイル（try/catch + `log()`、`git(args)` 抽象）に沿っており、追加のヘルパや抽象化なし
- コメントは最小限（「origin に存在しない」「local にも存在しない」等の既存調の 1 行のみ）
- 不要な冗長な fallback や defensive branch は追加されていない
- `worktree_base_local_ahead_check_failed` の stage ラベル（`ancestor` / `rev-parse`）で発生箇所が区別可能
- `e?.code !== 1` の判定は Node の child_process の実挙動と整合（stub でも `e.code = 1` で再現されている）
- `opts.git` 注入ポイント経由のため execFile 実体には触らず、テスト容易性が維持されている

### 副作用

想定外の実装変更はないが、以下 1 件の unstaged diff に注意:

- **`package-lock.json`**: version 3.54.1 → 4.0.0 の sync（8 行分）。これは HEAD の `b4c3930 chore: release v4.0.0` で package.json が 4.0.0 に更新されたが lockfile が置き去りになっていたもの。worktree 初期化時の `npm install` で自然発生したと推測される。T275 のコミットに含めるべきかは別判断（含めても害はない／含めなくても別途 release で sync される）。**本タスクの成果物としては問題なし。**

他の変更ファイル（CLAUDE.md / docs/spec/05-install-and-infrastructure.md / schema.ts / worktree-base.ts / worktree-base.test.ts）はすべて plan.md の 5 つの完了条件に対応するものに限定されている。

## 総評

plan.md の 6 つの完了条件をすべて満たし、実装・テスト・ドキュメントが整合している。ahead 判定の 3 段（is-ancestor / rev-parse / SHA 比較）が「両方存在」を前提にガードされており、origin だけ/ local だけのケースでは自然にスキップされる安全設計。既存テストの call-count アサーションを「`merge-base` が呼ばれないこと」に置換した判断は、新ロジックの「origin 存在が確定した時点で ahead 判定を走らせない」意図を明示化するもので妥当。**GO**。

## Fix Required

なし。
