# Design Review for plan.md (T335)

reviewer: conductor-335-reviewer-1777163112
reviewed_at: 2026-04-26
reviewed_against:
  - .team/artifacts/A019-token-pool-design.md（§改訂検討事項 2026-04-26）
  - skills/cmux-team/manager/token-store.ts:710-771（selectToken 現行）
  - skills/cmux-team/manager/config.ts:15-263（TeamConfig / GlobalConfig / resolveTokenPoolEnabled）
  - skills/cmux-team/manager/project-tags.ts:1-167（parseRemoteOriginToTags / resolveProjectTags）
  - skills/cmux-team/manager/main.ts:2669-2720（cmdSpawnAgent token 選択経路）
  - skills/cmux-team/manager/token-store.test.ts:1058-1149（selectToken tags フィルタ describe）

## 判定: Changes Requested

実装計画は全体に高品質で、TDD ステップ分割・後方互換戦略・Open Question の決定方針まで網羅されている。一方で A019 仕様との挙動差分が複数あり、実装前にユーザー（または Master）確認なしに着手すると Project C の受け入れ条件が満たせない／A019 と plan で `selectable` 昇格挙動が食い違う、という形で fail close まで至る可能性が高い。Major 3 件を解消した上で再提出してほしい。

---

## Strengths

- **既存実装の正確な把握**: token-store.ts:710-771 / config.ts / project-tags.ts / main.ts:2669-2720 の参照が実コードと完全一致し、改訂が必要な点が箇所単位で明示されている。
- **後方互換戦略が具体的**: `selectToken` の第 3 引数を `SelectTokenPolicy | string[]` union にして既存 6 ケースを無変更で通す設計、`resolveProjectTags` を `resolveProjectContext` の wrapper として残す設計、いずれも現実的。
- **TDD 単位の粒度が良い**: Step A〜E が test → impl で独立に緑にできる単位に切られており、commit 単位までマップされている（plan §7）。
- **エッジケース表 (E1〜E9)** が網羅的で、特に `default ∈ exclude` / `selectable=0` の昇格ケース / Keychain 不在ケースが具体的に挙がっている。
- **Open Questions の決定方針が言語化されている**（plan §4）: `primary_orgs` 未設定 / default∩include / exclude∋default の挙動を「採用方針」として固定し、判断保留を残していない（後述 M2 を除く）。
- **境界遵守**: DB schema 変更なし／Keychain 連携変更なし／proxy 経路非接触、が plan §6 で明示。

---

## Findings (Critical / Major / Minor)

### Critical

なし。実装をブロックする致命的な誤りや設計矛盾は検出されなかった。

### Major

#### M1. A019 と plan で `selectable` 昇格挙動が食い違う

A019 §改訂検討事項「project default の auto-discover 連携」は

> `tokenPool.default` で明示宣言された handle が auto-discover 由来（`selectable=0`）であっても、**spawn-agent 時に自動的に `selectable=1` に昇格**して候補化する。

と DB 書き換え（`selectable=1` への永続化）を含意しているが、plan §D-1 は

> **DB 上の selectable は書き換えない**（一時的な runtime 昇格のみ）。理由: 副作用を持ち込むと auto-discover 経路と相互汚染する。

と DB 不変を採用している。設計判断として plan の「runtime 昇格 / DB 不変」のほうが副作用が小さく望ましいが、**A019 の文面と矛盾するので片方を直さないと artifact が嘘になる**。

**Recommendation**:
- plan の判断（runtime 昇格）を採用するなら、Step F で A019 §改訂検討事項の該当パラグラフを「DB は変更せず spawn 時のみ runtime で候補化する」と書き換える tasklet を追加する。
- A019 の文面を保ちたいなら、plan §D-1 を「DB 上で `selectable=1` に UPDATE する」に変更し、auto-discover 経路の冪等性（再 INSERT / 再 discover で衝突しないか）を確認する Step を追加する。

どちらでもよいが、planner 推奨は前者（runtime のみ昇格＋A019 文面更新）で問題ない。実装前に判断を確定させること。

#### M2. Project C 検証シナリオが plan の素朴解釈では満たせない

タスク仕様の受け入れ条件（task.md §検証シナリオ）は

> Project C (OSS): デフォルト K1 / pool 対象 K2, K3 すべて

だが、plan §Step E §Project C は

> `ossPoolTags=["any"]` のとき K1 のみ候補化する素朴解釈で実装し、K2/K3 を含めたい場合は `oss_pool_tags` を空に設定して「OSS は全 token 候補」というポリシーは別オプションとして切り出す。

を採用している。この実装ではテスト時に Project C の K2 (`tags=["org:A"]`) / K3 (`tags=["org:B"]`) は候補化されず、**受け入れ条件を満たせない**。plan 自身も「Open Question (実装時に確認)」と明記しているとおり、これは実装着手前に解決必須の宿題。

**Recommendation**: plan §4 Open Questions 表に追加し、「実装着手前に Master 経由で以下のいずれかに確定する」を明記:
1. Project C の K2/K3 を含めるため、`oss_pool_tags=["any","org:A","org:B"]` を Project C 用 yaml に書く運用とし、シナリオ例として明示する（global config の役割を逸脱するので Project C 個別 yaml/include 設定が必要 → 受け入れ条件と矛盾の可能性）
2. OSS 判定された project では `selectable=1` の全 token を候補化（exclude を除く）するポリシーを正式採用（A019 文面の追記必要）
3. 受け入れ条件「K2, K3 すべて」を例示として緩める（A019 の表の意図がそうである根拠を取る）

実装計画はどれを採用するかで Step C-2 の admit 判定 / Step E の test 期待値が変わる。**Open Question 解決→ plan 修正 → 実装** の順で進めること。

#### M3. Keychain 不在時の AGENT_TOKEN_BOUND と pool 計上が乖離する

plan §D-2 は「Keychain 不在 → env 注入スキップ + lease 維持 + AGENT_TOKEN_BOUND post（tokenStr 有無に関わらず）」を採用。意図は「pool 計上のために handle を記録する」だが、実 token は Master 環境継承（別 token）になるため、proxy 側で `auth_hash` から特定される `organization_id` は AGENT_TOKEN_BOUND が記録した handle とは別アカウントになり、**usage_snapshots / api_usage の計上先がズレる**。

A019 §改訂検討事項末尾は

> Keychain にない token が選ばれた場合は env 注入をスキップ（= Master 環境継承フォールバック）し、pool 計上のみ行う。

としているが、proxy が `organization_id` ベースで集計している以上、handle を AGENT_TOKEN_BOUND に流しても usage は Master の token に紐付いてしまうのが現実。**「pool 計上のみ行う」が意味する具体動作（lease は取る／AGENT_TOKEN_BOUND を post する／snapshot は更新しない）を spec 側で確定する**必要がある。

**Recommendation**:
- plan §D-2 に「Keychain 不在時:
  - lease は acquireLease の通常動作のまま（120 秒で自動 expire）
  - AGENT_TOKEN_BOUND を post するかは [選択A] post する（dashboard が handle を表示するため） / [選択B] post しない（実 token と乖離するため）から確定
  - usage_snapshots は proxy 経路で `organization_id` ベース更新なので、pool 側で何もしなくてよい
  - log は `token_pool_fallback reason=keychain_missing handle=@xxx` のみ」
  と動作を箇条書きで明記。
- 選択 A/B のどちらが望ましいかを plan §4 Open Questions に追加し、Master 確認後に実装。

### Minor

#### m1. `ProjectTokenPoolPolicy.enabled` フィールドが使われない

plan §A-1 の interface は

```ts
export interface ProjectTokenPoolPolicy {
  enabled: boolean;
  default: string | null;
  include: string[];
  exclude: string[];
}
```

だが、plan §A-1 仕様の「enabled は既存 resolveTokenPoolEnabled と独立（呼び側で OR 取る）。本関数は policy 整形のみ担当」と plan §D-2 の `if (poolDecision.enabled) { ... resolveProjectTokenPool(projectConfig) ... }` から、`enabled` は `poolDecision` 側で別経路解決される。`ProjectTokenPoolPolicy.enabled` は誰も参照しない。

**Recommendation**: interface から `enabled` を削除し、`{ default: string | null; include: string[]; exclude: string[] }` のみにする。

#### m2. artifact 更新を Conductor 完了処理に委譲する方針が CLAUDE.md と整合しない

plan §6 / §Step F は

> `.team/artifacts/` には直接書かない（A019 の `updated:` 日付は Conductor の完了処理で更新依頼を出す）

としているが、CLAUDE.md「Artifacts（知見の記録）」は明示的に

> | 誰が作る | … | 誰でも（直接ファイル作成）| |

と書いており、`.team/tasks/` のように CLI 経由必須の場所ではない（むしろ `.team/artifacts/` は直接編集する前提）。Conductor の `close-task` に artifact frontmatter 更新機能は現状ない。

**Recommendation**: Step F を「実装 Agent が `.team/artifacts/A019-token-pool-design.md` の `updated:` を `2026-04-DD` に直接書き換える（同コミットに含める）」に変更。さらに M1 の決定次第で、A019 §改訂検討事項の本文（`selectable=1` 昇格 vs runtime 昇格）も実装と整合する形に書き換える Step を Step F に統合。

#### m3. スケーラビリティ E2E がタスク仕様と乖離

タスク仕様 §テストは

> スケーラビリティ確認: 新 token / 新 project 追加が他に影響しないことを E2E で検証

だが、plan §3.5 は「手動 / smoke」と限定。E2E（cmux-team CLI 経由で `token add` → `spawn-agent` → 候補に入る／入らない確認）は手動でも構わないが、plan 上は

- unit テストで網羅される範囲（Project A/B/C シナリオ unit）
- 手動 smoke で確認する項目（実 cmux ペイン spawn / Keychain 経由 / `cmux-team token add` 〜 `spawn-agent` の通し）

を明確に分けて記述するべき。受け入れ条件としての「E2E で検証」が満たされた根拠を実装結果報告に書けるように。

**Recommendation**: plan §3.5 を 2 段構成にして、unit カバー範囲と手動 smoke チェックリストを別箇条書きに分離。

#### m4. selectToken の docstring 更新が plan 中に明示されていない

token-store.ts:705 の docstring「project_tags が空 / ["any"] の場合は全 selectable=1 が候補」は新シグネチャ（`SelectTokenPolicy`）下で書き換える必要がある（include/exclude/default/isOss の優先順位を反映）。plan §Step C は実装内容を書いているが docstring 更新は明示なし。

**Recommendation**: Step C に「token-store.ts:686-708 の docstring を新セマンティクス（policy 優先順位 / OSS 判定 / default 昇格）で更新する」を追加。

#### m5. `effectiveDefault` セマンティクスを A019 仕様にマップする説明が弱い

plan §C-2 「`effectiveDefault = isOss ? (projectDefault ?? ossDefault) : projectDefault`」は plan 独自の解釈。A019 §改訂検討事項では `oss_default` は「OSS の project default（git remote から OSS 判定された場合）」とあるが、project 側にも default が書かれている場合の優先順位（project default vs ossDefault）は明示なし。

**Recommendation**: plan §C-2 の `effectiveDefault` 計算式の直後に「project 側 default が明示されていれば OSS でも project default が優先される（OSS は global oss_default を fallback として補完するだけ）」と一文追加。これで A019 を読まなくても実装意図が伝わる。

#### m6. `resolveProjectContext` の primary_orgs=[] 既定動作が test ケースと不整合

plan §B-1 判定ロジックは「`primaryOrgs` が空 → isOss=false（旧動作維持。Open Q に従う）」、plan §B-3 test は「primary_orgs=[] → 全パターンで isOss=false」だが、plan §4 Open Questions の決定は「`primary_orgs` 未設定時の OSS 判定: **「全て non-OSS」**（旧動作維持）」と一致するので OK。

**Recommendation**: 文言整合性を確認するだけで実装影響なし（minor 中の minor）。

#### m7. include / exclude / default の case sensitivity が暗黙

plan §C-2 「include / exclude / default は handle 文字列マッチ（大文字小文字区別あり、A019 の handle 規約に従う）」とあり、A019 の「handle は小文字英数のみ」規約に依拠。だがユーザーが config で `"@A-Corp"` のように大文字混じりで書いた場合の挙動（reject? 自動 lowercase? 黙って unmatch?）は未定義。

**Recommendation**: plan §A-1 `resolveProjectTokenPool` の validate に「大文字を含む handle は warn して lowercase 化 or skip」を追加するか、plan §4 Open Questions に追加。

---

## Recommendations（Changes Requested 解消のために）

実装着手前に以下を解決して plan.md を更新してほしい:

1. **M1 決着**: 「`selectable=1` への DB 永続化 vs runtime 昇格のみ」を確定し、A019 §改訂検討事項の文面と plan §D-1 を一致させる。planner の推奨案（runtime 昇格・A019 を後追い更新）で問題なし。
2. **M2 決着**: Project C 受け入れ条件「K2, K3 すべて pool 対象」を満たす実装方針を Master 経由で確定し、Step C-2 の admit 判定 / Step E の test 期待値を確定する。3 つの選択肢（plan §M2 で列挙）から 1 つを決める。
3. **M3 決着**: Keychain 不在時の AGENT_TOKEN_BOUND post 有無を [A] post（dashboard 表示優先） / [B] post しない（usage 整合性優先） から選ぶ。usage_snapshots は proxy 経路で別途記録される事実を明記。
4. **m1〜m5 の minor 修正**: interface から不要フィールド削除 / artifact 更新 Step の方針変更 / E2E 記述の 2 段化 / docstring 更新 Step 追加 / `effectiveDefault` 説明補強。実装段階で並行対応可能。

これらの解消後、plan §1〜§7 の構造はそのまま流用でき、Step A〜F の TDD 進行も維持できる。Major 3 件は文書修正のみで解消するため、修正コストは小さい。
