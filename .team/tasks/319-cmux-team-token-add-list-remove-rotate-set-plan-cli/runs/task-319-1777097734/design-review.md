# T319 Design Review (v2)

## 判定
**Approved**

## サマリー

前回 Changes Requested の Major / Minor を Rev 2 で全て反映済み。各論点の対応状況:

1. **transaction × Keychain**: §2「DB × Keychain の整合戦略」(plan.md:75-113)・subtask 6.10 (plan.md:229-238)・subtask 9 (plan.md:276-286)・Risk § (plan.md:344)・D7 (plan.md:377) が「DB COMMIT → Keychain → 失敗時 DB 補償」の補償トランザクション方式に統一され、SQL transaction 内 `spawnSync` 案の破棄が D7 に明記された。冪等性の依拠（`deleteToken` 冪等 + Keychain `-U` upsert）も整合的。
2. **A019 参照**: D1 (plan.md:371) が「main repo absolute path から実読」に書き直され、handle UX (`personal` / `kddi-dev`) / tag 4 値（`auto` 警告 + 除去 = subtask 6.8）/ TUI 整数表示（D11 / subtask 7）/ `auto` token の `set-plan` 取扱（D14 / subtask 10）が plan に反映済み。
3. **handle sanitize**: subtask 4 (plan.md:178-198) で「`[a-z0-9]` 以外を除去 → 先頭 4 文字」のロジックに変更、`kddi-dev` / `KDDI-dev` / `kddi_dev` → `@kddi` のテストケース追加。`@` 明示入力の検証ロジックは維持。
4. **organization_id 必須化**: subtask 6.3 (plan.md:217-222) で「credential / 対話入力のいずれでも空なら exit 1」+ Anthropic Console 案内のエラーメッセージが明記、Risk § (plan.md:341) が「`organizationId` 必須・他は欠損許容」に修正された。
5. **`auth_hash` フォーマット**: D5 (plan.md:375) が「A020 §schema 設計（後続実装提言）に準拠」に書き直され、T320 / T321 も full 64 hex 比較を前提とすることが Decision Log に明記された。subtask 2 / subtask 4 hashAuthorization も full 64 hex で揃っている。

副次（前回 Recommendations 6〜9）:
- 6. `formatNextReset` 形式: subtask 4 (plan.md:174) と D12 (plan.md:382) で `7d @ Apr 27 09:00` 形式 + locale 非依存の月名配列方針に統一。
- 7. cap_pct 整数表示: subtask 4 / subtask 7 / D11 (plan.md:381) で `Math.round` + `%` に統一。
- 8. `set-plan` selectable 昇格スコープ外: subtask 10 (plan.md:301-302) と D14 (plan.md:384) に明記。
- 9. token-store 3 関数追加の責務: D15 (plan.md:385) に T318/T319 のスコープ判断軸（YAGNI）を明文化。

実装に進んで問題なし。

## 残存事項（Minor、実装後でも可）

- **subtask 9 のテスト assertion 表現**: 「`getTokenByHandle().auth_hash === oldHash`」は in-memory Keychain の throw モード切替実装に依存する。`KEYCHAIN_TEST_MODE` の throw 方式が token-store の既存テスト helper（`KEYCHAIN_TEST_MODE=1` の in-memory map）から自然に拡張できるか、Implementer が token-store.ts のテストモード API を確認した上で実装すること。必要なら token-store 側に `__setKeychainTestFailureMode(true)` 等のテスト専用 hook を追加する選択肢もある（test-only export として）。
- **subtask 4 の `formatNextReset` テスト**: `Asia/Tokyo` 固定 + 月名配列の方針は plan に書かれているが、`util_5h_reset` / `util_7d_reset` の入力型（ISO 文字列か epoch ms か）が plan 上で曖昧。`token-store.ts` の `usage_snapshots` 列の型に合わせて Implementer が決定すること（実装時の DB スキーマ確認で 1 行追記すれば足りる）。
- **subtask 6.4 の handle 重複検査メッセージ**: 「同 organization_id は既に @xxxx で登録済み。rotate を使ってください」は「同じ organization の別 handle は禁止」を意味するメッセージとして妥当だが、organization_id 重複と handle 重複でメッセージが異なるべき（organization_id 重複 → rotate 推奨、handle 重複 → 別 handle で再実行）。実装時に文言を分けることを推奨。
- **subtask 13 手動検証**: macOS 実機での `add` / `list` / `remove` / `rotate` のハッピーパス確認は Conductor 実行時に可能なら実施。CI 上では `KEYCHAIN_TEST_MODE=1` のテストで担保するため必須ではない。
