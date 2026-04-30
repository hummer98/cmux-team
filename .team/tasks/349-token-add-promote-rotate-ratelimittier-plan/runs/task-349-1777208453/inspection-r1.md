# Inspection Report (Round 1)

## Verdict
**GO**

## 検証結果サマリー
- bun test: 37 pass / 0 fail / 4 skip （全 41 件）
- bunx tsc --noEmit: 新規エラー 0 件（exit 0）
- plan.md との整合: 一致（§3.2 / §3.3 / §3.4 / §3.5 / §3.6.1〜3 / §4 全 step / §5 全テスト）

## Findings

### Critical (NOGO の場合は必須対応)
- なし

### Major (推奨だが NOGO まではいかない)
- なし

### Minor (任意改善)

1. **`package-lock.json` の version bump (4.12.0 → 4.12.1) は本タスクと直接関係がない**。
   `aa7d652 chore: release v4.12.1` で `package.json` だけ更新され `package-lock.json` が
   取り残されていたものを `bun install` 等が再生成した結果と推測される。impl-notes にも
   言及がない。レビュー時の説明コストを下げるため、コミット時にこの 1 行を分離コミット
   （例: `chore: sync package-lock.json with v4.12.1`）として切るか、PR description で
   一言触れるとレビュアーに優しい。**実害なし**。

2. **plan.md §5「既存テストへの波及」の網羅漏れに対する補完が impl-notes 側だけにある**。
   plan.md は `manual 経路成功` のみ明示していたが、実装では `organization_id 重複は exit 1`
   と `handle 重複は exit 1` も source=2 経路のため空 Enter 挿入が必須で、impl-notes が
   それを補って正しく対応している（test L335 / L368 / L390 の 3 箇所）。テストは全 pass
   しており実害なし。今後 plan.md を再利用する場合は §5 にこの 2 件も追記する余地がある。

3. **`cmdTokenPromote` への `Found credential:` ブロック新規追加は plan.md §3.6.3 では
   暗黙の挙動**だった。impl-notes §「cmdTokenPromote の `Found credential:` ブロック追加」
   で「helper のログ責務統合と add との UI 統一のため追加した」と意図を明記済み。既存
   テストは Found credential ブロックを explicit に assert していないため影響なし。
   将来 plan.md を改訂する場合は §3.6.3 のレイアウト図に「promote 側にもブロックを揃える」
   旨を一文加えるとなお親切。

## Notes

### 検品観点ごとの確認

#### 1. plan.md との整合
- **§3.1 prompt 文言**: `"plan (pro / max-x5 / max-x20, Enter で unknown): "` —
  token-cli.ts L94 で完全一致。
- **§3.2 helper 構造**: `PLAN_BY_NAME` (L48-52) / `resolvePlanForRegistration` (L71-84) /
  `promptManualPlan` (L90-102) の 3 つを plan.md のコード例どおり配置。`validPlans` は
  触らず（§3.2 step 3 採用しない方針）。
- **§3.3 再入力ループ**: `promptManualPlan` 内 `for (;;)` ループ + `console.error` で
  実装済み。空 Enter で `unknown` 確定 → ループ脱出。stdin EOF（テスト mock の
  `askAnswers.shift() ?? ""`）でも空文字 → `unknown` で安全に抜ける。
- **§3.4 rotate scope 外**: `cmdTokenRotate` は diff 上完全に未変更。
- **§3.5 Hint 条件式**: `cmdTokenPromote` L634-639 の `if (plan === "unknown")` ブロック
  はそのまま温存。新 prompt で plan が確定すれば自動的に通らない。
- **§3.6.1 ログ責務 helper 内包**: `resolvePlanForRegistration` 内で `fromTier` 有無に
  応じて rateLimitTier 行ログ or 空行を出力。呼び出し側 (`cmdTokenAdd` L228-231 /
  `cmdTokenPromote` L605-608) は `Found credential:` ブロックを出してから helper を
  呼ぶだけで分岐ロジックを持たない。
- **§3.6.2 後者解釈（未知 tier も prompt 対象）**: `fromTier === undefined` のときに
  prompt に落ちる（rateLimitTier 行ログは出さない）→ T6 で検証済み。
- **§3.6.3 ログレイアウト**: `Found credential:` → `organizationId:` → 空行 → prompt の
  順序が helper + 呼び出し側で再現されている。

#### 2. テストの実行
```
$ cd skills/cmux-team/manager && bun test --timeout 30000 token-cli.test.ts
 37 pass
 4 skip
 0 fail
 156 expect() calls
```

新規追加: T1 / T2 / T3 / T4 / T6（cmdTokenAdd）+ T5a（cmdTokenPromote）の 6 件すべて green。
既存改修（manual 経路成功 / organization_id 重複 / handle 重複 / R-promote-2 / R-promote-8 /
R-promote-9 / R-promote-10）の 7 件も全 pass。

skip 4 件はいずれも本タスクと無関係（main 側に未実装の `tags=auto 警告` /
`Keychain 失敗 → DB 巻き戻し` / `rotate org_id check` で、token-cli.test.ts の元から
ある skip。今回の改修で skip 数が増減していない）。

#### 3. TypeScript 型検査
`bunx tsc --noEmit -p tsconfig.json` は exit 0 / no output で新規エラー 0 件。

`PLAN_BY_NAME` が `noUncheckedIndexedAccess: true` 下で要求する non-null assertion (`!`)
は `PLAN_MAP` のキーが静的に存在するため正当（impl-notes §「PLAN_BY_NAME の non-null
assertion」で根拠明記）。

#### 4. コード品質
- 例外握り潰し（空 catch）なし。`promptManualPlan` の不正値経路は `console.error` で
  stderr に出してから再 prompt しており silent failure ではない。
- 命名・抽出粒度は plan.md と完全一致（`PLAN_BY_NAME` / `resolvePlanForRegistration` /
  `promptManualPlan`）。
- scope 外変更:
  - `docs/spec/09-token-pool.md`: `cmux-team token add` セクションに新 prompt の挙動 1
    段落（L67-71）、`cmux-team token promote` の plan 説明を更新（L115-119）。範囲は
    plan.md §4 Step 6 通り。
  - `package-lock.json`: 上記 Minor 1 のとおり release 時の取り残し補正と推測。

#### 5. CLAUDE.md ルール準拠
- 構造的正しさ: 「rateLimitTier→plan 解決」を helper 1 関数に集約し呼び出し側から分岐
  ロジックを引き剥がした。CLAUDE.md「決定論的なものはコードで」「各層は自分の仕事だけ
  をする」と整合。
- hook 経由していない直接書き込み: 該当なし（DB insert は既存 `insertToken` /
  `updateTokenPromoteFields` 経由）。
- 不要な後方互換コードなし。`validPlans` は意図的に残し（§3.2 step 3 を別タスクに分離）、
  「重複は意図的に残した」旨が plan.md / impl-notes に明記。

#### 6. UX 確認
- prompt 文言: 一致。
- エラー文言: `"Error: pro / max-x5 / max-x20 のいずれかを入力してください（空 Enter で unknown）"` で plan.md §3.2 と完全一致。
- `Found credential:` と plan prompt の間の空行: helper 内 `console.log("")` で出力。
  T2 が `consoleLogs[orgIdLineIdx + 1] === ""` で回帰検出。
- Hint メッセージは plan 確定時に出ない: T5a で `not.toContain("set-plan")` /
  `not.toContain("Hint:")` の二重 assert で検証。既存条件式（`if (plan === "unknown")`）は
  変更不要のまま動作。

### 完了基準（plan.md §8）の達成状況
- [x] cmdTokenAdd で rateLimitTier 由来未解決時のみ新 prompt（undefined / 未知 tier 両対応）
- [x] cmdTokenPromote で同上
- [x] cmdTokenRotate には変更なし
- [x] PLAN_MAP / PLAN_BY_NAME が同じ値ソースを参照（`validPlans` 据え置き）
- [x] 不正値で再入力ループ + `pro / max-x5 / max-x20` を含むエラーメッセージ
- [x] 空 Enter で `unknown` / `null` 登録
- [x] `Found credential:` ブロックと plan prompt の間に空行
- [x] T1〜T5a / T6 全 pass
- [x] 既存テスト（manual 経路成功 / R-promote-2 / R-promote-8 / R-promote-9 /
  R-promote-10）に空 Enter 挿入で対応
- [x] set-plan 既存 3 テスト無改造で pass
- [x] bun test --timeout 30000 token-cli.test.ts が green
- [x] docs/spec/09-token-pool.md に新 prompt の挙動を追記（未知 tier 対象である旨を含む）
- [ ] PR description（PR 作成時に `§3.4 / §3.6.2 / §3.2` の判断要約を記載予定。Inspector
  の検品範囲外）
