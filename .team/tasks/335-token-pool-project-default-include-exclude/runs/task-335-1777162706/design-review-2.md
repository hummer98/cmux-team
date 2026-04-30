# Design Review #2 for plan.md (T335)

reviewer: conductor-335-reviewer2-1777164004
reviewed_at: 2026-04-26
reviewed_against:
  - .team/tasks/335-.../runs/task-335-1777162706/plan.md（改訂版）
  - .team/tasks/335-.../runs/task-335-1777162706/design-review.md（前回レビュー）
  - .team/artifacts/A019-token-pool-design.md（§改訂検討事項 2026-04-26）
  - skills/cmux-team/manager/token-store.ts:686-771
  - skills/cmux-team/manager/config.ts:15-263
  - skills/cmux-team/manager/project-tags.ts:1-167
  - skills/cmux-team/manager/main.ts:2669-2720
  - skills/cmux-team/manager/token-store.test.ts:1058-1149

## 判定: Approved

前回レビューで指摘した Major 3 件（M1〜M3）はいずれも Conductor の確定判断（runtime 昇格のみ・DB 不変 / OSS は exclude のみ尊重で全 selectable=1 を admit / Keychain 不在でも AGENT_TOKEN_BOUND post）に従って plan 全体に反映されており、Minor 7 件（m1〜m7）も対応箇所に「m1 反映」「m2 反映」… のタグつきで具体的に書き込まれている。新たな矛盾・不整合は混入していないため、実装着手して問題なしと判断する。実装段階で気づいた小さな指摘（後述「実装時メモ」）だけ記録する。

---

## M1〜M3 反映状況

### M1: project default の auto-discover 連携 → runtime 昇格のみ・DB 不変

| 反映場所 | 内容 | OK |
|---|---|---|
| 冒頭 §「M1〜M3 確定判断」 | 「project default の auto-discover 連携は runtime 昇格のみ・DB 不変」と明示 | ✅ |
| §1.4「改訂が必要な点」 | 「default の runtime 昇格 / OSS 候補から由来」が来る経路として整理 | ✅ |
| §Step C-2「重要設計判断」 | `selectable=0` の token は default として明示参照される場合のみ runtime 候補化、DB 上の `selectable` は書き換えない、と本文で明記 | ✅ |
| §Step C-2 ロジック疑似コード | `if (!token.selectable && token.handle != effectiveDefault) continue` で selectable=0 の素通し条件をコード上で表現 | ✅ |
| §Step D-1 | runtime 昇格を採用する根拠（auto-discover 経路との相互汚染回避 / 複数 spawn の DB 不変保証 / lease 120 秒で衝突回避）を補強 | ✅ |
| §Step F | A019 §改訂検討事項「project default の auto-discover 連携」の文面を「DB 上の selectable は変更せず… runtime（in-memory）で候補化する」に書き換える指示が具体化されている | ✅ |
| §3.4 U5 / U6 / §3.6 E5 / E6 | selectable=0 + default 一致は admit / 不一致は候補外、を unit でカバーすると明記 | ✅ |
| §5.4 リスク | 「runtime 昇格の副作用なし」を明記、複数 spawn 同時取得時の動作も整理 | ✅ |

→ A019 と plan の挙動矛盾は Step F で解消される構造になった。**完全反映**。

### M2: OSS project では `selectable=1` の全 token を候補化（exclude のみ尊重）

| 反映場所 | 内容 | OK |
|---|---|---|
| 冒頭 §「M1〜M3 確定判断」 | 「OSS project では selectable=1 の全 token を候補化（exclude のみ尊重）。`oss_pool_tags` は廃止」を明示 | ✅ |
| §1.2「改訂が必要な点」 | 「`oss_pool_tags` は廃止（M2 確定）。OSS 判定後の候補抽出は selectToken 側のロジックで完結」と明記 | ✅ |
| §Step A-2 | `GlobalConfig.tokenPool` schema は `enabled / ossDefault / primaryOrgs` の 3 フィールドのみ（`ossPoolTags` を意図的に除外）と「**M2 反映**」タグつきで明記 | ✅ |
| §Step C-2 admit ロジック | `else if (isOss) { admitted = true }`（OSS は selectable=1 全 admit、exclude 最優先） | ✅ |
| §Step C-2「重要設計判断」 | 「OSS project では selectable=1 の全 token を候補化（exclude のみ尊重、tag 不問）。oss_pool_tags のような中間設定はない」を明記、Project C 受け入れ条件との対応を補足 | ✅ |
| §Step E Project C | 3 ケース（全候補化 / @personal ブロック → @a-corp / exclude=[@b-corp]）が新ルールで成立する設計 | ✅ |
| §Step F | A019 から `oss_pool_tags` を削除し global schema を 3 フィールドのみに揃える指示 / 「Project C: K2, K3 すべて」が単純ルールで満たされる旨の補足、を Step F に記述 | ✅ |
| §5.1 変更ファイル表 | config.ts 行に「`oss_pool_tags` は追加しない」を明示 | ✅ |

→ 受け入れ条件「Project C: K2, K3 すべて pool 対象」を `isOss=true` 単独で満たすシンプル設計に統一された。**完全反映**。

### M3: Keychain 不在時も AGENT_TOKEN_BOUND を post（dashboard 表示優先）

| 反映場所 | 内容 | OK |
|---|---|---|
| 冒頭 §「M1〜M3 確定判断」 | 「Keychain 不在時も AGENT_TOKEN_BOUND を post、env 注入のみスキップ」を明示 | ✅ |
| §1.4「改訂が必要な点」 | 「Keychain にない handle が選ばれた場合は CLAUDE_CODE_OAUTH_TOKEN 注入をスキップし token_pool_fallback(reason=keychain_missing) を warn 出力。AGENT_TOKEN_BOUND は post（M3）」を明記 | ✅ |
| §Step D-2 コード例 | `tokenStr` が `null` でも `postMessage({ type: "AGENT_TOKEN_BOUND", ... })` を必ず実行する形になっている | ✅ |
| §Step D-2「M3 確定動作」箇条書き | lease/AGENT_TOKEN_BOUND/env 注入/usage_snapshots/log の 5 項目を全て確定動作として明示 | ✅ |
| §Step F | A019 §改訂検討事項「Keychain 不在時のフォールバック」を 5 項目箇条書きで再記述する指示 | ✅ |
| §3.4 U（暗黙）/ §3.6 E7 | 「env 注入スキップ + AGENT_TOKEN_BOUND post + token_pool_fallback(reason=keychain_missing) + lease は維持」をエッジケースとして列挙 | ✅ |
| §3.5 smoke-5 | 手動 smoke チェックリストに Keychain 不在シナリオ（@phantom）を 5 項目（warn ログ / env 非注入 / dashboard handle 表示 / lease 120 秒 expire）で具体化 | ✅ |
| §5.4 リスク | 「Keychain 不在時の usage 計上ズレ」の許容範囲（仕様上 accept）を明文化 | ✅ |

→ post する動作が選択され、関連動作（lease / usage / log）まで一貫した形で全箇所に伝播。**完全反映**。

---

## Minor 反映状況

### m1: `ProjectTokenPoolPolicy.enabled` 削除

§Step A-1 の interface から `enabled: boolean` が削除され、`{ default: string | null; include: string[]; exclude: string[] }` のみになっている。直後の引用で「**m1 反映**: `enabled` フィールドは含めない（呼び側は別経路の `resolveTokenPoolEnabled` で解決する）。`ProjectTokenPoolPolicy` は **policy 整形のみ** を担当する」と理由まで記述されている。✅

### m2: artifact 更新を実装 Agent 直接編集に切替

§Step F 冒頭で「**m2 反映**: artifact の編集は CLAUDE.md「Artifacts」§の「直接ファイル作成」規約に従い、実装 Agent が `.team/artifacts/A019-token-pool-design.md` を直接編集する（同じコミットに含める）」と明示。さらに §6 作業境界でも「`.team/artifacts/A019-token-pool-design.md` は実装 Agent が直接編集する（m2 反映、CLAUDE.md「Artifacts」§の「直接ファイル作成」規約に従う）」と境界として再宣言、§7 commit 6 でも「Step F (A019 文面整合 + updated 日付) ← 同 PR 内で実装と一緒にコミット」と明記。✅

### m3: スケーラビリティ E2E をテスト記述で 2 段化

§3.4 と §3.5 が明確に分離されている:

- §3.4「Unit テスト カバー範囲（m3 反映 §1/2）」: U1〜U12 の 12 ケース表（test 場所も付与）
- §3.5「手動 smoke チェックリスト（m3 反映 §2）」: smoke-1〜smoke-5 の手動 5 項目（特に smoke-3 が「新 token 追加が他に影響しないことを E2E で検証」を担保）

「受け入れ条件としての E2E が満たされた根拠を実装結果報告に書ける」状態になっており、レビュー指摘の 2 段化要求に応えている。✅

### m4: selectToken docstring 更新を Step C に追加

§Step C-1 末尾で「**m4 反映**: token-store.ts:686-708 の docstring を新セマンティクス（policy 優先順位 / OSS 判定 / default 昇格）に書き換える」と明記。さらに 5 段階の優先順位（exclude → default → include → 残り（OSS 全 admit / 非 OSS は tag マッチ） → score）を docstring に反映するための具体的な記述順序まで提示されている。✅

### m5: `effectiveDefault` セマンティクス補強

§Step C-2 疑似コードに「project 側 default が明示されていれば OSS でも project default が優先される。OSS は global oss_default を fallback として補完するだけ。（m5 反映）」とコメント追加。下の重要設計判断にも本文として再掲、§3.4 U12 として unit テストケース「effectiveDefault は projectDefault 優先（OSS でも）」を追加、§Step E にも「Project A: default 高負荷 → include の @personal が選ばれる」「Project C: default は ossDefault fallback」のテストとして明示的に検証される。✅

### m6: `primary_orgs=[]` 既定動作の整合性確認

§Step B-1 / §Step B-3 / §4 Open Questions で「`primaryOrgs` が空 → `isOss=false`（旧動作維持）」が完全に揃っている。§Step B-3 では「primary_orgs=[] → 全パターンで isOss=false（**m6 整合確認**: plan §4 Open Questions と一致）」と明示的に整合性チェックを文中に書き込んでいる。✅

### m7: 大文字混じり handle の挙動定義

§Step A-1 末尾に「**handle case sensitivity（m7 反映）**」§として「A-Z を含む handle は `console.warn` で `[token-pool] config_warning: handle 'XX' contains uppercase letters; ...` を出すが、自動 lowercase 化や reject はしない。そのまま返してマッチ失敗扱いにする（DB 側の handle が小文字英数のみなので結果として候補化されない）」と挙動を完全定義。§Step C-2 重要設計判断・§4 Open Questions・§3.4 U10・§3.6 E11 にも整合内容で再掲。✅

---

## 検証シナリオの満たし方（Project A/B/C）

| シナリオ | 受け入れ条件 | plan のカバー方法 | 評価 |
|---|---|---|---|
| Project A | default=K2(@a-corp) / include=K1(@personal) / K3(@b-corp) は候補外 | §Step E の 3 ケースで「default 最優先」「default 高負荷時の include 候補化」「include 未指定 + 不一致 tag → 候補外」を直接テスト | ✅ |
| Project B | tokenPool.enabled=false → 機能 OFF | §Step A-3 の `config.test.ts` で `isTokenPoolEnabled=false` を確認、§Step E では「selectToken の責務外」として明示的に責務分離 | ✅ |
| Project C (OSS) | default=K1 / pool 対象 K2, K3 すべて | §Step E の 3 ケースで「全候補化 + 最低 score の K1 が選ばれる」「K1 ブロック → K2 admit」「exclude=[@b-corp] → K1/K2 のみ」をカバー。M2 ロジック（OSS は selectable=1 全 admit）により K3 候補化も自動的に保証 | ✅（後述: K3 単独選択テストは無いが M2 ロジックで間接保証） |

→ 全シナリオが unit テストで構造的に満たせる。

---

## TDD 単位の粒度・既存実装との整合性

- §Step A〜E が test-first で個別に緑にできる単位に分割されており、§7 commit 計画も Step ごとの commit 1〜6 に対応 ✅
- §Step C-1 で `policy?: SelectTokenPolicy | string[]` の後方互換 union を維持、既存 `selectToken (tags フィルタ)` 6 ケースを無変更で pass させる戦略は妥当 ✅
- §3.3 で `resolveProjectTags` wrapper / `resolveTokenPoolEnabled` の既存テスト非回帰を明示 ✅
- §1.1〜§1.5 の現行コード参照（行番号含む）が前回レビュー時と同じ箇所を指しており、改訂による drift なし ✅

---

## 新規 Findings（Major / Critical）

なし。Major 3 件・Minor 7 件のすべてが解消されており、A019 文面の更新も Step F に明示。

---

## 実装時メモ（Minor 以下、Approved を覆さない）

実装段階で気をつけると良い細部。**plan の修正は不要**だが、実装 Agent への申し送りとして記録する。

### N1. `loadConfig` が `null` / 空オブジェクトを返した場合の `resolveProjectTokenPool` 入力型

§Step A-1 の signature は `resolveProjectTokenPool(projectConfig: TeamConfig)` だが、`loadConfig` が `.team/config.json` 不在時に `null` を返すか `{}` を返すかは plan 内に記載がない。実装時に:

- `loadConfig` の戻り値を `Promise<TeamConfig | null>` で確認
- `resolveProjectTokenPool` の引数を `TeamConfig | null | undefined` に許容するか、呼び側 (`cmdSpawnAgent`) で `?? {}` する

のどちらかを採用。Minor で plan 上は意図が明確なので Approved を保留しない。

### N2. Project A テスト 3 (`expect(sel).toBeNull()`) の seed が要詳細化

§Step E Project A テスト 3 のコードコメントで `acquireLease(db, /* k2.id 相当の token */, "h2", ...)` と書いているが、seedThreeKeys の戻り値の k2 を分割代入していない。実装時に `const { k1, k2 } = seedThreeKeys(db); acquireLease(db, k2.id, "h2", ...)` のように整える必要あり。テスト記述上の細部であり挙動には影響しない。

### N3. K3 (`@b-corp`) が単独で選ばれる確認は M2 ロジックで間接保証

Project C テストで「K3 が候補化されている」を直接検証するケースはない（テスト 3 で exclude=[@b-corp] と除外している）。「K2 (@a-corp) は @personal 高負荷時に admit される」を検証するテスト 2 と、admit ロジック（`else if (isOss) admitted = true`）の構造的単純さで実質保証される。明示的 K3 selection テストを追加しても無害だが、必須ではない。

### N4. `resolveGlobalTokenPool` の戻り値型

§Step A-2 で `globalConfig: GlobalConfig | null` と null 許容しているが、戻り値型 `GlobalTokenPoolPolicy` の `ossDefault: string | null; primaryOrgs: string[]` は OK。`globalConfig=null` のとき `{ ossDefault: null, primaryOrgs: [] }` を返す既定動作を実装時に揃える。

### N5. handle 大文字混入時の warn ログのキー名

§Step A-1 / §3.6 E11 で `[token-pool] config_warning: ...` というログ prefix が示されているが、既存の token-pool warn ログ（`token_pool_skipped` / `token_pool_fallback` / `token_pool_assigned`）と prefix の流儀が異なる（前者は `[token-pool] ` prefix、後者は kebab スネーク）。実装時に既存 logger style に合わせるか別 prefix を採用するかを統一。Minor。

---

## 結論

判定: **Approved**

実装着手して構わない。Step A → Step B → Step C → Step D → Step E → Step F の順で 6 commit、各 commit で `bun test` 緑、Step D 以降で §3.5 の手動 smoke を実施し結果を実装結果報告に記載すること。実装時メモ N1〜N5 は実装 Agent が現場判断で解消可能なレベル。
