<!-- Revision 2: design-review-r1.md 反映 -->
# T349 実装計画: token add/promote/rotate で rateLimitTier 取得失敗時に plan を対話入力させる

## 1. 背景・目的

現状の `cmux-team token add` / `token promote` の手動入力経路（source=2、または source=1 でも稀に rateLimitTier が欠落するケース）では `plan` が `unknown` のまま登録され、`plan_ratio` が NULL になり capacity 計算に乗らない。ユーザーは登録後に `cmux-team token set-plan @xxx <plan>` で訂正する 2 ステップ運用を強いられている。本タスクでは、登録確定前に `rateLimitTier` 由来で plan が解決できなかった場合のみ追加の対話 prompt を表示し、ユーザーに `plan` をその場で選ばせることで 1 ステップ化する。

## 2. 影響箇所の特定

ファイル: `skills/cmux-team/manager/token-cli.ts`

| 関数 | 行（main HEAD 時点） | 現状の plan/ratio 解決 |
|------|---------------------|------------------------|
| `cmdTokenAdd` | L128〜L242（具体的 plan 解決は L176〜L186） | `rateLimitTier ? PLAN_MAP[tier] : undefined` を直書き、`plan` / `planRatio` を変数で組み立て、`Found credential:` ログ出力後に handle / tags prompt → DB insert |
| `cmdTokenPromote` | L461〜L593（plan 解決は L565〜L568） | 同上のロジックを直書き。完了メッセージで `plan === "unknown"` 時に `Hint: ... set-plan ...` を表示するブロック (L584〜L589) あり |
| `cmdTokenRotate` | L362〜L409 | **plan / plan_ratio を一切更新しない**。auth_hash のみ書き換える。source 選択 UI も add/promote とは別形（"1" or 直接 token 貼付け） |
| `PLAN_MAP` | L40〜L44 | tier → {plan, ratio} の 1 方向マップ。3 エントリ（max-x20 / max-x5 / pro） |
| `cmdTokenSetPlan` | L415〜L447 | 自前の `validPlans` (L424〜L428) を保持。plan 名 → ratio の逆方向マップ。同じ値が PLAN_MAP に重複している |
| `prompt` helper | L46〜L50 | readline.question を Promise 化するシンプル util |

テストファイル: `skills/cmux-team/manager/token-cli.test.ts`
- readline は top-level で `mock.module("readline", ...)` 済み。`askAnswers` 配列を `setReadlineAnswers(...)` で詰め替えるだけで複数 prompt をシーケンシャルに mock 可能（L45〜L55, L103〜L106）。
- fetch は `withMockedFetch(orgId, fn)` ヘルパで probe をスタブ（L204〜L217）。
- `process.exit` は `TestExitError` で例外化済み、`consoleErrors` で stderr を捕捉済み（L108〜L173）。
- 既存の `R-promote-2` (L736〜L761) は manual + tags 入力で plan=unknown を期待しており、本タスクの修正で **挙動が変わる** ため改修が必要。

## 3. 設計判断

### 3.1 prompt 文言

タスク本文の例文をそのまま採用する（既存 prompt の語感に整合）:

```
plan (pro / max-x5 / max-x20, Enter で unknown): 
```

placement は `Found credential:` ログブロックの直後・`display name` prompt の直前。既存 UI で `rateLimitTier: ... → plan: ...` 行が出ていたスロットを「rateLimitTier 由来の plan が解決できないときに対話入力で埋める」形に置き換える。

### 3.2 plan/ratio 解決ロジックの統合（重複排除）

PLAN_MAP（tier → {plan, ratio}）と `validPlans` (set-plan 内の plan 名 → ratio) と新規対話 prompt の入力検証で、3 系統の重複を作らない。本タスクで **必須** とするのは以下の 1〜2 のみ。3 は **optional（本タスクでは採用しない）** とする。

1. **【必須】共通定数 `PLAN_BY_NAME` を新設**: PLAN_MAP の値を再利用する plan 名キーのマップ。

   ```ts
   const PLAN_BY_NAME: Record<string, { plan: TokenPlan; ratio: number }> = {
     pro: PLAN_MAP.default_claude_pro,
     "max-x5": PLAN_MAP.default_claude_max_5x,
     "max-x20": PLAN_MAP.default_claude_max_20x,
   };
   ```

   これにより plan 名 → {plan, ratio} の真実は PLAN_MAP に一本化される。`PLAN_BY_NAME` のキー集合がそのまま「ユーザーが手で入力できる plan 名一覧」になる。**用途は `promptManualPlan` 内のみ**（手入力検証）。

2. **【必須】共通 helper を抽出**: `resolvePlanForRegistration(rl, rateLimitTier)` を導入し、`cmdTokenAdd` と `cmdTokenPromote` から呼ぶ。詳細仕様は §3.6 を参照（**ログ出力責務も helper に内包する**）。

   ```ts
   async function resolvePlanForRegistration(
     rl: ReturnType<typeof createInterface>,
     rateLimitTier: string | undefined,
   ): Promise<{ plan: TokenPlan; planRatio: number | null }> {
     const fromTier = rateLimitTier ? PLAN_MAP[rateLimitTier] : undefined;
     if (fromTier) {
       // rateLimitTier ありかつ PLAN_MAP に該当エントリあり → ログ出力 + 即解決
       console.log(
         `  rateLimitTier: ${rateLimitTier}  → plan: ${fromTier.plan} (ratio ${fromTier.ratio.toFixed(1)})`,
       );
       return { plan: fromTier.plan, planRatio: fromTier.ratio };
     }
     // rateLimitTier 未取得 / 未知 tier → ログ出力せず prompt（§3.6）
     console.log(""); // Found credential: ブロックと prompt の間の空行
     return promptManualPlan(rl);
   }

   async function promptManualPlan(
     rl: ReturnType<typeof createInterface>,
   ): Promise<{ plan: TokenPlan; planRatio: number | null }> {
     for (;;) {
       const ans = (await prompt(rl, "plan (pro / max-x5 / max-x20, Enter で unknown): ")).trim();
       if (ans === "") return { plan: "unknown", planRatio: null };
       const entry = PLAN_BY_NAME[ans];
       if (entry) return { plan: entry.plan, planRatio: entry.ratio };
       console.error("Error: pro / max-x5 / max-x20 のいずれかを入力してください（空 Enter で unknown）");
     }
   }
   ```

3. **【optional・本タスクでは採用しない】set-plan の `validPlans` を `PLAN_BY_NAME` に差し替える**。
   - **判断**: 本タスクでは `validPlans` を残す（差し替えない）。
   - **理由**:
     1. 本タスクの主目的は「rateLimitTier 取得失敗時の prompt 追加」であり、set-plan 内部の refactor は scope creep。
     2. コミット粒度・差分レビューを簡明に保つ（feat と refactor を混ぜない）。
     3. `validPlans` と `PLAN_BY_NAME` は値が同じだが構造が微妙に違うため（前者は `Record<string, number>`、後者は `Record<string, { plan, ratio }>`）、差し替え時に Type Narrowing の挙動差を全テストで担保する追加コストがある。
   - **将来対応**: 別タスクで `refactor(token): unify plan map between set-plan and add/promote` として分離して扱う。

### 3.3 不正値時の挙動: 再入力ループ vs exit 1

**再入力ループを採用する。** 理由:

- `add` / `promote` は organization_id probe（外部 HTTP 8s タイムアウト）を既に通過した後に plan prompt が出る。ここで exit 1 にすると probe からやり直しになり、UX が悪い。
- 再入力ループ中も「空 Enter = unknown」のエスケープハッチがあり、ユーザーは確実に登録完了に到達できる。
- 無限ループのリスクは低い: stdin が EOF を返したら readline は空文字を返す（テストの mock も `askAnswers.shift() ?? ""` で同じ振る舞い）→ 空 Enter 扱いで `unknown` 確定 → ループ脱出。
- エラーメッセージは `console.error` で stderr に出して同じ prompt をもう一度呼ぶ。

### 3.4 `cmdTokenRotate` の取り扱い: **本タスクの scope 外**とする

調査結果:
- rotate 関数は `auth_hash` のみ更新し、`plan` / `plan_ratio` を一切触らない（L405 の UPDATE 文）。
- source 選択 UI が add/promote とは別形式（"1" を入力すれば credential 再取得、それ以外は入力された文字列をそのまま token として扱う）。明示的な「source=2」ステップは存在しない。
- credential 経路で取得した `cred.rateLimitTier` も使われていない（L385 で捨てられている）。

判断: rotate に plan 更新ロジックを後付けするのは「token rotate の責務 = 期限切れ token のすげ替え」を超えた挙動変更になる。capacity 訂正は既に `set-plan` という専用コマンドが存在する（DRY 原則）。conductor-prompt §3 でも「`cmdTokenRotate`（要確認、source=2 経路があるか）」と明示的に planner の判断に委ねており、調査の結果「該当する source=2 経路は存在せず、plan 更新の責務もない」が結論である。

実装: rotate には変更を入れない。テストの T5 系は **promote のみ** をカバーする。plan.md の本ドキュメントでこの判断を明記したので、レビュー時に説明可能。

### 3.5 完了メッセージのヒント文

- `cmdTokenAdd`: 既存実装にヒント文は **無い**。本タスクでも追加しない（タスク文言「unknown 時は従来通り表示 = add は従来通り何も表示しない」）。
- `cmdTokenPromote`: 既存のヒント文（L584〜L589）は `plan === "unknown"` のときだけ表示する条件分岐を保持。共通 helper 経由で plan が確定した場合は自動的に `plan !== "unknown"` になり、ヒントは出ない。**条件式は変更不要**で、新仕様にそのまま整合する。
- `cmdTokenRotate`: 変更なし。

### 3.6 `Found credential:` ログ整合と未知 tier 境界条件

#### 3.6.1 ログ出力責務の置き場所

**設計判断: 「rateLimitTier 行ログ」と「`Found credential:` ブロックと prompt の間の空行」の出力責務は `resolvePlanForRegistration` helper に内包する**。理由:

- 呼び出し側（`cmdTokenAdd` / `cmdTokenPromote`）は `Found credential:\n  organizationId: ...` までを出力し、`resolvePlanForRegistration` を呼ぶだけ。
- helper の中で「rateLimitTier 由来で解決できたか」「prompt が必要か」が分岐し、それに対応するログ・空行・prompt を一括で扱う。これにより呼び出し側の本体から分岐ロジックが消え、CLAUDE.md「決定論的なものはコードで」の精神に整合する。
- 後で挙動を変える際に修正点が helper 1 箇所に集まる。

#### 3.6.2 境界条件: `rateLimitTier` あり / `PLAN_MAP[rateLimitTier]` undefined

タスク本文「`rateLimitTier` 取得失敗時のみ prompt 表示」は 2 通りに解釈できる:

| 解釈 | 動作 |
|------|------|
| 前者: `rateLimitTier === undefined` のときのみ prompt | rateLimitTier はあるが PLAN_MAP に無い場合は `unknown` で確定（既存挙動維持） |
| 後者: `rateLimitTier` 由来の plan が解決できない場合（undefined または PLAN_MAP に無い）に prompt | 未知 tier も prompt 対象 |

**Planner の判断: 後者を採用する**。理由:

- 本タスクの真の目的は「`unknown` で登録される問題の解消」。前者だと未知 tier がそのまま `unknown` で登録され、結局 set-plan で訂正する 2 ステップ運用が残る。これでは本タスクの価値が半減する。
- 未知 tier は「Anthropic 側で新しい料金プランが追加された」状況で発生する。ユーザーが現場で `pro / max-x5 / max-x20` のどれにマップするかをその場で判断できれば、コード修正を待たずに登録できる。
- 後者でも空 Enter の escape hatch があるため、ユーザーが「分からない」場合は従来どおり `unknown` で登録できる。

#### 3.6.3 ログレイアウト

`resolvePlanForRegistration` 内の出力順序:

```
\nFound credential:                              # 呼び出し側で出力済み
  organizationId: <uuid>                        # 呼び出し側で出力済み
  rateLimitTier: <tier>  → plan: <plan> (ratio X.X)
                                                # ↑ helper 内: fromTier がある場合のみ。出力後 return
                                                # ↓ helper 内: fromTier が無い場合（rateLimitTier undefined または未知 tier）

                                                # console.log("") で空行（§3.6.1 の責務）
plan (pro / max-x5 / max-x20, Enter で unknown):  # promptManualPlan が出力
```

ポイント:

1. `rateLimitTier` 行ログは **`PLAN_MAP[rateLimitTier]` が undefined でない場合のみ** 出す。**未知 tier の場合は出さない**（後者解釈）。
2. prompt 表示時は `Found credential:` の `organizationId:` 行と prompt の間に **空行を 1 行入れる** （`console.log("")`）。視認性向上のため。
3. `display name` prompt は呼び出し側で従来どおり出力する（helper の責務外）。

#### 3.6.4 テストケース追加

- **T6（新規）**: source=1（credentials 経路）で `rateLimitTier="default_claude_max_50x"`（未知 tier）のクレデンシャルを `writeClaudeCredentials` で配置 → plan prompt に `max-x20` を入力 → `plan="max-x20"` / `plan_ratio=20.0` で登録され、`consoleLogs` に未知 tier の rateLimitTier 行ログが含まれない（`not.toContain("rateLimitTier:")` または `not.toContain("default_claude_max_50x")`）ことを assert。

## 4. 実装ステップ（TDD 順）

`skills/cmux-team/manager/` を作業対象とする（worktree 内）。

### Step 1: 失敗テストを先に追加 (Red)

`skills/cmux-team/manager/token-cli.test.ts` に以下を追加。各テストは現行実装では fail することを `bun test --timeout 30000 token-cli.test.ts` で確認する。

- `cmdTokenAdd (integration)` describe ブロックに:
  - **T1**: source=2 で plan prompt に `max-x20` を入力 → DB の `plan="max-x20"` / `plan_ratio=20.0`
  - **T2**: source=2 で plan prompt に空 Enter → DB の `plan="unknown"` / `plan_ratio=null`、かつ `consoleLogs` の冒頭が `"Found credential:"` で始まり、`organizationId:` 行と plan prompt 行の間に **空行** が入っていることを assert（§3.6.1）
  - **T3**（テスト名 `"wrong-plan"` で統一）: source=2 で plan prompt に `wrong-plan` を入力 → エラー出力 → 続けて `max-x5` → `plan="max-x5"` / `plan_ratio=5.0`、`consoleErrors.join("\n")` が `"pro / max-x5 / max-x20"` を **部分一致** で含むことを assert（§5 参照）
  - **T4**: source=1（writeClaudeCredentials で rateLimitTier="default_claude_max_20x" を仕込み）で readline 回答に plan 入力を含めない → `plan="max-x20"` で正常完了。**かつ `consoleLogs.join("\n")` が `"plan (pro / max-x5 / max-x20"` を含まない**ことを assert（誤って prompt が出ていないかの explicit 検証）
  - **T6（新規・§3.6.4）**: source=1 で rateLimitTier="default_claude_max_50x"（未知 tier）→ plan prompt に `max-x20` → `plan="max-x20"` / `plan_ratio=20.0`、`consoleLogs.join("\n")` が `"default_claude_max_50x"` を含まない（未知 tier ログが出ていないこと）を assert

- `cmdTokenPromote (integration)` describe ブロックに:
  - **T5a**: source=2 で plan prompt に `max-x20` を入力 → `plan="max-x20"` / `plan_ratio=20.0`、ヒント文が出ない（`consoleLogs.join("\n")` が `"set-plan"` を含まず、かつ `"Hint:"` も含まない）ことを assert
  - **T5b**: 既存 `R-promote-2` を改修。回答列に空 Enter（plan prompt に空 Enter を返して plan=unknown を確定する入力）を 1 つ追加して挙動を維持しつつ、新 prompt が呼ばれることを実装側に強制する

### Step 2: 共通定数・helper を実装 (Green Part 1)

`token-cli.ts`:
- `PLAN_MAP` の直後に `PLAN_BY_NAME` を追加（PLAN_MAP の値を re-export）
- `prompt` helper の直後に `promptManualPlan(rl)` と `resolvePlanForRegistration(rl, rateLimitTier)` を追加（§3.2 のコード例どおり、ログ出力責務は helper に内包）
- **`validPlans` には触らない**（§3.2 step 3 を optional 扱いとし、本タスクでは採用しない）

### Step 3: cmdTokenAdd の plan 解決を helper 呼び出しに置き換える (Green Part 2)

`cmdTokenAdd`:
- `Found credential:` ログ + `organizationId:` 行は呼び出し側に残す
- `planEntry`/`plan`/`planRatio`/`planLabel` の直書き計算を削除
- **既存の `if (rateLimitTier)` 内の `console.log("  rateLimitTier: ...")` 行は削除**（責務を helper に移譲したため）
- 直後に `const { plan, planRatio } = await resolvePlanForRegistration(rl, rateLimitTier)` を追加
- DB insert 時の `plan` / `plan_ratio` パラメータはそのまま（変数名は変えない）

### Step 4: cmdTokenPromote の plan 解決を helper 呼び出しに置き換える (Green Part 3)

`cmdTokenPromote`:
- L565〜L568 の `planEntry` / `plan` / `planRatio` 計算を `await resolvePlanForRegistration(rl, rateLimitTier)` に置き換える
- `Found credential:` 系のログも cmdTokenAdd 同様、rateLimitTier 行のみ helper に移譲
- 既存の `if (plan === "unknown") { ヒント文 ... }` ブロック（L584〜L589）はそのまま残す（新 prompt で plan が確定すれば自動的に通らない）

### Step 5: tests を full pass させる (Green Part 4)

`bun test --timeout 30000 token-cli.test.ts` が green になることを確認。失敗時は helper / 呼び出し側を調整する。**set-plan の既存 3 テスト**（unknown→max-x20 / 不正 plan exit 1 / 不存在 handle exit 1）が無改造で全 pass することも明示的に確認する（§3.2 step 3 を採用しないため変化はないはずだが念のため）。

### Step 6: リファクタ・周辺整合 (Refactor)

- 共通 helper の docstring を充実させる
- `docs/spec/09-token-pool.md` の **CLI コマンド** セクションに新 prompt の挙動を 1 段落追記（`token add` / `token promote` 双方、未知 tier も prompt 対象である旨を含む）
- 不要になった import / 一時変数を整理

### Step 7: バリデーション

- `cd skills/cmux-team/manager && bun test --timeout 30000 token-cli.test.ts` で green
- `bunx tsc -p . --noEmit`（または既存の type check コマンド）で型エラー無し
- 手元の dry run（任意）: `KEYCHAIN_TEST_MODE=1 TOKEN_STORE_DB_PATH=$(mktemp -d)/t.db bun run -- skills/cmux-team/manager/token-cli.ts ...` で対話 prompt の見え方を目視確認

## 5. テスト計画詳細

### 標準入力 mock の与え方

readline mock は `askAnswers` 配列を順次 shift して返すだけ。新 prompt が増えるテストでは plan 入力を該当位置に挿入するだけで足りる。具体例:

| テスト | `setReadlineAnswers(...)` 引数 | コメント |
|--------|-------------------------------|----------|
| T1 | `"2", "tok-T1", "max-x20", "personal", "any"` | source=2、token、**plan**、display name、tags |
| T2 | `"2", "tok-T2", "", "personal", "any"` | plan 空 Enter で unknown 確定 |
| T3 | `"2", "tok-T3", "wrong-plan", "max-x5", "personal", "any"` | 不正値 `"wrong-plan"` → 再入力 → max-x5 |
| T4 | `"1", "personal", "any"` | rateLimitTier=default_claude_max_20x のクレデンシャルを `writeClaudeCredentials` で事前配置。**plan 入力は不要**（prompt が出ないことを assert） |
| T6 | `"1", "max-x20", "personal", "any"` | rateLimitTier=default_claude_max_50x（未知 tier）。plan prompt に `max-x20` を入力 |
| T5a | promote: `"2", "tok-T5a", "max-x20", "any"` | promote の現状回答列 `"2", token, tags` の間に plan を挟む |
| T5b | promote: `"2", "tok-T5b", "", "any,kddi"` | 既存 `R-promote-2` 互換。plan prompt に空 Enter を返す回答（plan=unknown 確定） |

### エラーメッセージの assert 方針

`promptManualPlan` のエラーメッセージは `"Error: pro / max-x5 / max-x20 のいずれかを入力してください（空 Enter で unknown）"` だが、文言の細かいズレ（句点・括弧・前後修飾）でテストが脆くならないよう、**テスト側は部分一致** で書く:

```ts
expect(consoleErrors.join("\n")).toContain("pro / max-x5 / max-x20");
```

これによりコード側が文言を微調整しても assertion が通る。

### Hint 非表示の assert 方針

T5a の Hint 検証は **2 つの部分一致を併用** する:

```ts
expect(consoleLogs.join("\n")).not.toContain("set-plan");
expect(consoleLogs.join("\n")).not.toContain("Hint:");
```

これにより「ヒント文が出ていない」意図がテストから明確になる。

### Found credential: レイアウトの assert 方針

T2 では `consoleLogs` 配列の中で `"Found credential:"` を含む要素の次の要素以降が「`organizationId:`」「（空行）」「`plan (pro / max-x5 / max-x20...)`」の順に並んでいることを assert する。具体的には `consoleLogs.join("\n")` の中で正規表現 `/Found credential:[\s\S]*organizationId:.*\n\nplan \(pro/` のように **空行が入っていること** を確認する（または該当 index の文字列が `""` であることを `consoleLogs[i+2] === ""` の形で検証）。

> 注: prompt 文字列（`plan (pro / max-x5 / max-x20, ...)`）は readline が `console.log` ではなく内部の write で出すので `consoleLogs` には載らない可能性がある。テスト実装時に readline mock が prompt 文字列を `consoleLogs` に push する作りなのか、別経路なのかを確認した上で assert を書く。**もし readline mock が prompt を捕捉しない場合は、空行 (`console.log("")`) が `consoleLogs` の末尾に push されていることだけ assert する**（プロンプト本体は `setReadlineAnswers` の動作で間接的に検証済み）。

### fetch mock

T1〜T5a / T6 は既存の `withMockedFetch("org-...", fn)` パターンをそのまま使う。T4 は既存テストの再利用なので mock も同じ。

### probe スキップ・他の prompt との順序

probe (`probeOrganizationId`) は accessToken を引数に呼ばれ、その**後**に `Found credential:` ログ→（rateLimitTier 行 or 空行 + plan prompt）→ display name prompt の順なので、test での回答列もこの順に並べれば良い。

### 既存テストへの波及

- `credentials 経路成功` (L263〜L292): rateLimitTier=default_claude_max_20x なので plan prompt は出ない。回答列変更なし、引き続き green であるべき。
- `manual 経路成功` (L386〜L410): rateLimitTier 無しケース。**回答列に plan prompt に空 Enter を返す回答を 1 つ追加（plan=unknown 確定）**して従来挙動を維持する形に改修。
- `R-promote-1` (L704〜L734): rateLimitTier=default_claude_max_20x なので変更不要。
- `R-promote-2` (L736〜L761): manual 経路で plan=unknown を期待。**plan prompt に空 Enter を返す回答を追加（plan=unknown 確定）**して既存 expect を維持。
- `R-promote-3` (L763〜L791): probe 失敗で exit するため plan prompt 到達前。変更不要。
- `R-promote-7` (L866〜L891): 同上、probe 失敗。変更不要。
- `R-promote-8` (L893〜L925): manual + 成功。**plan prompt に空 Enter を返す回答を追加（plan=unknown 確定）**。
- `R-promote-9` (L927〜L949): 同上、**plan prompt に空 Enter を返す回答を追加（plan=unknown 確定）**。
- `R-promote-10` (L951〜L962): unknown ヒント検証。**plan prompt に空 Enter を返す回答を追加（plan=unknown 確定）**して unknown を維持し、ヒント検証を温存。
- T7 / T8 (L1136〜L1237): rateLimitTier 由来で plan 確定するケース。回答列変更不要。

これらは「実装前にテストが落ちる範囲を最小化する」ための整合改修なので、Step 1（Red）と Step 5（Green）の間で随時調整する。

> **表現上の注記**: 旧版で「plan prompt スキップ」と書かれていた箇所は、実態は「prompt に空 Enter を返して plan=unknown を確定する入力を追加」する作業であり、prompt 自体は表示される。Implementer が「prompt が出ないように回答列をいじる」と誤読しないよう統一表記を採用。

## 6. TDD の進め方

1. **Red**: §4 Step 1 のテストを追加し、`bun test --timeout 30000 skills/cmux-team/manager/token-cli.test.ts` で **新規 T1〜T5a / T6 が fail** することを確認（既存テストはまだ無傷）。
2. **Green**: §4 Step 2〜4 の実装を入れ、テストを全 pass させる。途中で既存テストが落ちたら §5「既存テストへの波及」の調整を当てる。
3. **Refactor**: helper docstring・docs/spec 更新・不要コード除去。テストは引き続き全 pass を維持。

各ステップ後にコミットを切る。コミットメッセージ案:

- Step 1〜5: `feat(token): plan prompt for unknown rateLimitTier (T349)`
- Step 6: `docs(token): describe plan prompt behavior in 09-token-pool.md (T349)`

> **§3.2 step 3（validPlans → PLAN_BY_NAME 差し替え）を将来別タスクで採用する場合は、別コミット `refactor(token): unify plan map between set-plan and add/promote` として分離する**。本タスクのコミットには含めない。

## 7. リスク・懸念点

| リスク | 検証方法 |
|--------|----------|
| `rateLimitTier` が取れる経路で誤って prompt が出る | T4 / T7 / T8 と既存 `credentials 経路成功` / `R-promote-1` で「plan 回答を提供しない」回答列が引き続き完了することを確認。出てしまった場合は readline mock が `""` を返してテストが意図せず通る危険があるので、`consoleLogs.join("\n")` に `"plan (pro / max-x5 / max-x20"` を含まないことを explicit に assert する（T4 で 1 件追加） |
| 未知 tier で誤って `unknown` 確定してしまう（後者解釈の取りこぼし） | T6 で「未知 tier 投入 → prompt が出る」を assert |
| `Found credential:` ブロックと plan prompt の間のレイアウトが崩れる | T2（manual + 空 Enter）で `consoleLogs` の冒頭が `"Found credential:"` で始まり、`organizationId:` 行と plan 入力受付の間に空行（`""` の log エントリ）があることを assert |
| `validPlans` を残したことで PLAN_MAP との重複が生じる | 本タスクでは許容（§3.2 step 3 で optional 化、別タスクで対応）。PR description に「重複は意図的に残した」旨を記載 |
| 再入力ループの無限ループ | `askAnswers.shift() ?? ""` で stdin EOF 時は空文字 → `unknown` 確定で抜ける設計。実機でも readline は EOF で `close` → question callback は呼ばれなくなるが、本タスクの実装は `for (;;)` なので **EOF 後も await が hang する**懸念あり。対策として `prompt` が空文字を返したら "unknown" として抜ける設計を採る（現行の readline mock とも整合）。実機では Ctrl+D で空 Enter と同じ扱いになるため概ね妥当 |
| エラーメッセージ文言のテスト脆弱化 | §5「エラーメッセージの assert 方針」のとおり部分一致 (`toContain("pro / max-x5 / max-x20")`) で書き、句読点・括弧の差で fail しないようにする |
| docs/spec と実装の乖離 | Step 6 で `docs/spec/09-token-pool.md` を同時更新し、PR に含める |
| rotate に手を入れていないことが意図したスコープ縮小であることのレビュアーへの説明 | 本 plan.md §3.4 にて明文化済み。PR description にも同要旨を 1 段落書く |

## 8. 完了基準（Implementer 向けチェックリスト）

- [ ] `cmdTokenAdd` で rateLimitTier 由来の plan が解決できない場合（undefined または未知 tier）のみ新 prompt が出る
- [ ] `cmdTokenPromote` で rateLimitTier 由来の plan が解決できない場合（undefined または未知 tier）のみ新 prompt が出る
- [ ] `cmdTokenRotate` には変更を入れない
- [ ] PLAN_MAP / PLAN_BY_NAME が同じ値ソース（PLAN_MAP）を参照する（**`validPlans` は今回手を入れない**）
- [ ] 不正値で再入力ループが回り、`pro / max-x5 / max-x20` を含むエラーメッセージが stderr に出る
- [ ] 空 Enter で `plan="unknown"` / `plan_ratio=null` が DB に書かれる
- [ ] `Found credential:` ブロックと plan prompt の間に空行が入る
- [ ] T1〜T5a / T6 の新規テストが全 pass
- [ ] 既存テスト（manual 経路成功 / R-promote-2 / R-promote-8 / R-promote-9 / R-promote-10）の回答列に「plan prompt に空 Enter を返す回答」を 1 つ挿入する形で改修済み
- [ ] **既存 set-plan テスト 3 件が無改造で pass**（§3.2 step 3 を採用しないため変化はないが、念のため確認）
- [ ] `bun test --timeout 30000 token-cli.test.ts` が green
- [ ] `docs/spec/09-token-pool.md` に新 prompt の説明を追記（未知 tier も prompt 対象である旨を含む）
- [ ] PR description に「rotate を scope 外とした理由」「未知 tier も prompt 対象とする後者解釈を採用した理由」「set-plan の `validPlans` を残した理由」を §3.4 / §3.6.2 / §3.2 から要約して記載
