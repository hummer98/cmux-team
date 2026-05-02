# Plan: T413 — `{{PROJECT_COMMON_INSTRUCTIONS}}` プレースホルダ + `_common.md` overlay

> Iteration 2 改訂版。Design Review (`design-review.md`) の判定 *Changes Requested* に対する
> Recommendations 全 5 件 (Major 2 + Minor 5) を反映。

## 1. 概要

現状、sub-agent prompt 上には「全 agent が共通で知るべきプロジェクト原則（観察箱の性格 / log policy / 決定論原則 等）」を載せる場所が存在しない。`common-header.md` は仕組みが汎用すぎる 5 行に留まり、`{{PROJECT_INSTRUCTIONS}}` は per-role overlay であり、CLAUDE.md は Claude Code バージョン依存・優先度低の auto-load にすぎない。

本タスクは新プレースホルダ `{{PROJECT_COMMON_INSTRUCTIONS}}` と展開ソース `.team/agent-instructions/_common.md` を導入し、`generateMasterPrompt` / `generateConductorRolePrompt` / `spawn-agent` の全経路で展開できる**機構**を提供する。`_common.md` の文面そのものを書く作業は scope 外で、本タスクは **placeholder + overlay 配管 + テスト + ドキュメント** に限定する。

設計上は既存 `{{PROJECT_INSTRUCTIONS}}` (T247 / T342) の仕組みをほぼそっくり踏襲し、別 placeholder + 別ファイル名 + 別見出し i18n キーで対称な 2 軸 (common × per-role) overlay にする。**展開順は `role → common`**（後述 判断 3）— テンプレ上の物理位置は `{{PROJECT_COMMON_INSTRUCTIONS}}` が `{{PROJECT_INSTRUCTIONS}}` の前に来るため、出力上は common が role より上に表示される。

---

## 2. 設計判断

### 判断 1: `OverlayRole` 拡張 vs `CommonOverlay` 分離

**選択肢:**
- **A.** `OverlayRole` enum に `"common"` を追加（11 値）
- **B.** `CommonOverlay` を別 concept として分離（`OverlayRole` は触らず、`agentInstructionsPath` も branch 不要、common 専用関数群を新設）
- **C.** `OverlayRole` を `AgentRole | "master" | "conductor" | "common"` に拡張しつつ、`requireSpawnableAgentRole` が `common` も `master/conductor` 同様 reject する追加 branch を入れる（A + 追加防御）

**推奨: C（A + spawn-agent 防御）**

**根拠:**
- 既存の `agentInstructionsPath` / `readProjectInstructions` / `writeProjectInstructions` / `deleteProjectInstructions` / `listProjectInstructions` は `OverlayRole` 単一引数で動いており、SSOT を保つには enum 拡張が最小コスト。CLI (`get/set/delete/list-agent-instructions`) も `requireOverlayRole` が `OverlayRole` を受けるだけで自動的に対応できる（タスク本文 §5 の "normalizeOverlayRole が "common" 解決できれば自動的に既存 CLI が動作する想定" と一致）
- 一方で `--role common` で spawn-agent が呼ばれると意味不明な状態になるため、`requireSpawnableAgentRole` 側で `master/conductor` と同じ「reserved for system prompt overlay」エラーで reject する分岐を追加する
- `CommonOverlay` 分離（B）は型レベルで「common は role ではない」ことを表現できるが、CLI / list / read/write 全関数が doublet になり overhead が大きい。trade-off に見合わない
- ファイル名 `_common.md` は role 名空間と衝突しない（prefix `_` のため）

**追加検討:**
- `agentInstructionsPath` は引数 `role: OverlayRole` で `${role}.md` を組み立てている。`role === "common"` を分岐して `_common.md` にマップする 1 行追加で済む（後述 Step 1）
- `listProjectInstructions` の出力順は `OVERLAY_ROLES` 配列順（Agent 8 ロール → master → conductor）。`"common"` は **末尾** に追加（既存 11 ロールの list 出力末尾。最も「全体共通」の概念であり、視覚的に最後に置くのが自然）

---

### 判断 2: path 命名（`_common.md` vs `common.md`）

**選択肢:**
- **A.** `_common.md`（prefix `_`）
- **B.** `common.md`（prefix なし）

**推奨: A — `_common.md`**

**根拠:**
- タスク本文 §1 で明示 `「.team/agent-instructions/_common.md（prefix _ で role overlay と区別）」` と指示されている
- `common.md` だと将来 `common` ロール（仮に存在したら）と視覚的に紛らわしい。`OVERLAY_ROLES` 列挙にも入る都合上、`role` 文字列リテラルとしては `"common"` だが**ファイル名だけ** `_common.md` にすることで「role overlay じゃないよ」を一目で示す
- `_` prefix は既存の `_common.md` ライクな慣習（dotfiles / template overlay 等）と整合的
- ただし副作用として `agentInstructionsPath` で 1 行 branch が要る → コストは小さい

**実装:**
```typescript
export function agentInstructionsPath(projectRoot: string, role: OverlayRole): string {
  const filename = role === "common" ? "_common.md" : `${role}.md`;
  return join(projectRoot, AGENT_INSTRUCTIONS_DIR_REL, filename);
}
```

---

### 判断 3: expand 関数の設計（既存拡張 vs 新設）+ 展開順序

**選択肢:**
- **A.** `expandProjectInstructions` を拡張し、両 placeholder を 1 関数で処理（引数追加 or 内部で 2 段階展開）
- **B.** `expandProjectCommonInstructions` を新設し、呼出し側で 2 関数を直列適用
- **C.** 上位で wrap する `expandPromptOverlays` を新設し、内部で順次呼び出す（呼出し側ボイラープレート削減）

**推奨: B + C — `expandProjectCommonInstructions` を新設し、上位に `expandPromptOverlays` 的な wrap helper を 1 つ作って 3 経路（generateMasterPrompt / generateConductorRolePrompt / spawn-agent の 2 か所）から共通呼び出し**

**根拠:**
- 1 関数化（A）は内部の置換ロジック（`lineRe` の最初の 1 件のみ置換、heredoc literal 保護）を common と role の 2 軸に分けて維持する必要があり、戻り値 `mode` の表現も `{ common: <mode>, role: <mode> }` のような複合になる。SSOT が崩れる
- 2 関数 + 上位 wrap（B+C）は SSOT を保ち、各関数の単体テストがしやすい。expand 順序 = 関数呼び出し順序として呼び出し側でも明示的になる
- `expandProjectCommonInstructions` は `expandProjectInstructions` のほぼコピー（placeholder 名と読み込みパスが違うだけ）。共通化したくなったら helper 関数にくくり出すのは後付けで OK（YAGNI）
- wrap helper（C）は `generateMasterPrompt` / `generateConductorRolePrompt` / `cmdSpawnAgent` の 3 経路で同じ展開順序を再現する必要があるため、ここを 1 か所に集めるのは漏れ防止に効く

#### 展開順序の確定: `role → common`（**改訂ポイント M1**）

`expandPromptOverlays` 内では `expandProjectInstructions` を**先に**呼び、その後 `expandProjectCommonInstructions` を呼ぶ。テンプレ上の placeholder 物理位置（`{{PROJECT_COMMON_INSTRUCTIONS}}` が `{{PROJECT_INSTRUCTIONS}}` より前）は変えないため、出力上は common が role より上に表示される（test (U) の position assertion で担保）。

**なぜ role → common 順なのか:**

- `expandProjectInstructions` の `lineRe = /\n\{\{PROJECT_INSTRUCTIONS\}\}\n/` は document 全体での **最初の 1 件**にマッチする (`template.ts:151-158`)
- もし common→role 順で展開すると、common 展開後の content には `[common body (literal {{PROJECT_INSTRUCTIONS}} を含む可能性) ... ]` の後に role placeholder が来る。`lineRe` の 1 件目マッチが common body 内 literal に当たれば、本来の role placeholder は残ったまま誤置換されてしまう
- 逆に **role → common 順**なら、`expandProjectInstructions` 実行時点ではまだ common body は挿入されていないため、template 内の `{{PROJECT_INSTRUCTIONS}}` placeholder のみが対象になり、common body 内に literal `{{PROJECT_INSTRUCTIONS}}` が含まれていても**自然に保護**される
- template の placeholder 物理位置は不変なので、test (U)「output で common が role より前」のアサーションは引き続き成立する

**実装スケッチ:**
```typescript
// template.ts
export async function expandProjectCommonInstructions(
  projectRoot: string,
  content: string,
): Promise<{ expanded: string; mode: "noop" | "empty" | "applied" }> {
  if (!content.includes("{{PROJECT_COMMON_INSTRUCTIONS}}")) {
    return { expanded: content, mode: "noop" };
  }
  const body = await readProjectInstructions(projectRoot, "common");
  let block = "";
  let mode: "empty" | "applied";
  if (body === null || body === "") {
    mode = "empty";
  } else {
    block = formatProjectCommonInstructionsBlock(body, locale);
    mode = "applied";
  }
  const lineRe = /\n\{\{PROJECT_COMMON_INSTRUCTIONS\}\}\n/;
  const expanded = lineRe.test(content)
    ? content.replace(lineRe, block === "" ? "" : block)
    : content.replaceAll("{{PROJECT_COMMON_INSTRUCTIONS}}", block);
  return { expanded, mode };
}

// 上位 wrap（呼出し側を 1 行化）— 展開順は role → common
export async function expandPromptOverlays(
  projectRoot: string,
  role: string,
  content: string,
): Promise<{ expanded: string; commonMode: ...; roleMode: ... }> {
  const r = await expandProjectInstructions(projectRoot, role, content);  // 先
  const c = await expandProjectCommonInstructions(projectRoot, r.expanded); // 後
  return { expanded: c.expanded, commonMode: c.mode, roleMode: r.mode };
}
```

注: `unknown-role` は `expandProjectInstructions` 側のみで発火する（common には role 概念が無い）。共存時の log は `mode=common:<m>/role:<m>` 形式に統一する。

---

### 判断 4: i18n 見出し（**改訂ポイント m2**）

**推奨: ja `## プロジェクト共通の追加指示` / en `## Project Common Instructions`**

**根拠:**
- 既存 per-role overlay の ja 見出しは `## プロジェクト固有の追加指示`。「共通 vs 固有」「追加指示」の語句を揃える対称性を取るなら `## プロジェクト共通の追加指示` が自然
- 「共通指示」と「固有の追加指示」だと末尾 2 単語が揃わず、読み手が「同種の overlay の片方」だと一目で気づきにくい。`## プロジェクト共通の追加指示` にすることで per-role と並んだときの視覚的対比が強化される
- en は per-role が `## Project-Specific Instructions` で「Specific vs Common」の対比が既に効いているため、`## Project Common Instructions` のままで十分
- i18n キーは `project_common_instructions_heading` を新設（既存 `project_instructions_heading` と並列）
- `formatProjectCommonInstructionsBlock(body, locale)` を `formatProjectInstructionsBlock` のコピーとして新設（i18n キーだけ違う）。共通化したくなったら後で `formatBlock(body, locale, headingKey)` のような形にリファクタしても良いが、本タスクでは SSOT を保ったまま並列実装に留める（後述 §補足注 m3 を参照）

---

## 3. 実装ステップ（TDD 順）

### Step 1. schema.ts — `OverlayRole` に `"common"` 追加

**変更ファイル:** `skills/cmux-team/manager/schema.ts`

**追加/修正内容（要点）:**
- `OverlayRole = z.enum([...AgentRole.options, "master", "conductor", "common"])`
- `OVERLAY_ROLES` は自動的に 11 要素に拡張される
- `normalizeOverlayRole` は変更不要（`OverlayRole.safeParse` が `"common"` を直接 accept する）

**先に書くテスト:**
- `agent-instructions.test.ts` に追加:
  - `OverlayRole.options` に `"common"` が含まれる
  - `normalizeOverlayRole("common")` が `"common"` を返す
  - `OVERLAY_ROLES.length === 11`
  - `OVERLAY_ROLES[10] === "common"`（順序: agent 8 → master → conductor → common）

---

### Step 2. agent-instructions.ts — `_common.md` パスマッピング + helper

**変更ファイル:** `skills/cmux-team/manager/agent-instructions.ts`

**追加/修正内容（要点）:**
- `agentInstructionsPath`: `role === "common"` で `_common.md` にマップ
- `formatProjectCommonInstructionsBlock(body: string | null, locale: Locale): string` を新設（`formatProjectInstructionsBlock` のコピー、i18n キーだけ `project_common_instructions_heading`）
- `readProjectInstructions` / `writeProjectInstructions` / `deleteProjectInstructions` / `listProjectInstructions` は引数 `OverlayRole` のままなので変更不要（`agentInstructionsPath` 経由で `_common.md` に届く）

**先に書くテスト（`agent-instructions.test.ts`）:**
- `agentInstructionsPath(projectRoot, "common")` が `<root>/.team/agent-instructions/_common.md` を返す（**他の role は `<role>.md` のまま**）
- `writeProjectInstructions(projectRoot, "common", "BODY")` → `_common.md` にファイルが書かれる
- `readProjectInstructions(projectRoot, "common")` round-trip
- `deleteProjectInstructions(projectRoot, "common")` true/false
- `listProjectInstructions` が `common` を含み、要素数 11、末尾が `"common"`
- `formatProjectCommonInstructionsBlock(null, "ja")` → ""
- `formatProjectCommonInstructionsBlock("hi", "ja")` に `## プロジェクト共通の追加指示` が含まれる
- `formatProjectCommonInstructionsBlock("hi", "en")` に `## Project Common Instructions` が含まれる

---

### Step 3. i18n.ts — heading キー追加

**変更ファイル:** `skills/cmux-team/manager/i18n.ts`

**追加/修正内容（要点）:**
- `en`: `project_common_instructions_heading: "Project Common Instructions"`
- `ja`: `project_common_instructions_heading: "プロジェクト共通の追加指示"`

**先に書くテスト:** Step 2 のテスト群が i18n キーを参照するため、Step 2 のテストが Step 3 の存在を前提に通る形になる。専用テストは追加せず、`agent-instructions.test.ts` の `formatProjectCommonInstructionsBlock` ケースで間接的にカバー。

---

### Step 4. template.ts — `expandProjectCommonInstructions` + `expandPromptOverlays`

**変更ファイル:** `skills/cmux-team/manager/template.ts`

**追加/修正内容（要点）:**
- `expandProjectCommonInstructions(projectRoot, content)` を新設（判断 3 のコード参照）
  - mode: `"noop" | "empty" | "applied"`（unknown-role は無い）
  - `lineRe = /\n\{\{PROJECT_COMMON_INSTRUCTIONS\}\}\n/` の最初の 1 件のみ置換（既存 expandProjectInstructions と対称）
- `expandPromptOverlays(projectRoot, role, content)` 上位 wrap を新設
  - **role → common の順**に直列適用（判断 3 で確定）
  - 戻り値: `{ expanded: string; commonMode: ...; roleMode: ... }`
- 既存 `expandProjectInstructions` は変更しない（SSOT 維持）

**先に書くテスト（`template.test.ts` に 4 ケース以上追加 — タスク受入条件 §7）:**

1. **common 単独 expand:**
   - 入力: `_common.md` に `"COMMON_BODY"` を書き、content に `\n{{PROJECT_COMMON_INSTRUCTIONS}}\n` のみ
   - `expandProjectCommonInstructions` 呼び出し → `mode === "applied"`、`expanded` に `"COMMON_BODY"` と `## プロジェクト共通の追加指示` (or en heading) を含む、placeholder 残らない、`\n\n\n+` 無し

2. **common なし → 空文字置換:**
   - 入力: `_common.md` 不在、content に `BEFORE\n\n{{PROJECT_COMMON_INSTRUCTIONS}}\n\nAFTER`
   - `expandProjectCommonInstructions` → `mode === "empty"`、placeholder 消える、triple newline 無し

3. **per-role + common 共存展開:**
   - 入力: `_common.md` に `"CCC"`、`implementer.md` に `"III"`、content に共存版テンプレ片（`COMMON_HEADER 後\n\n{{PROJECT_COMMON_INSTRUCTIONS}}\n\n{{PROJECT_INSTRUCTIONS}}\n\nROLE_BODY`）
   - `expandPromptOverlays(projectRoot, "implementer", content)` → `commonMode === "applied"`、`roleMode === "applied"`
   - 出力に `"CCC"` と `"III"` の両方が含まれる
   - 出力中の **`"CCC"` の position が `"III"` より前** であること（`indexOf` で確認 — テンプレ物理位置で担保）
   - placeholder が一切残らない

4. **展開順序の literal 保護（`role → common` 順なので common body 内 literal が保護される）:**
   - 入力: `_common.md` に `"PRE\n{{PROJECT_INSTRUCTIONS}}\nPOST"` という literal text を含む body を書く（common body 内に role placeholder の literal がある状況）
   - `implementer.md` には `"III"` を書く、content にはテンプレ片 `\n{{PROJECT_COMMON_INSTRUCTIONS}}\n\n{{PROJECT_INSTRUCTIONS}}\n` を含める
   - `expandPromptOverlays(projectRoot, "implementer", content)` を呼ぶ
   - 期待: 出力に `"III"`（role overlay 展開結果）と common body がそのまま含まれ、common body 内の literal `{{PROJECT_INSTRUCTIONS}}` は残る
   - 理由: role → common 順で展開するため、`expandProjectInstructions` 実行時点では common body はまだ挿入されておらず、template 内の `{{PROJECT_INSTRUCTIONS}}` placeholder のみが対象。common 展開はその後に走り、`{{PROJECT_COMMON_INSTRUCTIONS}}` のみを置換するため、common body 内の `{{PROJECT_INSTRUCTIONS}}` literal は触られない

5. **追加（受入条件カバー用）: common なしで per-role overlay のみある時:**
   - `_common.md` 不在、`implementer.md` に `"III"`
   - `expandPromptOverlays` → `commonMode === "empty"`、`roleMode === "applied"`、出力に `"III"` のみ含まれる、common placeholder 消える、role placeholder 消える

6. **`generateMasterPrompt` / `generateConductorRolePrompt` の overlay 展開（既存テスト拡張）:**
   - master.md / conductor-role.md テンプレに `{{PROJECT_COMMON_INSTRUCTIONS}}` が追加される（Step 5）ため、`writeProjectInstructions(projectRoot, "common", "MASTER_COMMON")` で書き、`generateMasterPrompt(projectRoot)` を呼び、出力に `"MASTER_COMMON"` と `## プロジェクト共通の追加指示` (or en) が含まれることを確認
   - conductor 側も対称テスト

---

### Step 5. テンプレ更新（ja + en、計 20 ファイル）（**改訂ポイント m1**）

**変更ファイル:**
- `skills/cmux-team/templates/ja/{implementer, planner, design-reviewer, researcher, architect, inspector, dockeeper, task-manager, master, conductor-role}.md`
- `skills/cmux-team/templates/en/{implementer, planner, design-reviewer, researcher, architect, inspector, dockeeper, task-manager, master, conductor-role}.md`
- **計 20 ファイルで確定**。`spec 04-templates.md:136` の T342 注記により `conductor.md (ja/en)` は deprecated として placeholder 追加対象外。タスク本文 §4 の "22 ファイル(11 × 2)" は conductor.md を含めた数値だが、deprecated はスキップする方針が確立済みのため 20 件で進める

**追加/修正内容（要点）:**
- `{{COMMON_HEADER}}` 直後（先頭 3 行目あたり）に `{{PROJECT_COMMON_INSTRUCTIONS}}` を 1 行独立で挿入
- 既存 `{{PROJECT_INSTRUCTIONS}}` の **すぐ上** に置く
- 結果のテンプレ冒頭は以下のような形:
  ```
  {{COMMON_HEADER}}

  {{PROJECT_COMMON_INSTRUCTIONS}}

  {{PROJECT_INSTRUCTIONS}}

  ## Role: ...
  ```
- master.md / conductor-role.md は既存 `{{PROJECT_INSTRUCTIONS}}` の上に追加（master.md は role 導入文 → `{{PROJECT_COMMON_INSTRUCTIONS}}` → `{{PROJECT_INSTRUCTIONS}}` の順）
- conductor-role.md の **heredoc サンプル内** に出てくる `{{PROJECT_INSTRUCTIONS}}` は literal として保護される必要があり、**`{{PROJECT_COMMON_INSTRUCTIONS}}` も同様に literal で保護されることを確認**（`expandProjectCommonInstructions` の `lineRe` が最初の 1 件のみマッチする仕様で担保）
- conductor-role.md の "プレースホルダ表記について" の節も "冒頭の `{{PROJECT_COMMON_INSTRUCTIONS}}` も実値置換対象" の旨を 1 文で追記
- **重要**: conductor-role.md は heredoc 内 literal `{{PROJECT_INSTRUCTIONS}}` が複数あるため (Notes 参照)、`{{PROJECT_COMMON_INSTRUCTIONS}}` placeholder は**冒頭の独立行 (line 7-8 付近) に 1 か所だけ**置くこと。heredoc 内には書かない

**先に書くテスト:**
- `template.test.ts` に既存 `generateMasterPrompt overlay` / `generateConductorRolePrompt overlay` describe ブロック相当のものを common 用に追加（テンプレ更新と同時にテストが pass する形になる）
- 各テンプレが `{{PROJECT_COMMON_INSTRUCTIONS}}` を含むことの軽量 assert（grep ベース、`templates-overlay.test.ts` のような小テストでも可）。**スコープ最小化のため、`generateMasterPrompt` の出力経由で間接的に検証する形で十分**

---

### Step 6. main.ts (CLI) — `--role common` 受付

**変更ファイル:** `skills/cmux-team/manager/main.ts`

**追加/修正内容（要点）:**
- `requireOverlayRole` は変更不要（`normalizeOverlayRole("common")` が `"common"` を返すようになったため自動対応）
- `requireSpawnableAgentRole`: `master/conductor` と並んで `common` も "reserved for system prompt overlay" エラーで reject する分岐追加
- `cmdSpawnAgent` 内の `expandProjectInstructions` を `expandPromptOverlays` に置き換え（2 経路: opencode agentEnabled パス line 2968 付近 + 通常 cmux パス line 3174 付近の expanded.md 書き出しブロック）
- `generateMasterPrompt` (template.ts) も `expandPromptOverlays` を呼ぶよう書き換え
- `generateConductorRolePrompt` (template.ts) も同様に `expandPromptOverlays` 呼び出しに変更
- log line `spawn_agent_expand` の出力を `mode=common:<m>/role:<m>` 形式に拡張（mode の構造化が変わるため）
  - **消費側確認結果**: `grep -rn "spawn_agent_expand" skills/ bin/` を実装直前に再実行する。現時点では `main.ts:2971, 3190, 3194` 内の log 発行箇所のみで、metrics / dashboard / 外部 parser 側に grep 消費は無い（confirmed during plan iteration 2 — Implementer は実装直前に再 grep して再確認）

**先に書くテスト（**改訂ポイント m4**）:**

CLI テストは既存 `agent-instructions.test.ts` パターンに合わせる。具体的には:
- 既存 `agent-instructions.test.ts` には subprocess shell test は存在せず、`writeProjectInstructions` / `agentInstructionsPath` 等の**関数を直接 import して呼ぶ**スタイル
- 本タスクでも同パターン（関数直叩き）で書く。subprocess test は導入しない

最低限以下を追加:
- **(X)** `cmdSetAgentInstructions` を関数として import し直接呼ぶ → `--role common --body "test"` 相当の引数で `_common.md` にファイルが書かれる + 戻り値が success
- **(Y)** `cmdSpawnAgent` を関数として import し直接呼ぶ → `--role common ...` 相当の引数で `requireSpawnableAgentRole` が throw / exit 1 相当のエラーを出す（"reserved" 系エラー文字列を含む）
  - `cmdSpawnAgent` が export されていない場合は `requireSpawnableAgentRole("common")` を直接呼んで throw を確認する形に縮退
- 既存 `spawn-agent --role implementer ...` 系の挙動は touch しない（回帰確認は既存テスト群に委ねる）

---

### Step 7. ドキュメント更新

**変更ファイル:**
- `docs/spec/04-templates.md`
- `CLAUDE.md`

**追加/修正内容（要点）:**

#### `docs/spec/04-templates.md`
- §`{{PROJECT_INSTRUCTIONS}}` プレースホルダ（T247 / T342）の隣に新セクション `## {{PROJECT_COMMON_INSTRUCTIONS}} プレースホルダ（T413）` を追加
  - 展開ソース: `.team/agent-instructions/_common.md`
  - 展開タイミング: `generateMasterPrompt` / `generateConductorRolePrompt` / `cmdSpawnAgent` 全経路（`expandPromptOverlays` 経由）
  - 配置: テンプレ上 `{{COMMON_HEADER}}` 直後・`{{PROJECT_INSTRUCTIONS}}` の前
  - 展開仕様: `expandProjectCommonInstructions` の mode 表（noop / empty / applied）
  - **展開順序: `role → common`**（template 上の物理位置は `{{PROJECT_COMMON_INSTRUCTIONS}}` が前、`{{PROJECT_INSTRUCTIONS}}` が後だが、内部展開は role を先に処理する。理由: common body 内に literal `{{PROJECT_INSTRUCTIONS}}` が含まれていても誤置換されないようにするため）
  - i18n: ja `## プロジェクト共通の追加指示` / en `## Project Common Instructions`
  - 共存時の log 形式: `mode=common:<m>/role:<m>`
  - role enum: `OverlayRole` に `"common"` を追加（11 ロール）
  - `cmux-team spawn-agent --role common` は reject される（master/conductor と同じ "reserved" エラー）
- §テンプレート変数一覧の表に `{{PROJECT_COMMON_INSTRUCTIONS}}` 行を追加
- §Master Template / Conductor Templates の "テンプレート変数" 行に `{{PROJECT_COMMON_INSTRUCTIONS}}` を追記

#### `CLAUDE.md`
- §「Manager プロトコル」または近傍に 1 行追加:
  > `.team/agent-instructions/_common.md` に置くと、Master / Conductor / Agent 全 sub-agent prompt の `{{PROJECT_COMMON_INSTRUCTIONS}}` 位置に展開される（per-role overlay は引き続き `<role>.md`）。

**先に書くテスト:** ドキュメント変更は手動レビューで十分。テストは追加しない。

---

### Step 8. 既存テスト・テンプレ整合性確認

**変更ファイル:** なし（検証のみ）

**確認内容:**
- `agent-instructions.test.ts` の既存テスト `(8)`, `(18)`, `agentInstructionsPath builds correct relative path` 系が `OVERLAY_ROLES.length === 11` / 末尾要素変更で破綻していないか
  - **(8) は更新不要**: `OVERLAY_ROLES.length` を**動的参照**しているため enum 拡張で自動追従する（後述 §5 test (J) の改訂を参照）
  - **(18) は要修正**: `roles[length-2] === "master"` / `roles[length-1] === "conductor"` のハードコード値を `"common"` 末尾追加に合わせて修正（§5 test (K)）
- `template.test.ts` の既存 generateMasterPrompt / generateConductorRolePrompt overlay テストが、テンプレに新 placeholder が増えても引き続き pass すること
- `bun test --timeout 30000 skills/cmux-team/manager/agent-instructions.test.ts` 単体実行で pass
- `bun test --timeout 30000 skills/cmux-team/manager/template.test.ts` 単体実行で pass
- `bunx tsc --noEmit` で型エラー 0

**先に書くテスト:** なし（既存テスト群への回帰確認）

---

## 4. 影響範囲

### 既存挙動への影響

| 領域 | 影響 |
|------|------|
| `_common.md` が無いプロジェクト | 完全後方互換。`{{PROJECT_COMMON_INSTRUCTIONS}}` は空文字置換、生成 prompt の triple-newline は発生しない（既存 `lineRe` 同型） |
| 既存の per-role overlay (`<role>.md`) | 影響なし。`expandProjectInstructions` は変更しない |
| 既存テスト (`agent-instructions.test.ts` test 8 / 18 など) | test (8) は `OVERLAY_ROLES.length` を動的参照しているため自動追従。test (18) のみ末尾要素ハードコードを修正 |
| 既存 spawn-agent ログ `spawn_agent_expand` | フォーマット変更（`mode=<m>` → `mode=common:<m>/role:<m>`）。**消費側確認**: 実装直前に `grep -rn "spawn_agent_expand" skills/ bin/ --include="*.ts" --include="*.tsx"` を実行し、metrics / dashboard / 外部 parser で grep ベース parsing が無いことを再確認する。現時点 (plan iteration 2) では発行側 (`main.ts:2971/3190/3194`) のみで消費側は未検出 |
| `cmux-team spawn-agent --role common` | exit 1 で reject（新規追加挙動。既存 user は影響なし） |
| `OVERLAY_ROLES` を依存している外部コード | プラグイン化された後の話。本リポジトリ内では list-agent-instructions の出力末尾に "common" が増えるのみ |

### 後方互換性

- `_common.md` 不在時の挙動は完全に既存と同じ（empty mode で空文字置換）
- 既存のテンプレ生成パイプラインに `{{PROJECT_COMMON_INSTRUCTIONS}}` を追加しても、`expandProjectCommonInstructions` の `lineRe` が単独行を消去する仕様により、生成プロンプトの見た目は「placeholder 行が消える」だけで他の行が変わらない（既存 `{{PROJECT_INSTRUCTIONS}}` と同型）
- npm 配布時、テンプレ更新は同期反映される（ユーザー側で `cmux-team start` 再実行で `.team/prompts/` が再生成される）
- `_common.md` 自体の文面追加は別タスク（scope 外）

### Master / Conductor の prompt 再生成タイミング

- `cmux-team start` 実行時に `generateMasterPrompt` / `generateConductorRolePrompt` が `.team/prompts/master.md` / `.team/prompts/conductor-role.md` を上書き再生成する
- 本タスクのリリース後、既存ユーザーは次回 `cmux-team start` 起動時に新 placeholder 入りテンプレで再生成される
- リリースに `cmux-team start` 再実行を促す注記を CHANGELOG に書く（Implementer / Conductor の判断で）

---

## 5. テスト戦略

### 追加するテスト一覧（ファイル別）

#### `skills/cmux-team/manager/agent-instructions.test.ts`
- `(A)` `OverlayRole` に `"common"` が含まれる、`OVERLAY_ROLES.length === 11`、末尾要素 `"common"`
- `(B)` `agentInstructionsPath(projectRoot, "common")` が `_common.md` を返す
- `(C)` `agentInstructionsPath(projectRoot, "implementer")` が `implementer.md` を返す（既存挙動の回帰確認）
- `(D)` `writeProjectInstructions(projectRoot, "common", "BODY")` round-trip
- `(E)` `deleteProjectInstructions(projectRoot, "common")` true/false
- `(F)` `listProjectInstructions` の末尾が `"common"`、要素数 11
- `(G)` `formatProjectCommonInstructionsBlock(null, "ja")` → ""
- `(H)` `formatProjectCommonInstructionsBlock("hi", "ja")` に `## プロジェクト共通の追加指示`
- `(I)` `formatProjectCommonInstructionsBlock("hi", "en")` に `## Project Common Instructions`
- ~~`(J)` 既存 test (8) `OVERLAY_ROLES.length` を 10 → 11 に更新~~（**改訂ポイント M2**: test (8) は `OVERLAY_ROLES.length` を動的参照しているため enum 拡張で自動追従する。**更新不要**）
- `(K)` 既存 test (18) `roles[roles.length - 1] === "conductor"` を `"common"` に、`roles[roles.length - 2] === "master"` を `"conductor"` に、`roles[roles.length - 3] === "master"` を加える形に修正

#### `skills/cmux-team/manager/template.test.ts`
- 既存 describe `generateMasterPrompt overlay (T342)` 末尾に common 用ケース追加:
  - `(L)` `generateMasterPrompt` が `_common.md` 内容を出力に含める（heading 付き）
  - `(M)` `_common.md` 不在時、common placeholder が消える、triple newline 無し
- 既存 describe `generateConductorRolePrompt overlay (T342)` 末尾にも対称ケース追加 `(N) (O)`
- 新規 describe `expandProjectCommonInstructions (T413)`:
  - `(P)` `mode === "noop"` (placeholder 不在)
  - `(Q)` `mode === "empty"` (overlay 不在)
  - `(R)` `mode === "applied"` (overlay あり) — heading 含む、triple newline 無し
- 新規 describe `expandPromptOverlays (T413)`:
  - `(S)` common only — commonMode applied、roleMode empty
  - `(T)` role only — commonMode empty、roleMode applied
  - `(U)` both — commonMode applied、roleMode applied、出力中で common body が role body より前に出現（template 物理位置で担保）
  - `(V)` neither — commonMode empty、roleMode empty、両 placeholder 消える、triple newline 無し
  - `(W)` `role → common` 順による common body 内 literal `{{PROJECT_INSTRUCTIONS}}` の保護: `_common.md` 内に literal `{{PROJECT_INSTRUCTIONS}}` を書いても、`expandProjectInstructions` 実行時点では common body 未挿入のため誤置換されず、出力に literal がそのまま残る

#### `skills/cmux-team/manager/main.ts` 経由（既存 `agent-instructions.test.ts` パターン = 関数直叩き、subprocess test なし）
- `(X)` `cmdSetAgentInstructions` を関数 import し `--role common --body "test"` 相当で呼ぶ → `_common.md` に書かれる + success 戻り値
- `(Y)` `cmdSpawnAgent` を関数 import し `--role common ...` で呼ぶ → "reserved" 系エラーが throw（または `requireSpawnableAgentRole("common")` 直接呼びで throw 確認に縮退）
- 既存 `spawn-agent --role implementer ...` 系のテストは存在すれば回帰確認のみ（変更不要）
- **既存 `agent-instructions.test.ts` には subprocess shell test は存在しない**（`grep -n "subprocess\|Bun.spawn" agent-instructions.test.ts` で 0 件確認済み — plan iteration 2）

### 既存テストへの影響

- `agent-instructions.test.ts` test (18) の末尾要素ハードコード値を 1 行修正（`(K)` で対応）
- test (8) は更新不要（動的参照のため自動追従）
- 他既存テストは触らない（一切 break させない）

### TDD 順序

1. RED: Step 2 のテスト（`agentInstructionsPath` for `"common"`）を書く → fail
2. GREEN: Step 1（schema 拡張）+ Step 2（path branch）+ Step 3（i18n）を実装 → pass
3. RED: Step 4 のテスト（`expandProjectCommonInstructions` / `expandPromptOverlays`）を書く → fail
4. GREEN: Step 4 の実装（`role → common` の wrap 順を含む）→ pass
5. RED: Step 5 のテスト（`generateMasterPrompt` / `generateConductorRolePrompt` の common overlay）を書く → fail
6. GREEN: Step 5（テンプレ更新）+ Step 6 (`generateMasterPrompt` / `generateConductorRolePrompt` を `expandPromptOverlays` 呼出しに切替) → pass
7. RED: Step 6 の CLI 関数直叩きテスト（`requireSpawnableAgentRole("common")` reject）→ fail
8. GREEN: Step 6 の `requireSpawnableAgentRole` 分岐追加 → pass
9. REFACTOR: 全 Step を通して、`expandProjectInstructions` と `expandProjectCommonInstructions` の重複が `lineRe` だけになっているか確認。共通化の YAGNI を再評価し、本タスク内では分けたまま維持。**3 軸目 placeholder（locale-specific overlay 等）が出たら `formatBlock(body, locale, headingKey)` 化する**ことを後続タスクのトリガー条件として §補足 m3 にメモする
10. VERIFY: `bun test --timeout 30000 skills/cmux-team/manager/agent-instructions.test.ts skills/cmux-team/manager/template.test.ts` を順次実行（O(N²) 回避のため `bun test` 全体実行は禁忌 — CLAUDE.md 記載）+ `bunx tsc --noEmit`
11. ドキュメント更新（Step 7）

---

## 6. 受入条件チェックリスト

| タスクの受入条件 | 対応する plan ステップ |
|---|---|
| `cmux-team set-agent-instructions --role common --body "test"` が `.team/agent-instructions/_common.md` に書き込む | Step 1（schema）+ Step 2（path branch）+ Step 6（CLI）— `requireOverlayRole` が `"common"` を accept、`agentInstructionsPath` が `_common.md` にマップ。test `(X)` でカバー |
| `cmux-team spawn-agent --role implementer ...` で生成 prompt に common overlay 内容が含まれる | Step 4（`expandPromptOverlays`）+ Step 5（テンプレに新 placeholder）+ Step 6（`cmdSpawnAgent` の expand 呼出し切替）— test `(L)(N)(U)` でカバー |
| per-role overlay 併存時、common と role の両方が展開される | Step 4（`expandPromptOverlays` の `role → common` 直列適用）— test `(U)` でカバー（出力中の position は template 物理位置で担保、両 mode が applied になる） |
| common overlay 無しの場合、既存挙動維持 | Step 4（`mode === "empty"` の挙動）— test `(M)(O)(Q)(T)(V)` でカバー |
| `docs/spec/04-templates.md` に新プレースホルダ仕様 | Step 7（spec 更新） |
| `CLAUDE.md` に 1 行追記 | Step 7（CLAUDE.md 1 行追加） |
| `template.test.ts` に 4 ケース以上のテスト追加 | Step 4 / Step 5 のテスト追加で計 12 ケース以上（`(L)(M)(N)(O)(P)(Q)(R)(S)(T)(U)(V)(W)`）— **要件 4 ケースを大幅に超過** |

### scope 外の確認

- `_common.md` の文面（観察箱の性格 / log policy / 決定論原則 等）は本タスクでは書かない（タスク本文 §scope 外で明示）
- 既存 `<role>.md` overlay の挙動・i18n キー・spawn-agent の他経路（opencode 含む）は維持
- conductor.md (deprecated) はテンプレ更新対象外（spec 04-templates.md の T342 注記に整合、20 件で確定）

---

## 補足: 設計上の注意点

1. **`{{PROJECT_COMMON_INSTRUCTIONS}}` の `lineRe` 設計** — 既存 `{{PROJECT_INSTRUCTIONS}}` と完全対称にする (`/\n\{\{PROJECT_COMMON_INSTRUCTIONS\}\}\n/`)。最初の 1 件のみ置換は heredoc 内 literal を保護するためで、本 placeholder では heredoc 利用ケースは少ないが対称性 + 安全側に倒すために維持
2. **`_common.md` の見出し方針** — `_common.md` 自体に H1 / H2 を書いたとき、出力上は `## プロジェクト共通の追加指示` の下に文書がそのまま並ぶ。Implementer 側で `_common.md` の中身（scope 外）を書くとき、トップレベル見出しを書きすぎると階層が崩れる点に注意（Implementer 用メモ）
3. **`expandPromptOverlays` の API 設計と共通化トリガー（m3）** — common と role を同時に処理する単一エントリポイント化により、将来 placeholder 第 3 軸（例: locale-specific overlay）を増やしたくなったとき、ここに集約すればよい。本タスク時点では 2 軸で固定。**3 軸目 placeholder が追加された時点で `formatBlock(body, locale, headingKey)` 化する**を後続タスク用の判断トリガーとしてここに残す
4. **CLI の `list-agent-instructions` 出力順** — `OVERLAY_ROLES` 配列順 (Agent 8 → master → conductor → common)。視覚的に「全体共通」を末尾に置くのが自然
5. **`spawn-agent --role common` reject の理由** — `_common.md` は role 概念ではなく overlay 概念であり、agent として spawn する意味がない。`master/conductor` と同じ "reserved" エラーで弾く
6. **展開順序に関する注意（M1 改訂）** — `expandPromptOverlays` は内部で `role → common` 順に呼ぶ。template の placeholder 物理位置は逆（common が role の上）だが、内部処理順を逆にすることで common body 内 literal `{{PROJECT_INSTRUCTIONS}}` の誤置換を防ぐ。Implementer はこの順序を絶対に変更しないこと（変更すると test (W) が落ちる）
