# T275 実装レポート — `config-local-ahead` source の追加

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/schema.ts` | `WorktreeBaseSource` enum に `"config-local-ahead"` を `"config-origin"` の直前に追加 |
| `skills/cmux-team/manager/worktree-base.ts` | `resolveWorktreeBase` に ahead 判定ロジックを追加。origin/local 存在チェックを boolean 化し、両方存在 & `merge-base --is-ancestor origin/<main> <main>` 成功 & SHA が異なる場合に `config-local-ahead` を採用。未知例外時は `worktree_base_local_ahead_check_failed` ログを出して `config-origin` / `config-local` にフォールバック |
| `skills/cmux-team/manager/worktree-base.test.ts` | 新規 5 ケース追加（ahead 採用 / 同一 SHA / ancestor 逆 / local 不在 / 未知例外）+ 既存 `config-origin` テストの call-count アサーションを新挙動に合わせて `merge-base` が呼ばれないことの確認に置換 |
| `docs/spec/05-install-and-infrastructure.md` | `mainBranch` 節の start-point 解決を 4 段 → 5 段に更新し `config-local-ahead` を (2) に挿入。補足文を追記 |
| `CLAUDE.md` | 「worktree 作成時の start-point 解決」節を T242 / T275 併記に更新。5 段箇条書き、ログフォーマット列挙、注意書きを更新 |

## テスト結果

### 新規テスト (worktree-base.test.ts)

- `local が origin より strict ahead なら config-local-ahead を採用する (T275)` — pass
- `local と origin が完全同一 SHA なら config-origin を採用 (T275)` — pass
- `local が origin の strict ancestor なら config-origin に倒れる (T275)` — pass
- `local が存在しない（origin のみ）なら ahead 判定をスキップして config-origin (T275)` — pass
- `is-ancestor が未知例外を投げたら config-origin にフォールバック (T275)` — pass

### 回帰

```
$ bun test worktree-base.test.ts
 17 pass
 0 fail
 26 expect() calls

$ bun test
 664 pass
 0 fail
 1679 expect() calls
Ran 664 tests across 26 files.
```

既存 12 件の worktree-base テストは全て pass（1 件の call-count アサーションを新挙動に追従して更新済み）。全 manager test 664 件 pass。

## ドキュメント更新箇所

- `docs/spec/05-install-and-infrastructure.md` line 424 — start-point 解決の優先順位を 5 段に更新、`config-local-ahead` の条件と目的を追記
- `CLAUDE.md` `worktree 作成時の start-point 解決（T242 / T275）` 節 — 5 段箇条書き / ログフォーマット / 注意書きを更新

## 実装時の判断メモ

- **既存テスト `mainBranch ありで origin/<mainBranch> が存在すれば config-origin` の call-count 変更**: 新ロジックでは「origin と local の両方の存在チェック」を先に行う必要があるため、ahead 判定前でも local への rev-parse が発行される（throw されるだけで結果には影響しない）。よって call count が 1 → 2 に変わる。plan.md ではこの点を具体的に述べていなかったが、「origin が明らかに存在する経路では `merge-base` を呼ばない（＝ahead 判定が走らない）」ことを担保するほうがテストの意図に近いと判断し、`calls.some(refs/remotes/origin/dev^{commit})` と `calls.find(c[0]=="merge-base") === undefined` に置換した。
- **`merge-base --is-ancestor` の exit 1 判定**: execFile 経由では非 0 終了は throw になる。Node の child_process は `err.code` に数値 exit code を立てるため、`code === 1` は「ancestor でない（＝予期した判定失敗）」として沈黙、それ以外（code === undefined や他の値）だけ `worktree_base_local_ahead_check_failed` ログを出す運用にした。
- **`rev-parse origin/<main>` / `rev-parse <main>` 失敗時**: plan.md では純粋な SHA 取得として扱うが、失敗した場合（稀）に ahead 判定を採用するのは危険なので、`config-origin` へフォールバックしつつログを残す形にした。

## 残課題

なし。完了条件（plan.md）をすべて満たした:

- [x] `schema.ts` の enum に `"config-local-ahead"` が含まれる
- [x] `worktree-base.ts` に ahead 判定ロジックが追加され、優先順位通りに分岐する
- [x] `worktree-base.test.ts` の全テスト（新規 5 ケース含む）が通る
- [x] `docs/spec/05-install-and-infrastructure.md` の優先順位表が 5 段に更新される
- [x] `CLAUDE.md` の T242 節が `config-local-ahead` を含むよう更新される（T242 / T275 併記）
- [x] `bun test` 全体が通る（既存テストに回帰なし）
