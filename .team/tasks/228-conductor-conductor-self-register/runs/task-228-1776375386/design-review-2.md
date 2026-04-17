# T228 Design Review (Round 2)

## Verdict: Approved

## Summary

改訂版 plan.md は前回レビューの Critical 2 件（S6 fallback 削除による resume 経路破壊 / D3 soft cap 発動条件）および Minor 4 件（Findings 3-6）をすべて適切に反映している。S6 は修正案 (A) を採用し resume 分岐を保持、S5 は判定条件を `state.conductors.size >= state.maxConductors` に変更しデフォルト運用で警告が発火するようになった。Decision Log・risk table・検証コマンドも改訂内容と整合しており、実装に進める状態である。

## Findings

### 1. [Resolved] Critical 1: S6 の resume 経路破壊

- plan.md:193-233（S6）で「**非 resume 分岐のみ**削除、resume 分岐は保持」を明示。
- `conductor.ts:244-256`（resume 分岐）を残し、`258-265`（非 resume 分岐）のみ削除する構造で、`main.ts:699-718` の mutate ループが成立する前提が維持されている。
- ログイベント名を `conductor_registered_fallback` → `conductor_resume_prepopulated` に改名し責務を明示化。
- risk table（plan.md:270）および D4（改訂）で修正案 (A) 採用の理由が記載されている。
- コード実体（`conductor.ts:239-267`）の行番号とも一致を確認。

### 2. [Resolved] Critical 2: D3 soft cap の発動条件

- plan.md:151, 165-175（S5）で判定を `state.conductors.size >= state.maxConductors` に変更。
- plan.md:175 の「**重要**: env の有無ではなく...で判定するため、wide デフォルト 3 + 4 個目追加でも発火する」の明記で意図が明確。
- D3（改訂）で初版との差分が記載されている。
- E5（plan.md:282）で「デフォルト wide + 4 個目を手動追加」の期待動作も追加済み。

### 3. [Resolved] Minor (Finding 3): `cmdSpawnConductor` の mainBranch 未解決

- D7（新規、plan.md:322）で「既知の未修正箇所として残す。T228 のスコープ外」と明示。
- risk table（plan.md:272）でも整合性の説明あり。

### 4. [Resolved] Minor (Finding 4): skip ログの観測性

- S5 の skip ログ（plan.md:158-160）に `existing_status=${existing.status} existing_pid=${existing.pid ?? "null"}` が含まれている。
- E3（plan.md:280）でも `existing_status=disconnected existing_pid=null` の追跡可能性が言及されている。

### 5. [Resolved] Minor (Finding 5): CONDUCTOR_REGISTERED ハンドラのユニットテスト欠落

- S5（plan.md:182-185）で 3 ケース（新規登録 / 重複 skip / cap 超過警告）が義務化されている。
- `daemon.test.ts` の変更対象ファイル化（plan.md:67）、検証コマンドで `bun test daemon.test.ts` が S7 に明記されている。

### 6. [Resolved] Minor (Finding 6): fail-fast メッセージの粒度

- S1（plan.md:90-91）で「壊れた proxy-port ファイルの場合は `.team/proxy-port` を削除して `cmux-team start` をやり直してください」を追加。
- D1（plan.md:316）で proxy-port 破損ケースの orphan 解消を明記。

### 7. [Minor] 軽微な改善余地（Approved には影響しない）

- S6 の検証コマンド（plan.md:231）`grep -n "conductor_resume_prepopulated"` の `expect: 1` は、call site の 1 箇所を想定している。実装時にコメント行と混同しないよう、`grep -c` と組み合わせるか、関数呼び出し（`await log("conductor_resume_prepopulated"`）を対象にする grep に統一すると検証が厳密になる。
- S6 の `grep -n 'status: "starting"' skills/cmux-team/manager/conductor.ts` `expect: 0` は、`conductor.ts` 全体での `status: "starting"` をゼロにする意図。`launchConductor` ほか別箇所で `status: "starting"` を set していないか、実装時に念のため一度 grep で全体確認するとよい（現状の `initializeConductorSlots` 内では 1 箇所のみのはず）。

いずれも着手後の実装者判断で対応可能な範囲で、plan 段階での Changes Requested には相当しない。

## Recommendations

なし（Approved）。

実装時の注意点（P3 相当）:
- S6 のコメント文言（plan.md:201-207）をそのままコードに反映すること。責務分離が明確になる。
- S1 の fail-fast メッセージは**複数行出力**（plan.md:88-92）なので、`console.error` を複数回呼ぶか `\n` を含めた 1 行で書くかの選択が必要。どちらでも E2E T4 の期待動作は満たせるが、ユーザー視認性を考慮すること。
- S5 のユニットテスト 3 ケースは、テストの独立性（`state.conductors` をテストごとに reset）を保つこと。`daemon.test.ts` の既存パターンに合わせるとよい。
