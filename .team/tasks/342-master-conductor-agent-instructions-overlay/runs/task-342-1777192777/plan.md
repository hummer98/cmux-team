# T342 Implementation Plan: Master/Conductor agent-instructions overlay (rev2)

## 概要

現状の overlay 機構（`.team/agent-instructions/<role>.md` → テンプレート内 `{{PROJECT_INSTRUCTIONS}}` 置換）は Agent 8 ロール（`AGENT_ROLES`）専用。Master / Conductor のテンプレート (`master.md` / `conductor-role.md`) には `{{PROJECT_INSTRUCTIONS}}` プレースホルダ自体が存在せず、Master / Conductor のシステムプロンプト枠で project 固有の追加指示を入れる手段がない。

本タスクでは：

1. `schema.ts` に overlay 対応ロール用の `OverlayRole` enum / `OVERLAY_ROLES` を追加（既存 `AgentRole` は spawn-agent の型整合のため温存）
2. `agent-instructions.ts` の path 解決・read/write/delete/list と CLI バリデーションを `OVERLAY_ROLES` ベースに置き換える
3. テンプレート **4 ファイル**（`{en,ja}/master.md` / `{en,ja}/conductor-role.md`）の冒頭に `{{PROJECT_INSTRUCTIONS}}` プレースホルダを追加（`conductor.md` は対象外 — Critical §1 参照）
4. Master / Conductor プロンプト生成経路（`generateMasterPrompt` / `generateConductorRolePrompt`）に `expandProjectInstructions` を組み込む
5. CLI（`get/set/delete-agent-instructions`）が `--role master` / `--role conductor` を受け付けるようにし、`spawn-agent --role master/conductor` は明示エラー
6. dashboard Settings タブ・docs/spec・README を新ロール対応に更新

実装は TDD で進め、全 6 AC を pass させる。

> **task.md §(2) との乖離理由**: task.md は編集対象として `conductor.md` を挙げているが、`docs/spec/04-templates.md:100-102` で deprecated（編集や再参照は避けること）と明記されており、ランタイムにも展開されない。AC2 は `conductor-role.md` の更新のみで satisfy されるため、本 plan では `conductor.md` を編集対象から除外する。

---

## 影響ファイル一覧

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/schema.ts` | `OverlayRole` enum / `OVERLAY_ROLES` / `normalizeOverlayRole` を新設（L355 付近 `AgentRole` の直下） |
| `skills/cmux-team/manager/agent-instructions.ts` | `AgentRole` import を `OverlayRole` import に置き換え、`agentInstructionsPath` / `readProjectInstructions` / `writeProjectInstructions` / `deleteProjectInstructions` / `listProjectInstructions` の role 型を `OverlayRole` に拡張、`AGENT_ROLES` ループを `OVERLAY_ROLES` に置換 |
| `skills/cmux-team/manager/template.ts` | `generateMasterPrompt` を `cp` → `readFile` + `expandProjectInstructions("master")` + `writeFile` に書き換え。`generateConductorRolePrompt` 末尾の `writeFile` 直前に `expandProjectInstructions(PROJECT_ROOT, "conductor", content)` を挿入。`expandProjectInstructions` 内の `normalizeAgentRole` を `normalizeOverlayRole` に切り替え（master / conductor も applied 経路に乗せる） |
| `skills/cmux-team/manager/main.ts` | (a) L84 import を `AGENT_ROLES, normalizeAgentRole, type AgentRole` に加えて `OVERLAY_ROLES, normalizeOverlayRole, type OverlayRole` を追加。(b) L4862 `requireAgentRole` を `requireOverlayRole` にリネームしつつ `OVERLAY_ROLES` でバリデーション。`get/set/delete-agent-instructions` 系は `requireOverlayRole` を使う。(c) L2497 `cmdSpawnAgent` 内の `const role = requireArg("role")` を `requireSpawnableAgentRole`（新設、`AGENT_ROLES` のみ受け付ける）に置換し、master/conductor を渡したら `Error: role 'master' is reserved for system prompt overlay; cannot be spawned as agent` で exit 1 |
| `skills/cmux-team/manager/dashboard.tsx` | L26-29 の `AGENT_ROLES`/`AgentRole` import を `OVERLAY_ROLES`/`OverlayRole` に置き換え。`SettingsItem` の `role: AgentRole` → `role: OverlayRole` に変更（list 経路がそのまま 10 ロール表示になる） |
| `skills/cmux-team/templates/en/master.md` | 1 行目 `# Master Role` 直下（行 4 の空行直後）に空行 + `{{PROJECT_INSTRUCTIONS}}` + 空行を独立行で追加 |
| `skills/cmux-team/templates/ja/master.md` | 同上（行 1 `# Master ロール` の Role 導入文直後） |
| `skills/cmux-team/templates/en/conductor-role.md` | 1 行目 `# Conductor Role` の Role 導入文直後（L7「Even if you think…」の段落直後・heredoc サンプル群より前）に空行 + `{{PROJECT_INSTRUCTIONS}}` + 空行を独立行で追加。**Placeholder notation 段落（L7-13）も置換対象 3 つ（`{{PROJECT_ROOT}}` / `{{MAIN_BRANCH}}` / `{{PROJECT_INSTRUCTIONS}}`）に拡張する**。**注意**: 既存 heredoc サンプル内 (en L127/L175) の `{{PROJECT_INSTRUCTIONS}}` は Conductor が Agent 用 prompt に書く literal なので保持する |
| `skills/cmux-team/templates/ja/conductor-role.md` | 同上（heredoc 内は ja L126/L222） |
| `skills/cmux-team/manager/i18n.ts` | (a) `help_get/set/delete/list_agent_instructions` の role 一覧説明を「8 Agent ロール」→「8 Agent ロール + master / conductor」に更新（en / ja 両方）。(b) help_main の `--role <role>` 説明文に master/conductor 不可注記を `spawn-agent` 行に追記。（i18n key 自体の追加は不要 — `project_instructions_heading` を Master/Conductor でも流用するため） |
| `skills/cmux-team/manager/agent-instructions.test.ts` | `AGENT_ROLES` ベースの既存テスト（test 8 / list）を `OVERLAY_ROLES` に切替、master/conductor の round-trip / list / expand / unknown-role テストを追加 |
| `skills/cmux-team/manager/template.test.ts`（新規 or 既存） | `generateMasterPrompt` / `generateConductorRolePrompt` が overlay を展開するテストを追加（`existsSync` で `.team/prompts/master.md` を読む形）。**heredoc 内 placeholder の literal 保持テストを Step 5 必須化**（Major §4） |
| `skills/cmux-team/manager/main.test.ts` | `cmdSpawnAgent` の `--role master` / `--role conductor` rejection と `--role unknown-foo` の汎用 unknown rejection のテストを追加 |
| `docs/spec/04-templates.md` | §「`{{PROJECT_INSTRUCTIONS}}` プレースホルダ」を「Agent 8 ロール + Master + Conductor」に更新。enum サンプルを `OverlayRole` 版に差替え。`conductor.md` deprecated 段落に「placeholder 追加対象外」を 1 行追記 |
| `docs/spec/01-skill-cmux-team.md` | §1a「プロジェクト固有の追加指示」の対象ロールを 10 ロールに更新。`spawn-agent --role` には master/conductor を渡せない注記を追記 |
| `README.md` / `README.ja.md` | "Project-Specific Agent Instructions" セクションの対象ロール列挙を 10 ロールに更新 |

---

## 実装ステップ（TDD 順）

### Step 1: schema 拡張（テスト先行）

**ファイル**: `skills/cmux-team/manager/schema.test.ts`（新セクション追加）

- テスト追加:
  - `OVERLAY_ROLES contains all AGENT_ROLES + master + conductor`
  - `OVERLAY_ROLES.length === AGENT_ROLES.length + 2`
  - `normalizeOverlayRole("master") === "master"`
  - `normalizeOverlayRole("conductor") === "conductor"`
  - `normalizeOverlayRole("impl") === "implementer"`（既存エイリアスは継承）
  - `normalizeOverlayRole("foobar") === undefined`
- → RED 確認

**実装**: `skills/cmux-team/manager/schema.ts` L365 直後に追記:

```ts
export const OverlayRole = z.enum([
  ...AgentRole.options,
  "master",
  "conductor",
] as const);
export type OverlayRole = z.infer<typeof OverlayRole>;
export const OVERLAY_ROLES: readonly OverlayRole[] = OverlayRole.options;

export function normalizeOverlayRole(raw: string): OverlayRole | undefined {
  // alias は AgentRole と共有
  const agent = normalizeAgentRole(raw);
  if (agent) return agent;
  const parsed = OverlayRole.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
```

**TypeScript 型チェック確認** (Minor §8): 実装後に `bunx tsc --noEmit` で `OverlayRole.options` の型が `readonly ["researcher", ..., "master", "conductor"]` literal tuple に推論されていることを確認する。`as const` が外れて `readonly string[]` に degrade した場合は明示的にタプル型注釈を付与する。

→ GREEN 確認

### Step 2: agent-instructions.ts を OverlayRole ベースに（テスト先行）

**ファイル**: `skills/cmux-team/manager/agent-instructions.test.ts`

- 既存 test 8（`list returns all AGENT_ROLES in order`）を `OVERLAY_ROLES` に書き換え（`items.length === OVERLAY_ROLES.length`、各 `it.role === OVERLAY_ROLES[i]`）
- 新規テスト追加:
  - `(15) write/read round-trip for master overlay`
  - `(16) write/read round-trip for conductor overlay`
  - `(17) deleteProjectInstructions("master") works`
  - `(18) listProjectInstructions includes master and conductor at the end`
- → RED 確認

**実装**: `skills/cmux-team/manager/agent-instructions.ts`

- L22-23 import: `AgentRole` → `OverlayRole`、`AGENT_ROLES` → `OVERLAY_ROLES`
- 全関数シグネチャの role 型: `AgentRole` → `OverlayRole`
- L96 の `for (const role of AGENT_ROLES)` → `OVERLAY_ROLES`
- L94 戻り値型 `Array<{ role: AgentRole; ... }>` → `Array<{ role: OverlayRole; ... }>`

→ GREEN 確認

### Step 3: template.ts の expandProjectInstructions を OverlayRole 対応に（テスト先行）

**ファイル**: `skills/cmux-team/manager/agent-instructions.test.ts`

- 新規テスト追加:
  - `(19) expandProjectInstructions(role="master") with overlay → mode=applied`
  - `(20) expandProjectInstructions(role="conductor") with overlay → mode=applied`
  - `(21) expandProjectInstructions(role="master") without overlay → mode=empty`
- → RED 確認

**実装**: `skills/cmux-team/manager/template.ts`

- L11 import: `normalizeAgentRole` → `normalizeOverlayRole`
- L120 `const role = normalizeAgentRole(roleRaw)` → `normalizeOverlayRole(roleRaw)`
- 戻り値型注釈・コメント更新（"role が AgentRole に属さない" → "role が OverlayRole に属さない"）

→ GREEN 確認（既存 Agent ロールのテストも通り続けるはず）

### Step 4: generateMasterPrompt が overlay を展開する（テスト先行 + 即 Step 6 master.md）

> **TDD 順序の依存関係（Major §2）**: Step 4 のテストは Step 6 の `master.md` placeholder 追加を前提とする（テンプレに placeholder が無い状態だと `expandProjectInstructions` が `mode=noop` を返し、テスト assertion が形違いで fail する）。
>
> よって **commit 単位は以下の順序で 1 commit にまとめる**:
> 1. Step 4 テスト追加（RED — placeholder 不在で fail）
> 2. Step 4 実装（`generateMasterPrompt` を `expandProjectInstructions` 経由に書換）
> 3. Step 6 (master 部分) テンプレに placeholder 追加 → GREEN
>
> もしくは Step 6 (master 部分) を先にコミットしてから Step 4 test → impl の順でもよい。

**ファイル**: 新規 `skills/cmux-team/manager/template.test.ts`（or 既存ファイルへの追記）

- テスト追加:
  - `generateMasterPrompt expands {{PROJECT_INSTRUCTIONS}} when overlay exists`
    - `writeProjectInstructions(root, "master", "MASTER_OVERLAY_BODY")` 後に `generateMasterPrompt(root)` 呼び出し → `.team/prompts/master.md` を読み MASTER_OVERLAY_BODY と heading を含むことを確認
  - `generateMasterPrompt with no overlay → placeholder removed (empty)`
- → RED 確認（テンプレに placeholder が追加されるまでは形違い fail）

**実装**: `skills/cmux-team/manager/template.ts`

```ts
export async function generateMasterPrompt(projectRoot: string): Promise<void> {
  const promptsDir = join(projectRoot, ".team/prompts");
  await mkdir(promptsDir, { recursive: true });
  const dst = join(promptsDir, "master.md");

  const templateDir = await findTemplateDir();
  if (!templateDir) throw new Error(t("template_dir_not_found"));

  const raw = await readFile(join(templateDir, "master.md"), "utf-8");
  const { expanded, mode } = await expandProjectInstructions(projectRoot, "master", raw);
  // 注: cp は POSIX rename で atomic だが writeFile は途中失敗時に半端な内容が残る可能性がある (Minor)
  // master.md は数 KB 程度かつランタイム派生物 (再生成可能) のため best-effort で OK
  await writeFile(dst, expanded);
  await log("master_prompt_generated", `path=${dst} expand_mode=${mode}`);
}
```

**Step 6 master.md 適用** → GREEN 確認

### Step 5: generateConductorRolePrompt が overlay を展開する（テスト先行 + 即 Step 6 conductor-role.md）

> **TDD 順序の依存関係（Major §2）**: Step 4 と同様、Step 5 のテストは Step 6 の `conductor-role.md` placeholder 追加を前提とする。Step 5 (test + impl) と Step 6 (conductor-role 部分) を 1 commit にまとめる。

**ファイル**: 同上 `template.test.ts`

- テスト追加:
  - `generateConductorRolePrompt expands {{PROJECT_INSTRUCTIONS}} when overlay exists`
    - `writeProjectInstructions(root, "conductor", "CONDUCTOR_OVERLAY")` 後に `generateConductorRolePrompt(root, "main")` → `.team/prompts/conductor-role.md` を読み CONDUCTOR_OVERLAY を含むことを確認
  - `generateConductorRolePrompt with no overlay → placeholder removed (empty)`
  - **【Major §4 必須】** `Conductor overlay applies only to first {{PROJECT_INSTRUCTIONS}}; heredoc sample placeholders remain literal`
    ```ts
    test("Conductor overlay applies only to first {{PROJECT_INSTRUCTIONS}}; heredoc sample placeholders remain literal", async () => {
      await writeProjectInstructions(root, "conductor", "REAL_OVERLAY");
      await generateConductorRolePrompt(root, "main");
      const out = await readFile(join(root, ".team/prompts/conductor-role.md"), "utf-8");
      expect(out).toContain("REAL_OVERLAY"); // 冒頭で展開された
      // heredoc サンプル内の placeholder は literal で残る（最初の 1 件のみ置換仕様）
      expect(out).toContain("{{PROJECT_INSTRUCTIONS}}");
      // 残存数が 1 つ以上であることを assert（heredoc サンプルの実数に依存するため >=1）
      expect((out.match(/\{\{PROJECT_INSTRUCTIONS\}\}/g) ?? []).length).toBeGreaterThanOrEqual(1);
    });
    ```
  - **【Major §4 必須】** `Conductor with no overlay: first placeholder removed, heredoc samples preserved`
    ```ts
    test("Conductor with no overlay: first placeholder removed, heredoc samples preserved", async () => {
      await generateConductorRolePrompt(root, "main");
      const out = await readFile(join(root, ".team/prompts/conductor-role.md"), "utf-8");
      // 冒頭の独立行 placeholder は消える（mode=empty）が heredoc 内 literal は残る
      expect((out.match(/\{\{PROJECT_INSTRUCTIONS\}\}/g) ?? []).length).toBeGreaterThanOrEqual(1);
    });
    ```
  - これらは `String.prototype.replace(regex)`（g フラグ無し）が「最初のマッチ 1 件のみ」置換する仕様の保険ガード。将来 `expandProjectInstructions` のセマンティクスが全置換に変わると即座に検知できる
- → RED 確認

**実装**: `skills/cmux-team/manager/template.ts` `generateConductorRolePrompt` の `writeFile` 直前に挿入:

```ts
const { expanded, mode } = await expandProjectInstructions(projectRoot, "conductor", content);
await writeFile(promptFile, expanded);
await log("conductor_role_prompt_generated", `path=${promptFile} expand_mode=${mode}`);
```

（`{{MAIN_BRANCH}}` / `{{PROJECT_ROOT}}` 置換を行った後の `content` に対して `expandProjectInstructions` をかける。冒頭 placeholder は `lineRe = /\n\{\{PROJECT_INSTRUCTIONS\}\}\n/` で 1 件目のみマッチし、heredoc 内 placeholder は保護される — 詳細はエッジケース §3 参照）

**Step 6 conductor-role.md 適用** → GREEN 確認

### Step 6: テンプレート **4 ファイル** に `{{PROJECT_INSTRUCTIONS}}` を追加

> ※ task.md §(2) は `conductor.md` (en/ja) も挙げているが、`docs/spec/04-templates.md:100-102` で deprecated（編集や再参照は避けること）と明示されており、ランタイムにも展開されないため本タスクでは編集対象外とする。AC2 は `conductor-role.md` の更新で satisfy される。

> **placeholder 配置の書式ルール**（Major §3）:
>
> placeholder は **前後それぞれに空行を 1 行ずつ**持たせて独立行として配置する。
>
> ```
> # Conductor Role
>
> You are a **Conductor** ...
>
> {{PROJECT_INSTRUCTIONS}}
>
> > **Placeholder notation**
> ```
>
> 前後の空行は次の 2 つを担保するために必須:
> - `lineRe = /\n\{\{PROJECT_INSTRUCTIONS\}\}\n/` のマッチ確実性
> - overlay block (`\n<heading>\n\n<body>\n`) で置換した結果が前文と密着しない可読性

#### 編集対象ファイル

- `skills/cmux-team/templates/en/master.md` L1-4 の直後（Role 導入文ブロック後の空行直後）に空行 + `{{PROJECT_INSTRUCTIONS}}` + 空行を独立行で追加
- `skills/cmux-team/templates/ja/master.md` 同上
- `skills/cmux-team/templates/en/conductor-role.md` L1-7 の Role 導入文（「Even if you think…」段落）直後・heredoc サンプル群より前に挿入
- `skills/cmux-team/templates/ja/conductor-role.md` 同上

#### Placeholder notation 段落の更新（Minor §6）

`conductor-role.md` (en/ja) の「Placeholder notation」段落（en L7-13、ja 該当箇所）を更新し、置換対象を **3 つ** に拡張する:

- before: `{{PROJECT_ROOT}}` / `{{MAIN_BRANCH}}` のみが置換対象という記述
- after: `{{PROJECT_ROOT}}` / `{{MAIN_BRANCH}}` / `{{PROJECT_INSTRUCTIONS}}` の 3 つが置換対象（`{{PROJECT_INSTRUCTIONS}}` は `.team/agent-instructions/conductor.md` の overlay block で置換され、未設定時は空に削除される）

これを怠ると Conductor 自身が「自分の prompt 中の `{{PROJECT_INSTRUCTIONS}}` は literal だ」と誤解する可能性がある。

#### Step 4 / 5 のテスト GREEN を再度確認

### Step 7: spawn-agent CLI に master/conductor reject を追加（テスト先行）

> **挙動変更の射程（Major §3）**: 現行 `cmdSpawnAgent` (main.ts:2497) は `requireArg("role")` を直接呼んでおり、role の syntactic validation を行っていない（任意文字列を受け付けている）。本タスクで `requireSpawnableAgentRole` を導入することで、AC5 の master/conductor 拒否に加えて **`AGENT_ROLES + alias` 以外の任意文字列も全て exit 1 となる**。
>
> 既存の spawn-agent integration test / 既存 conductor-role.md heredoc サンプルが `AGENT_ROLES + alias` 範囲内の role のみ使っていることを Step 12 検証で確認する。

**ファイル**: `skills/cmux-team/manager/main.test.ts`

- テスト追加（subprocess パターン、hook block test と同等）:
  - `cmdSpawnAgent rejects --role master with stderr "reserved"`（exit 1、stderr に "reserved for system prompt overlay" を含む）
  - `cmdSpawnAgent rejects --role conductor with stderr "reserved"`（同上）
  - **【Major §3 必須】** `cmdSpawnAgent rejects --role unknown-foo with stderr "unknown role"`（master/conductor 専用エラーとは別の経路で reject されることを確認）
  - `cmdSpawnAgent accepts --role implementer`（既存仕様維持）
  - 実テスト呼び出し例: `cmux-team spawn-agent --role master --conductor-surface surface:1 --prompt x` → exit 1

**実装**: `skills/cmux-team/manager/main.ts`

新規ヘルパ `requireSpawnableAgentRole(): AgentRole` を `requireAgentRole` の隣に追加:

```ts
function requireSpawnableAgentRole(): AgentRole {
  const raw = requireArg("role");
  const role = normalizeAgentRole(raw);
  if (!role) {
    // OverlayRole に属するか確認して専用メッセージを出す
    const overlay = normalizeOverlayRole(raw);
    if (overlay === "master" || overlay === "conductor") {
      console.error(
        `Error: role '${overlay}' is reserved for system prompt overlay and cannot be spawned as agent. Use --role <agent-role> (one of: ${AGENT_ROLES.join(", ")})`,
      );
    } else {
      console.error(
        `Error: unknown role: ${JSON.stringify(raw)} (expected one of ${AGENT_ROLES.join(", ")}; aliases: impl, reviewer)`,
      );
    }
    process.exit(1);
  }
  return role;
}
```

`cmdSpawnAgent` L2497 を:
```ts
const role = requireSpawnableAgentRole();
```
に置換

→ GREEN 確認

### Step 8: get/set/delete-agent-instructions CLI を OverlayRole 対応に（テスト先行）

**ファイル**: `skills/cmux-team/manager/main.test.ts`（or 既存 agent-instructions テストへの追記）

- テスト追加（subprocess で CLI を呼ぶ既存パターンを踏襲）:
  - `cmux-team set-agent-instructions --role master --body "MASTER_X"` → exit 0、ファイル `.team/agent-instructions/master.md` に "MASTER_X\n"
  - `cmux-team get-agent-instructions --role master` → stdout に "MASTER_X\n"、exit 0
  - `cmux-team delete-agent-instructions --role master` → "DELETED=true"、exit 0
  - `cmux-team set-agent-instructions --role conductor --body "..."` → 同上
  - `cmux-team list-agent-instructions` → 出力に master / conductor の行が含まれる

**実装**: `skills/cmux-team/manager/main.ts`

L4862 `requireAgentRole` を `requireOverlayRole` にリネーム（or 新設）:

```ts
function requireOverlayRole(): OverlayRole {
  const raw = requireArg("role");
  const role = normalizeOverlayRole(raw);
  if (!role) {
    console.error(
      `Error: unknown role: ${JSON.stringify(raw)} (expected one of ${OVERLAY_ROLES.join(", ")}; aliases: impl, reviewer)`,
    );
    process.exit(1);
  }
  return role;
}
```

- `cmdGetAgentInstructions` / `cmdSetAgentInstructions` / `cmdDeleteAgentInstructions` の `requireAgentRole` 呼び出しを `requireOverlayRole` に変更
- `cmdListAgentInstructions` は `listProjectInstructions` 経由で自動的に master/conductor を含むようになる（追加変更不要）

→ GREEN 確認

### Step 9: dashboard.tsx の Settings タブを OverlayRole 対応に

**ファイル**: `skills/cmux-team/manager/dashboard.tsx`

- L26-29 import:
  - `import { listProjectInstructions, readProjectInstructions } from "./agent-instructions"` → 変更なし
  - `import type { AgentRole } from "./schema"` → `import type { OverlayRole } from "./schema"`
  - `import { AGENT_ROLES } from "./schema"` → `import { OVERLAY_ROLES } from "./schema"`（実際には未使用なら削除可）
- L380 `role: AgentRole` → `role: OverlayRole`
- 既存 dashboard tests に regression がないことを確認（`dashboard-*.test.tsx` を `for f in dashboard-*.test.tsx; do bun test --timeout 30000 $f; done` で個別実行）

#### 10 ロール表示の確認（Minor §1）

- Settings タブ rendering が `OVERLAY_ROLES.length` で動的に動くか dashboard.tsx L380 周辺の rendering を確認（縦スクロール対応 / fixed length 仮定の有無）
- 既存 `dashboard-*.test.tsx` に `AGENT_ROLES.length === 8` を前提とした assertion がないか grep で確認
- 画面サイズが小さい環境で truncation が起きないか手動確認推奨

### Step 10: docs / README 更新

**ファイル**:

- `docs/spec/04-templates.md` §「`{{PROJECT_INSTRUCTIONS}}` プレースホルダ」:
  - L56 「全 Agent ロール（researcher / ... / task-manager）」→ 「全 overlay 対応ロール（researcher / architect / planner / design-reviewer / implementer / inspector / dockeeper / task-manager / **master / conductor**）」
  - L71-77 enum 例を `OverlayRole` 版に差替え（または `AgentRole` + `OverlayRole` 両方を併記し「`OverlayRole = AgentRole + master + conductor`」と説明）
  - 「Master / Conductor のテンプレート展開タイミング」段落を新設: `generateMasterPrompt` / `generateConductorRolePrompt` 内で適用される（spawn-agent 経由ではない）と明記

- `docs/spec/04-templates.md` §「conductor.md（フルプロトコル版・deprecated）」L100-102:
  - 既存の deprecated 注記はそのまま残す
  - **末尾に 1 行追記**: 「※ T342 で `{{PROJECT_INSTRUCTIONS}}` placeholder 機構を Master / Conductor へ拡張した際も、本ファイルは deprecated のため placeholder 追加対象外。Conductor 用 overlay は `conductor-role.md` 経由で適用される。」

- `docs/spec/04-templates.md` §「Master Template」L82-94:
  - 「Master 用テンプレート冒頭に `{{PROJECT_INSTRUCTIONS}}` 行を配置（T342）」を追記

- `docs/spec/04-templates.md` §「Conductor Templates」L98-141:
  - conductor-role.md 説明に「Conductor 自身用の overlay は冒頭の `{{PROJECT_INSTRUCTIONS}}`、heredoc サンプル内のものは Agent 用 literal として保護される（最初の 1 件のみ展開仕様）」を追記

- `docs/spec/01-skill-cmux-team.md` §1a:
  - L101「対象ロール: ... の 8 ロール」→ 「Agent 8 ロール + master / conductor の 10 ロール（`OVERLAY_ROLES` enum）」
  - L116「`cmdSpawnAgent` は ... を `.team/prompts/<basename>.expanded.md` に保存」の段落直後に「Master/Conductor では `generateMasterPrompt` / `generateConductorRolePrompt` が `.team/prompts/master.md` / `conductor-role.md` を生成する際に直接展開する（追加の `.expanded.md` は作らない）」を追記
  - `cmux-team spawn-agent --role` には master/conductor を渡せない注記を追記
  - L120 dashboard 説明「8 ロール」→「10 ロール」

- `README.md` / `README.ja.md`:
  - "Project-Specific Agent Instructions" セクションの role 列挙を 10 ロールに更新
  - Master / Conductor は「shared system prompt overlay」として spawn-agent 不要の旨を 1 行追記

### Step 11: i18n.ts のヘルプ文言更新

**ファイル**: `skills/cmux-team/manager/i18n.ts`

- en `help_get_agent_instructions` / `help_set_agent_instructions` / `help_delete_agent_instructions` / `help_list_agent_instructions`:
  - "agent role" → "overlay role (8 agent roles + master + conductor)"
  - エイリアス注記はそのまま（`impl` / `reviewer` は AgentRole のみ）
- ja 同等の翻訳更新
- `help_main`:
  - `cmux-team spawn-agent --role <role>` 行に「(agent roles only — master/conductor reserved)」と注記

#### help_main 文言の具体例（Minor §3）

現行 `help_main` の `spawn-agent --role <role>` 行を実装前に grep で確認し、以下のような形に書き換える:

before:
```
  spawn-agent --role <role> [...]   Spawn an agent with given role
```

after:
```
  spawn-agent --role <role> [...]   Spawn an agent (agent roles only — master/conductor reserved for system prompt overlay)
```

implementer は実装前に i18n.ts の該当行（en / ja 両方）を Read で確認した上で `Edit` する。

### Step 12: 検証

```bash
# manager 配下のユニットテストを 1 ファイルずつ（CLAUDE.md 既知の制約）
cd skills/cmux-team/manager && for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do
  bun test --timeout 30000 "$f"
done

# 型チェック
cd skills/cmux-team/manager && bunx tsc --noEmit

# AGENT_ROLES → OVERLAY_ROLES 移行漏れ検出（Minor §7）
grep -rn "AGENT_ROLES" skills/ docs/ README.md README.ja.md \
  | grep -v ".test." \
  | grep -v "schema.ts:"  # 定義箇所は OK
# 残った参照箇所は OverlayRole に更新するか、明示的に AgentRole を保ちたい箇所か確認

# AC1 / AC2 受け入れ手動検証 (worktree 内 dev リポジトリで)
cmux-team set-agent-instructions --role master --body "TEST_MASTER_OVERLAY"
cmux-team set-agent-instructions --role conductor --body "TEST_CONDUCTOR_OVERLAY"
cmux-team start  # daemon 起動 → master.md / conductor-role.md 再生成
grep "TEST_MASTER_OVERLAY" .team/prompts/master.md
grep "TEST_CONDUCTOR_OVERLAY" .team/prompts/conductor-role.md
grep "## プロジェクト固有の追加指示" .team/prompts/master.md  # ja heading
# 必ず {{PROJECT_INSTRUCTIONS}} が冒頭から消えていることを確認（heredoc 内は残る）
# master.md は 0 件、conductor-role.md は heredoc サンプル分 (>=1) 残る
test "$(grep -c '{{PROJECT_INSTRUCTIONS}}' .team/prompts/master.md)" = "0"
test "$(grep -c '{{PROJECT_INSTRUCTIONS}}' .team/prompts/conductor-role.md)" -ge "1"
```

---

## エッジケース・想定リスク

### 1. 既存 `AgentRole` を破壊しない方法

`AgentRole` enum 定義はそのまま温存。`OverlayRole` を `[...AgentRole.options, "master", "conductor"]` で派生させ、両方を共存させる。

- spawn-agent 経路 (`cmdSpawnAgent`) は **`AgentRole` のみ受け付ける**（新ヘルパ `requireSpawnableAgentRole`）
- agent-instructions 系 CLI (`get/set/delete/list`) は **`OverlayRole` を受け付ける**（`requireOverlayRole`）
- `expandProjectInstructions` は `OverlayRole` ベース（`normalizeOverlayRole`）に切替えるが、既存 Agent ロール 8 件すべてに対する挙動は不変

これにより `AGENT_ROLES.length === 8` を前提にしているコード（既存 hook テスト・statusline 等）は影響を受けない。

### 2. i18n 見出しは既存の `project_instructions_heading` を流用

Master / Conductor 用に新しい見出しを作らず、`project_instructions_heading`（ja: 「プロジェクト固有の追加指示」/ en: "Project-Specific Instructions"）をそのまま流用する。

理由:
- AC で見出し文言の差別化要件はない
- ロール識別はファイルパス (`.team/agent-instructions/master.md`) で十分（プロンプト内に "Master" 等の prefix を入れなくてもユーザーが書いた内容そのものが overlay 本体）
- i18n key の追加コストを避ける

### 3. テンプレート 4 ファイルの placeholder 配置位置

#### 配置原則

**Role 導入文（最重要ルールを含む冒頭ブロック）の直後**に独立行で 1 個だけ追加する。理由:

- ロール定義より下に置くと「指示の上書き」感が出てしまう
- 冒頭 (overrides everything) に置くことで「project 固有の追加指示として全体に効く」という意図が明確
- Conductor の heredoc サンプル群（Agent 用 prompt の例）より上に置くこと — heredoc サンプル内の `{{PROJECT_INSTRUCTIONS}}` は **Agent 用** であり、conductor-role.md 自身の overlay とは独立

#### 書式ルール（前後空行必須）

```
# Conductor Role

You are a **Conductor** ...
Even if you think ...

{{PROJECT_INSTRUCTIONS}}

> **Placeholder notation**
> ...
```

placeholder の前後にそれぞれ空行を 1 行ずつ入れる。理由:

- `lineRe = /\n\{\{PROJECT_INSTRUCTIONS\}\}\n/` のマッチ確実性
- overlay block 展開後、前後の文と密着せず可読性を保つ

#### 重要リスク: 既存 heredoc サンプル内の `{{PROJECT_INSTRUCTIONS}}` との衝突

`skills/cmux-team/templates/{en,ja}/conductor-role.md` には既に複数箇所の `{{PROJECT_INSTRUCTIONS}}` が **heredoc サンプル内** に literal として存在する（grep 結果 — en L127 / L175、ja L126 / L222）。

> 注: `templates/{en,ja}/conductor.md`（deprecated）の heredoc 内 placeholder については本タスクでは対象外（Critical §1）

`expandProjectInstructions` の現行ロジック（template.ts L138-145）:

```ts
const lineRe = /\n\{\{PROJECT_INSTRUCTIONS\}\}\n/;
let expanded;
if (lineRe.test(content)) {
  expanded = content.replace(lineRe, ...);  // 最初の 1 件のみ
} else {
  expanded = content.replaceAll("{{PROJECT_INSTRUCTIONS}}", block);
}
```

`String.prototype.replace` は regex の場合 **最初のマッチ 1 件のみ** 置換する（`g` フラグ無し）。新規追加する Conductor 用 placeholder を **冒頭** に置くため、既存 heredoc サンプル内の placeholder（独立行で書かれている — 該当行を Read で確認済み）は **2 件目以降** にあたり、現行ロジックでは置換されない（保護される）。

ただし fallback `replaceAll` 経路は全置換するため、`lineRe.test(content)` が false になるケース（独立行配置失敗）には注意が必要。**前後空行ルール（上記書式ルール）でこのリスクを回避する。**

**検証手順**: Step 5 の **必須テスト**（Major §4 で格上げ済み）として、heredoc サンプル内の `{{PROJECT_INSTRUCTIONS}}` が **literal のまま残る** ことを expect で検証する。`mode=empty`（overlay 不在）の場合も同テストパターンで heredoc 内が保持されることを assert する。

#### Master の場合

`master.md` には heredoc サンプルが無い（grep で 0 件）ため、placeholder を 1 個追加すれば `lineRe` で置換される。空（overlay 不在）の場合も placeholder 自体は消える。

### 4. spawn-agent role parser での reject 方法

`cmdSpawnAgent` 内の `requireArg("role")` 直後に `normalizeAgentRole` でバリデーションを追加する。新ヘルパ `requireSpawnableAgentRole` は:

- valid AgentRole → そのまま返す
- master / conductor → 専用エラーメッセージ "reserved for system prompt overlay" で exit 1
- それ以外 → 既存の "unknown role" エラーで exit 1

**挙動変更の射程**: 現行 `cmdSpawnAgent` (main.ts:2497) は role を validate しておらず、本変更で `AGENT_ROLES + alias` 以外の任意文字列が全て exit 1 になる（既存ユーザは事実上 valid role しか使っていないはずだが、Step 12 で `grep -rn "spawn-agent --role"` を試して既存 heredoc サンプル等が範囲内であることを確認する）。

これにより既存 `AgentRole` 互換性を保ちつつ AC5（spawn-agent --role master/conductor がエラー）+ unknown role 全般の reject を満たす。

### 5. `generateMasterPrompt` の cp → readFile/writeFile 化に伴う改行差分

現状 `cp` でバイナリ完全コピーされている。`readFile(utf-8)` + `writeFile` 経由になると改行コード変換等で diff が生まれる可能性があるが、テンプレートは UTF-8 LF で統一されているため問題ない。念のため Step 4 のテストで `expandProjectInstructions` 呼び出し前後の行数差分が一致すること（mode=empty 時に 1 行減るのみ）を確認する。

#### atomic write の方針（Minor §4）

`cp` は POSIX rename を使うため atomic write 相当だが、`fs.promises.writeFile` は途中失敗時に半端な内容が残る可能性がある。

- master.md / conductor-role.md は数 KB 程度かつランタイム派生物（`cmux-team start` で再生成可能）のため、`writeFile` の best-effort 動作で許容する
- `template.ts` 内に 1 行コメントで方針を明示: `// best-effort write — runtime prompts are regenerable from templates`
- 将来 atomic 化が必要になれば `fs.promises.writeFile` → `tmp + rename` パターンへの差替えを検討

### 6. dashboard.tsx の Settings タブ表示増加

10 ロールに増えるため Settings タブの縦スクロール対象が 8 → 10 に増える。既存スクロール実装は `OVERLAY_ROLES.length` で動的に動くため追加対応不要だが、画面サイズが小さい環境で truncation が起きないか手動確認推奨。dashboard 既存の `dashboard-*.test.tsx` に「`AGENT_ROLES.length === 8` を前提」した assertion がないか Step 9 で grep 確認する。

### 7. `.team/prompts/master.md` がランタイム派生物である

CLAUDE.md「プロンプト編集ルール」§ より、`.team/prompts/master.md` を直接編集してはならない。本タスクではテンプレ (`skills/cmux-team/templates/{en,ja}/master.md`) のみ編集し、ランタイムは `cmux-team start` で再生成される設計を維持する。

### 8. `OverlayRole.options` の型推論（Minor §8）

`z.enum([...AgentRole.options, "master", "conductor"] as const)` の構文が TypeScript 環境によっては `as const` 周りで literal tuple を保てず `readonly string[]` に degrade するリスクがある。Step 1 実装後に `bunx tsc --noEmit` で `OverlayRole.options` が `readonly ["researcher", ..., "master", "conductor"]` に推論されていることを確認し、degrade した場合は明示的にタプル型注釈を付与する。

---

## テスト計画

### ユニットテスト（manager/*.test.ts）

| テストファイル | テストケース | 担当 Step |
|--------------|-------------|----------|
| `schema.test.ts` | OVERLAY_ROLES の構成、normalizeOverlayRole の master/conductor/エイリアス/未知 | Step 1 |
| `agent-instructions.test.ts` | master/conductor 用の write/read/delete round-trip、list 順序、size limit、expand mode | Steps 2, 3 |
| `template.test.ts`（新規） | generateMasterPrompt/generateConductorRolePrompt の overlay 展開、heredoc 内 placeholder 保護（必須・Major §4）、mode=empty 時の保護も明示テスト化 | Steps 4, 5 |
| `main.test.ts` | spawn-agent --role master/conductor 拒否、--role unknown-foo の汎用 unknown 拒否（Major §3）、get/set/delete/list-agent-instructions の master/conductor サポート | Steps 7, 8 |

### 統合テスト

- `cmux-team start` で実際に Master / Conductor を spawn し、`.team/prompts/master.md` / `.team/prompts/conductor-role.md` に overlay 本文が含まれることを Step 12 の手動コマンドで確認
- 既存全テストの regression 確認（CLAUDE.md 記載の per-file ループで実行）
- `grep -rn "AGENT_ROLES"` で移行漏れ検出（Minor §7）

### 受け入れテストとの対応

| AC | 担当テスト |
|----|-----------|
| AC1 | template.test.ts: generateMasterPrompt with overlay |
| AC2 | template.test.ts: generateConductorRolePrompt with overlay（conductor-role.md のみ — conductor.md は deprecated のため対象外）|
| AC3 | agent-instructions.test.ts: 既存 mode=empty テスト + master/conductor 用追加ケース、template.test.ts: heredoc literal 保持テスト（mode=empty も） |
| AC4 | main.test.ts: get/set/delete-agent-instructions --role master/conductor の subprocess test |
| AC5 | main.test.ts: spawn-agent --role master/conductor 拒否 + unknown-foo 拒否の subprocess test |
| AC6 | 既存 agent-instructions.test.ts 全件 pass + schema.test.ts 既存全件 pass |

---

## ドキュメント更新箇所の具体的な節

| ファイル | 節 | 更新内容 |
|---------|----|---------|
| `docs/spec/04-templates.md` | §「`{{PROJECT_INSTRUCTIONS}}` プレースホルダ（T247）」L54-78 | 対象ロールを 10 ロールに更新、`OverlayRole` enum サンプル追加、Master/Conductor の展開タイミング（spawn-agent ではなく `cmux-team start` / `spawn-master` / `cmux-team conductor` 起動時）を明記。`AgentRole`（spawn 可能）と `OverlayRole`（overlay 適用可能）の関係を表形式で説明 |
| `docs/spec/04-templates.md` | §「Master Template」L82-94 | 「Master 用テンプレート冒頭に `{{PROJECT_INSTRUCTIONS}}` 行を配置（T342）」を追記 |
| `docs/spec/04-templates.md` | §「Conductor Templates」L98-141 | conductor-role.md 説明に「Conductor 自身用の overlay は冒頭の `{{PROJECT_INSTRUCTIONS}}`、heredoc サンプル内のものは Agent 用 literal として保護される（最初の 1 件のみ展開仕様）」を追記 |
| `docs/spec/04-templates.md` | §「conductor.md（フルプロトコル版・deprecated）」L100-102 | **既存 deprecated 記述を残しつつ、末尾に 1 行追記**: 「※ T342 で `{{PROJECT_INSTRUCTIONS}}` placeholder 機構を Master / Conductor へ拡張した際も、本ファイルは deprecated のため placeholder 追加対象外。Conductor 用 overlay は `conductor-role.md` 経由で適用される。」 |
| `docs/spec/01-skill-cmux-team.md` | §1a「プロジェクト固有の追加指示」L97-120 | 対象ロールを 10 ロール、CLI コマンドの role 受付を OverlayRole、spawn-agent --role には master/conductor を渡せない、を反映 |
| `docs/spec/01-skill-cmux-team.md` | CLI 一覧表 L90-93 | 「8 ロール」表記を「10 ロール（Agent 8 + master + conductor）」に更新 |
| `README.md` | "Project-Specific Agent Instructions" L229-246 | role 列挙を「researcher / architect / planner / design-reviewer / implementer / inspector / dockeeper / task-manager / master / conductor」に拡張、Master/Conductor は spawn-agent 経由ではなく start 時に展開される旨を 1 行追記 |
| `README.ja.md` | "プロジェクト固有の追加指示" L277-294 | 同上の和訳 |

---

## 完了判定

以下が全て満たされた時点で実装完了:

1. AC1-AC6 すべての受け入れテストが pass
2. `cd skills/cmux-team/manager && bunx tsc --noEmit` がエラー 0
3. 既存 `agent-instructions.test.ts` / `schema.test.ts` の全 pass
4. 新規追加 test ケース（特に Major §4 の heredoc literal 保持テスト 2 件）の全 pass
5. dashboard `dashboard-*.test.tsx` の regression なし
6. `grep -rn "AGENT_ROLES" skills/ docs/ README.md README.ja.md`（test/定義ファイル除く）で移行漏れなし
7. docs/spec / README の更新コミット（`conductor.md` deprecated 注記の更新を含む）
