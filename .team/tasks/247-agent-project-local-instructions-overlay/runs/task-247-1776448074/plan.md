# Plan: Agent ロール別 project-local instructions overlay 機構の追加

> **Revision 2**: Design Review（design-review.md）の Critical（C1-C2）/ Major（M1-M5）/ Minor（m1-m7）/ Recommendation 8 を反映。
> 主要な構造変更は以下:
> - `expandProjectInstructions` を単一の正準関数として再設計（Step 3）し、`cmdSpawnAgent`（Step 5）はそれを呼ぶだけにする（C1）
> - `loadConfig` / `TeamConfig` を新規 `skills/cmux-team/manager/config.ts` に抽出（C2、m7）
> - `formatProjectInstructionsBlock(body, locale)` に locale を導入し、見出しを i18n 化（M1）

## 1. 概要

### ゴール
- 全 8 Agent ロール（researcher / architect / planner / design-reviewer / implementer / inspector / dockeeper / task-manager）に、プロジェクト固有の追加指示（overlay）を差し込める機構を導入する
- overlay は `.team/agent-instructions/<role>.md` に git 管理で置かれ、CLI で読み書き、TUI Settings タブで read-only 閲覧できる
- spawn-agent 実行時に overlay 内容をプロンプトに焼き付ける「起動スナップショット方式」を採る（実行中の overlay 変更は無視）

### 非ゴール
- overlay 内のテンプレート変数展開（初版では `{{...}}` 記法を禁止する）
- overlay 編集 UI（TUI は read-only。CLI 経由で編集）
- overlay の priority 制御や複数ロール継承
- Conductor / Master / Manager 等の非 Agent ロール向け overlay

---

## 2. 現状調査

### 2.1 既存テンプレート展開フロー

`skills/cmux-team/manager/template.ts` が変数展開を行うのは以下 3 つのテンプレートのみ:

| テンプレート | 展開関数 | 展開される変数 |
|-------------|----------|---------------|
| `master.md` | `generateMasterPrompt` | （変数なし、`cp` のみ） |
| `conductor-role.md` | `generateConductorRolePrompt` | `{{PROJECT_ROOT}}`, `{{MAIN_BRANCH}}` |
| `conductor-task.md` | `generateConductorTaskPrompt` | `{{TASK_CONTENT}}`, `{{WORKTREE_PATH}}`, `{{OUTPUT_DIR}}`, `{{PROJECT_ROOT}}`, `{{CONDUCTOR_ID}}`, `{{MAIN_BRANCH}}`, `{{BASE_BRANCH}}` |

Agent ロール用テンプレート（`templates/{ja,en}/{researcher,architect,planner,design-reviewer,implementer,inspector,dockeeper,task-manager}.md`）は `template.ts` から展開されない。これらは **Conductor が heredoc で最終プロンプトを手組みするときの参考リファレンス** である（`conductor-role.md` 188-193, 197-251 参照）。

つまり Agent に渡る最終プロンプトは、Conductor 内の heredoc ブロック（`cat > "$PROMPT_FILE" << 'AGENT_PROMPT' ... AGENT_PROMPT`）が作る。

### 2.2 spawn-agent のプロンプト取扱い

`cmdSpawnAgent`（`main.ts:1925-2113`）は `--prompt-file` を受け取るが、**ファイル内容を一切読まない**。以下の行で Claude に渡すだけ:

```ts
claudeCmd = `claude ${claudeFlags.join(" ")} '${promptFile} を読んで指示に従ってください。'`;
```

Claude 側がファイルを Read する。よって、spawn-agent で overlay を焼き付ける場合、**prompt-file を読んで `{{PROJECT_INSTRUCTIONS}}` を置換し、展開済みの別ファイルを書き出してそのパスを Claude に渡す**必要がある。

### 2.3 CLI コマンド定義パターン

`main.ts:3715-3795` の switch 文で分岐し、`async function cmd<Name>()` で実装する。引数は `getArg(name)`（optional） / `requireArg(name)`（必須） / `args.includes("--flag")`（boolean）で取得。

ヘルプテキストは `i18n.ts` に `help_<command>` として登録し、`hasHelpFlag()` の時 `showHelp(t("help_<command>"))` で表示して exit 0。

### 2.4 TUI タブ構造（dashboard.tsx）

- `AppState.activeTab: "journal" | "artifacts" | "log"`（`dashboard.tsx:297`）
- タブは `ui.row` で横並びの `ui.button`、`onPress: () => switchTab("...")` で切替
- キーバインド: `1/2/3` (`dashboard.tsx:1179-1181`) / `J/A/L` (1189-1191) / `Tab` でサイクル (1182-1187)
- `switchTab()` が `focusedArea` も連動更新（`FOCUSED_AREA_FOR_TAB` マップ）
- 本文レンダは `state.activeTab === "xxx" ? ... : ...` の三項連鎖（1040-1060）
- `footer: ui.statusBar` の `left` は `focusedArea` ごとに分岐したキーバインドヒント

### 2.5 `.team/.gitignore`

worktree 内で確認済の現状:
```
output/
prompts/
docs-snapshot/
status.json
logs/
queue/
task-state.json
tasks/*.status.json
traces/
debug/dump.jsonl
debug/otel-dump.jsonl
```
`agent-instructions/` は含まれず、`*/` のような包括 glob も無い。**Step 10 は「確認済: 変更不要」で閉じる**（m6）。

### 2.6 既存 `loadConfig` の所在と可視性（C2 の前提）

`main.ts:97-129` に `TeamConfig` interface と `loadConfig()` 関数が module-local で定義されている（`export` されていない）。現状 `main.ts` の複数箇所（L1709, L1737, L1828, L1887, L2038 等）と `resolveLayout` / `resolveAutoUpdateMode` から呼ばれる。

`dashboard.tsx` からは現時点で `loadConfig` を呼ぶ経路が無いため、Settings タブ（Step 8）で参照するには export または別モジュール化が必要。

---

## 3. 設計判断（Decision Log）

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | `{{PROJECT_INSTRUCTIONS}}` を誰が展開するか | **spawn-agent CLI が prompt-file を読んで自動展開**。展開済みを別ファイルに書き出して Claude に渡す。元ファイルは変更しない | (a) spawn-agent は `--role` を受け取る唯一の地点で、PROJECT_ROOT と組み合わせて overlay を解決できる。(b) Conductor は heredoc に `{{PROJECT_INSTRUCTIONS}}` を残すだけでよく、展開ロジックを Conductor に押し付けない。(c) 「起動スナップショット方式」に合致 |
| D2 | overlay 最大サイズ制限 | **100 KB** | コンテキスト圧迫を抑える現実的な上限。set 時に size ガード |
| D3 | overlay 内で `{{VARIABLE}}` 記法を使えるか | **初版は禁止**（使えない） | spawn-agent の置換対象を `{{PROJECT_INSTRUCTIONS}}` 1 つに限定し、overlay 内容は replace 対象にしない（overlay 内の `{{...}}` はそのままテキストとして Agent に渡る） |
| D4 | TUI Settings タブのキーボードショートカット | **`4` と大文字 `S`**、Tab キーのサイクルに追加 | 既存の `1/2/3` + `J/A/L` の流儀に整合。**注記（m3）**: 小文字 `s` は `focusedArea === "artifacts"` の時のみ artifacts sort に使われており、大文字 `S` は Ink/cmux が case-sensitive に処理するため衝突しない。Settings タブ切替は大文字 `S` 限定で、artifact sort とは独立に動作する |
| D5 | role enum の共通化 | `schema.ts` に `AgentRole = z.enum([...])` を追加 | `main.ts` / `dashboard.tsx` / 新規 `agent-instructions.ts` / `template.ts` で SSOT とする |
| D6 | overlay 不在時の `{{PROJECT_INSTRUCTIONS}}` 置換結果 | **空文字**。さらに `expandProjectInstructions` は `{{PROJECT_INSTRUCTIONS}}` を含む行（前後の改行 1 つずつ）単位で replace し、空行 3 連続（`\n\n\n+`）を発生させない | 検証観点「余分な空行や `{{...}}` 残骸が残らない」を満たす（m2） |
| D7 | overlay ありのブロック書式と locale 対応 | **locale 別見出し**: ja = `## プロジェクト固有の追加指示`、en = `## Project-Specific Instructions`。`formatProjectInstructionsBlock(body, locale)` が `\n<heading>\n\n<body.trimEnd()>\n` を返す。見出し文字列は `i18n.ts` の `project_instructions_heading_ja` / `project_instructions_heading_en` キーに配置し、`locale` export に応じて選択 | プロンプト内視認性。`templates/en/` のロール参考テンプレが英語 locale で使われる想定に合わせる（M1） |
| D8 | spawn-agent の未知 role | prompt-file に `{{PROJECT_INSTRUCTIONS}}` が含まれても、role が AgentRole enum 外ならエラーにせず空文字置換（warn ログ）。**非対称の理由**: `set-agent-instructions` はユーザーが role をタイプするフロント入口なのでミス検出が価値（exit 1）。`spawn-agent` は Conductor 自動生成が多く、厳格化で既存動作を壊すリスクがあるため warn に留める（m5） | 後方互換（impl 等のエイリアスを壊さない）。未知 role は enum 内にマッピングする: `impl` → `implementer`（後述 D10） |
| D9 | overlay 編集 TUI | 実装しない（read-only）。 | タスク仕様通り。編集は CLI 経由 |
| D10 | role エイリアス | `impl` → `implementer`、`reviewer` → `design-reviewer` を `normalizeAgentRole` 内で正規化 | 既存テンプレート `conductor-role.md` に `--role impl` の例がある（L142）ため、後方互換でエイリアス解決してから overlay 参照 |
| D11 | `set-agent-instructions` の入力方法 | `--body <text>` / `--from-file <path>` / `--from-stdin` の 3 択（排他） | CLI 既存パターン（`send` が `--from-stdin` を持つ）に準拠 |
| D12 | overlay ファイルの正規化 | 書き込み時に末尾改行を保証、それ以外は **変更しない**（frontmatter 禁止もあくまで運用ルール） | プレーン Markdown のまま保存し、書式変換をしない |
| D13 | `list-agent-instructions` の出力 | 1 行 1 ロール。`implementer ✓ 142 bytes` / `inspector ✗` 形式（`AgentRole` enum 順） | 人間可読で `awk`/`grep` でもパース可能 |
| D14 | Settings タブのプレビュー表示行数 | overlay は最大 20 行まで表示（超過時は末尾に `... (truncated, use 'cmux-team get-agent-instructions --role <role>' for full)`）。Project Config は全キー・全値表示 | 縦スペース圧迫を防ぐ |
| D15 | Settings タブから Enter で開く動作 | overlay 行にカーソルがある時のみ外部ビューアで overlay ファイルを開く（既存 `openArtifactInViewer` を流用）。config 行は何もしない | 既存 Artifacts タブの Enter 挙動と整合 |
| D16 | `loadConfig` の配置 | **新規 `skills/cmux-team/manager/config.ts` に抽出**し、`TeamConfig` 型も併せて移動。`main.ts` と `dashboard.tsx` 双方から import する（C2, m7） | `main.ts` は既に 3800 行超で、export 追加より抽出の方が将来のメンテ性が高い。`resolveLayout` / `resolveAutoUpdateMode` / `normalizeAutoUpdate` も関連して `config.ts` に移す |
| D17 | Settings タブの refresh 戦略 | **`state.activeTab === "settings"` の時のみ** `loadSettingsItems` を refresh で実行する。タブ切替時（`switchTab("settings")`）にも 1 回 trigger する（M3） | 非 Settings タブで 2s ごとに 9 ファイル read する無駄を回避。ファイル差分 watch は過剰 |
| D18 | `cmdSpawnAgent` での prompt-file 読み取り失敗時の挙動 | try/catch で捕捉し `log("project_instructions_read_failed", ...)` を出力、元の `promptFile` パスをそのまま Claude に渡す fallback（M4） | 権限エラー・競合書き込み中などの稀なケースで spawn 全体を落とさない。overlay は best-effort |

---

## 4. 実装ステップ

### Step 1: `schema.ts` に AgentRole enum を追加

**対象**: `skills/cmux-team/manager/schema.ts`

```ts
export const AgentRole = z.enum([
  "researcher",
  "architect",
  "planner",
  "design-reviewer",
  "implementer",
  "inspector",
  "dockeeper",
  "task-manager",
]);
export type AgentRole = z.infer<typeof AgentRole>;
export const AGENT_ROLES: readonly AgentRole[] = AgentRole.options;

/** role エイリアスを正規化。未知なら undefined を返す */
export function normalizeAgentRole(raw: string): AgentRole | undefined {
  const alias: Record<string, AgentRole> = {
    impl: "implementer",
    reviewer: "design-reviewer",
  };
  const key = alias[raw] ?? raw;
  const parsed = AgentRole.safeParse(key);
  return parsed.success ? parsed.data : undefined;
}
```

**完了条件**: `bunx tsc --noEmit` が pass する。`schema.ts` から `AgentRole` / `AGENT_ROLES` / `normalizeAgentRole` が export される。
**検証コマンド**: `grep -c "export const AgentRole" skills/cmux-team/manager/schema.ts` = 1

---

### Step 2: `agent-instructions.ts` を新規作成

**対象**: `skills/cmux-team/manager/agent-instructions.ts`（新規）

新規モジュールが提供する API:

```ts
export const AGENT_INSTRUCTIONS_DIR_REL = ".team/agent-instructions";
export const AGENT_INSTRUCTIONS_MAX_BYTES = 100 * 1024; // 100KB

export function agentInstructionsPath(projectRoot: string, role: AgentRole): string;
export async function readProjectInstructions(projectRoot: string, role: AgentRole): Promise<string | null>;
export async function writeProjectInstructions(projectRoot: string, role: AgentRole, body: string): Promise<void>;
export async function deleteProjectInstructions(projectRoot: string, role: AgentRole): Promise<boolean>;
export async function listProjectInstructions(projectRoot: string): Promise<Array<{role: AgentRole; exists: boolean; size: number}>>;

/**
 * `{{PROJECT_INSTRUCTIONS}}` に注入するテキストブロックを返す。
 * body が null/空 → 空文字。
 * ありなら `\n<heading>\n\n<body.trimEnd()>\n` を返す（heading は locale 別、i18n.ts から取得）。
 */
export function formatProjectInstructionsBlock(body: string | null, locale: Locale): string;
```

**仕様**:
- `readProjectInstructions`: ファイルが無ければ null、あれば UTF-8 で読み取り
- `writeProjectInstructions`: body サイズ > `AGENT_INSTRUCTIONS_MAX_BYTES` なら `throw new Error("overlay exceeds 100KB limit")`。ディレクトリを作成。末尾改行を保証
- `deleteProjectInstructions`: 存在しなければ false を返す（エラーにしない）
- `listProjectInstructions`: `AGENT_ROLES` 順に列挙。`exists` / `size`（byte）を返す
- `formatProjectInstructionsBlock`: body が null or 空文字 → 空文字。ありなら locale に応じた見出しを冒頭に付けたブロック文字列（末尾改行 1 つ）を返す（D7）

**完了条件**: 上記 API が全て export され、`bunx tsc --noEmit` pass。
**検証方法**: 新規 `agent-instructions.test.ts` を追加し、以下をカバー:
- read → write → read の round-trip が同じ内容
- write が 100KB 超でエラー
- format が null / 空文字 / 本文あり（ja / en 両方）で正しいブロックを返す
- delete → list で exists=false

---

### Step 3: `template.ts` に `expandProjectInstructions` を単一正準関数として追加

**対象**: `skills/cmux-team/manager/template.ts`

**C1 対応**: Step 5（`cmdSpawnAgent`）は展開ロジックをインライン実装せず、この関数を呼ぶだけにする。

```ts
/**
 * prompt 本文（content）中の `{{PROJECT_INSTRUCTIONS}}` プレースホルダを overlay の内容で置換する。
 *
 * - roleRaw は未正規化の role 文字列（"impl" 等のエイリアスも受け取る）。内部で normalizeAgentRole する
 * - content に `{{PROJECT_INSTRUCTIONS}}` が 0 件 → noop（content をそのまま返す）
 * - content に含まれ、かつ role 正規化成功・overlay あり → applied（overlay 内容をブロック書式で注入）
 * - content に含まれ、かつ role 正規化成功・overlay なし → empty（プレースホルダを空文字に置換、空行 3 連続を防ぐ）
 * - content に含まれ、かつ role 正規化失敗 → unknown-role（プレースホルダを空文字に置換）
 *
 * mode を返すので、呼び出し元がログ出力（applied / empty / unknown-role）と
 * 展開ファイル書き出しの要否（mode !== "noop"）を 1 箇所で判定できる。
 */
export async function expandProjectInstructions(
  projectRoot: string,
  roleRaw: string,
  content: string,
): Promise<{ expanded: string; mode: "noop" | "applied" | "empty" | "unknown-role" }>;
```

**仕様**:
- `content.includes("{{PROJECT_INSTRUCTIONS}}")` が false → `{ expanded: content, mode: "noop" }`
- true の場合:
  - `normalizeAgentRole(roleRaw)` → undefined なら mode = `"unknown-role"`、block は `""`
  - 正規化成功なら `readProjectInstructions(projectRoot, normalized)` → `body`
    - `body === null || body === ""` → mode = `"empty"`、block = `""`
    - 中身あり → mode = `"applied"`、block = `formatProjectInstructionsBlock(body, locale)`
  - replace ルール（D6, m2）: 連続空行 3 つ以上を防ぐため、プレースホルダが単独行の場合は行全体（前後の改行 1 つずつ）を block に置き換え、block が空文字なら残る改行も 1 つだけに収束させる。具体的には正規表現 `/\n{{PROJECT_INSTRUCTIONS}}\n/` で検索し、block が空なら `"\n"`、そうでなければ `"\n" + block` に置換する（block 自体が末尾改行を含む）。プレースホルダが単独行でない場合は `replaceAll("{{PROJECT_INSTRUCTIONS}}", block)` にフォールバック

**完了条件**: 型チェック pass。test から mode 4 種が全てカバーされる。
**検証方法**: `agent-instructions.test.ts` に `expandProjectInstructions` の 4 分岐 + 連続空行発生なしの assert（7.1 test 10 / 追加項目）を含める。

---

### Step 4: `config.ts` を新規作成し `loadConfig` / `TeamConfig` を抽出（C2, m7）

**対象**:
- `skills/cmux-team/manager/config.ts`（新規）
- `skills/cmux-team/manager/main.ts`（抽出元。import に差し替え）

新規モジュールが提供する API:

```ts
export interface TeamConfig {
  models?: { master?: string; conductor?: string; agent?: string };
  envrcHookPromptSkipped?: boolean;
  layout?: LayoutMode;
  sleepPrevention?: boolean;
  autoUpdate?: boolean | AutoUpdateMode;
  mainBranch?: string;
}

/** .team/config.json を読み込む。存在しない / 壊れている時は空オブジェクトを返す */
export async function loadConfig(projectRoot: string): Promise<TeamConfig>;

export function resolveLayout(config: Pick<TeamConfig, "layout">, cliLayout: string | undefined): LayoutMode;
export function resolveAutoUpdateMode(
  config: Pick<TeamConfig, "autoUpdate">,
  env?: NodeJS.ProcessEnv,
): { mode: AutoUpdateMode; source: "env" | "config" | "default" };
```

**変更点**:
- 現状 `main.ts:97-120` の `TeamConfig` interface を `config.ts` に移動し `export`
- 現状 `main.ts:122-129` の `loadConfig()` を `config.ts` に移動し、`projectRoot` を引数化して `export`（既存挙動を変えず、呼び出し側が `PROJECT_ROOT` を渡す）
- `resolveLayout` / `resolveAutoUpdateMode` / 関連する `normalizeAutoUpdate` も `config.ts` に移動（既存 export のまま移動）
- `main.ts` の全 `loadConfig()` 呼び出しを `loadConfig(PROJECT_ROOT)` に置換
- `main.ts` 内で使われる `TeamConfig` / `loadConfig` / `resolveLayout` / `resolveAutoUpdateMode` は `import { ... } from "./config"` に変更

**完了条件**:
- `bunx tsc --noEmit` pass
- `grep -nE "interface TeamConfig|async function loadConfig" skills/cmux-team/manager/main.ts` が 0 件
- `grep -c "from \"./config\"" skills/cmux-team/manager/main.ts` が 1 件以上

**検証方法**: 既存の `main.test.ts` / `daemon.test.ts` が引き続き pass すること。

---

### Step 5: `main.ts` に 4 CLI コマンドを追加

**対象**: `skills/cmux-team/manager/main.ts`, `skills/cmux-team/manager/i18n.ts`

追加関数:

#### 5.1 `cmdGetAgentInstructions`
- 引数: `--role <role>`（必須）
- 挙動:
  - `normalizeAgentRole(role)` で正規化 → undefined なら stderr にエラー + exit 1
  - `readProjectInstructions(PROJECT_ROOT, role)` を呼び、あれば stdout に出力（末尾改行あり）、なければ何も出さずに exit 0

#### 5.2 `cmdSetAgentInstructions`
- 引数: `--role <role>` (必須) + `--body <text>` / `--from-file <path>` / `--from-stdin` のいずれか 1 つ
- 挙動:
  - 入力が複数指定 or 0 個 → exit 1
  - `--from-file` で指定パスが無い → exit 1
  - `--from-stdin` なら `readStdin()` で読み取り
  - role を正規化 → undefined なら exit 1（厳格: D8 の非対称方針）
  - `writeProjectInstructions()`。100KB 超過で exit 1
  - stdout に `OK role=<role> bytes=<n>` を出力

#### 5.3 `cmdDeleteAgentInstructions`
- 引数: `--role <role>`（必須）
- 挙動: role 正規化 → `deleteProjectInstructions` → 結果を `DELETED=true|false` で出力 + exit 0

#### 5.4 `cmdListAgentInstructions`
- 引数: なし
- 挙動: `listProjectInstructions()` を呼び、`AGENT_ROLES` 順に `<role> ✓ <n> bytes` / `<role> ✗` 形式で 1 行ずつ出力

#### 5.5 switch 文追加（`main.ts:3715` 付近）

```ts
case "get-agent-instructions":
  await cmdGetAgentInstructions();
  break;
case "set-agent-instructions":
  await cmdSetAgentInstructions();
  break;
case "delete-agent-instructions":
  await cmdDeleteAgentInstructions();
  break;
case "list-agent-instructions":
  await cmdListAgentInstructions();
  break;
```

#### 5.6 i18n ヘルプテキスト + 見出し文字列

`i18n.ts` の `en` / `ja` それぞれに以下を追加:
- `help_get_agent_instructions` / `help_set_agent_instructions` / `help_delete_agent_instructions` / `help_list_agent_instructions`
- **`project_instructions_heading`**: ja = `"プロジェクト固有の追加指示"`, en = `"Project-Specific Instructions"`（M1, D7）
- `formatProjectInstructionsBlock` は `locale` 引数から `t("project_instructions_heading")` 相当の値を参照

#### 5.7 `help_main` への追加

`help_main` に 4 コマンドの 1 行サマリーを追加する。

**完了条件**: `cmux-team get-agent-instructions --help` 等が動作し、round-trip が正常。
**検証コマンド**:
```bash
bun run skills/cmux-team/manager/main.ts set-agent-instructions --role implementer --body "test"
bun run skills/cmux-team/manager/main.ts get-agent-instructions --role implementer
bun run skills/cmux-team/manager/main.ts list-agent-instructions
bun run skills/cmux-team/manager/main.ts delete-agent-instructions --role implementer
bun run skills/cmux-team/manager/main.ts set-agent-instructions --role foobar --body x  # exit 1
```

---

### Step 6: `cmdSpawnAgent` を修正し、prompt-file の `{{PROJECT_INSTRUCTIONS}}` を自動展開

**対象**: `skills/cmux-team/manager/main.ts`（`cmdSpawnAgent`、L1925-2113 周辺）

**C1 対応**: 展開ロジックは全て `expandProjectInstructions` に集約。`cmdSpawnAgent` は呼び出してログを出すだけ。

**M4 対応**: `readFile` 失敗時は try/catch で捕捉し、元の `promptFile` をそのまま使う fallback。

**M2 対応（後半）**: `promptFile` が存在するが `{{PROJECT_INSTRUCTIONS}}` プレースホルダを**含まない**場合、`role` が AgentRole enum 内であれば warn ログを出す（Inspector がログ監査で検出可能）。

**変更点**: L2077-2082 の `claudeCmd` 構築の直前に以下を挿入:

```ts
// --- 2b. prompt-file に {{PROJECT_INSTRUCTIONS}} が含まれていれば overlay を焼き付けた展開版を作る ---
let effectivePromptFile = promptFile;
if (promptFile) {
  try {
    const raw = await readFile(promptFile, "utf-8");
    const normalizedRole = normalizeAgentRole(role);

    // placeholder 欠落検出（M2: AgentRole enum 内かつ placeholder 不在の場合のみ warn）
    if (normalizedRole && !raw.includes("{{PROJECT_INSTRUCTIONS}}")) {
      await log(
        "project_instructions_missing_placeholder",
        `surface=${surface} role=${role} prompt_file=${promptFile} — overlay placeholder not found`,
      );
    }

    const { expanded, mode } = await expandProjectInstructions(PROJECT_ROOT, role, raw);
    if (mode !== "noop") {
      const base = basename(promptFile).replace(/\.md$/, "");
      const outPath = join(PROJECT_ROOT, ".team/prompts", `${base}.expanded.md`);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, expanded);
      effectivePromptFile = outPath;
      await log(
        mode === "unknown-role" ? "project_instructions_unknown_role" : "project_instructions_applied",
        `surface=${surface} role=${role} mode=${mode} expanded=${outPath}`,
      );
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await log(
      "project_instructions_read_failed",
      `surface=${surface} role=${role} err=${msg} — falling back to original prompt`,
    );
    // effectivePromptFile は元の promptFile のまま
  }
}
// ... 以降 promptFile を effectivePromptFile に置換
if (effectivePromptFile) {
  claudeCmd = `claude ${claudeFlags.join(" ")} '${effectivePromptFile} を読んで指示に従ってください。'`;
} else {
  claudeCmd = `claude ${claudeFlags.join(" ")} '${prompt}'`;
}
```

**完了条件**: prompt-file に `{{PROJECT_INSTRUCTIONS}}` がある時のみ expanded ファイルが生成される。無い時は従来挙動 + warn ログ（AgentRole のみ）。読み取り失敗時は fallback。
**検証方法**: 手動 E2E（下記 7. 検証計画）+ `project_instructions_applied` / `project_instructions_missing_placeholder` / `project_instructions_read_failed` のログが出ること

**メソッド制約**:
- prompt-file の元ファイルは書き換えない（冪等性）
- expanded ファイルパスは `.team/prompts/<basename>.expanded.md` 固定。既存ファイルは上書き（再起動で再展開される想定）
- 展開ロジックは `expandProjectInstructions` の呼び出し 1 回に集約（C1）
- try/catch で readFile 失敗を吸収し、元の promptFile で続行（M4）

---

### Step 7: 全 8 Agent ロールテンプレート（ja/en 計 16 ファイル）に `{{PROJECT_INSTRUCTIONS}}` を挿入

**対象**: `skills/cmux-team/templates/{ja,en}/{researcher,architect,planner,design-reviewer,implementer,inspector,dockeeper,task-manager}.md`

**挿入位置と書式**:

各ファイルで `{{COMMON_HEADER}}` + Role 導入文（"## Role: ..." + 1-2 行の説明）の直後、最初の変数ブロック（`{{TASK_CONTENT}}` / `{{PLAN_CONTENT}}` / `{{REQUIREMENTS_CONTENT}}` 等）の直前に以下を挿入:

```markdown

{{PROJECT_INSTRUCTIONS}}
```

（前後に空行を 1 つずつ。`expandProjectInstructions` が overlay 不在時に `\n{{PROJECT_INSTRUCTIONS}}\n` を `\n` に圧縮するため、空行の重複は残らない）

**例**: `templates/ja/planner.md`

変更前（line 1-7）:
```markdown
{{COMMON_HEADER}}

## Role: Planner
あなたは計画立案エージェントです。タスクを分析し、実装計画書 (plan.md) を作成します。

## タスク内容
{{TASK_CONTENT}}
```

変更後:
```markdown
{{COMMON_HEADER}}

## Role: Planner
あなたは計画立案エージェントです。タスクを分析し、実装計画書 (plan.md) を作成します。

{{PROJECT_INSTRUCTIONS}}

## タスク内容
{{TASK_CONTENT}}
```

**完了条件**: 16 ファイル全てに `{{PROJECT_INSTRUCTIONS}}` が 1 箇所ずつ含まれる。
**検証コマンド**:
```bash
for loc in ja en; do
  for role in researcher architect planner design-reviewer implementer inspector dockeeper task-manager; do
    n=$(grep -c "{{PROJECT_INSTRUCTIONS}}" skills/cmux-team/templates/$loc/$role.md)
    [ "$n" = "1" ] || echo "MISSING: $loc/$role.md (count=$n)"
  done
done
# 何も出力されなければ OK
```

**重要**: `common-header.md` / `conductor*.md` / `manager.md` / `master.md` には挿入しない。

---

### Step 8: Conductor テンプレートに全ロール共通の注意書きと heredoc 更新を入れる（M2）

**対象**: `skills/cmux-team/templates/{ja,en}/conductor-role.md`, `skills/cmux-team/templates/{ja,en}/conductor.md`

**M2 対応**: Conductor が 8 ロール全てで `{{PROJECT_INSTRUCTIONS}}` を heredoc に含める保証を強化するため、「Agent 起動手順」セクション冒頭に**全ロール共通**の注意書きを追加する。

#### 8.1 「Agent 起動手順」セクション冒頭に以下を追記

```markdown
> **重要（全 Agent ロール共通）:** heredoc 本文の Role 導入文（`## Role: ...` + 1-2 行の説明）の直後に、`{{PROJECT_INSTRUCTIONS}}` を 1 行独立して残すこと。
> `cmux-team spawn-agent` が prompt-file を読み、このプレースホルダを `.team/agent-instructions/<role>.md` の内容で置換する。
> overlay が無ければ空文字に置換され、余分な空行は残らない。
> placeholder を残し忘れると overlay が効かないが、spawn-agent が warn ログ（`project_instructions_missing_placeholder`）を出すので Inspector が検出可能。
```

#### 8.2 heredoc サンプルコード自体にも `{{PROJECT_INSTRUCTIONS}}` を含める

- `conductor-role.md` L110-132（impl サンプル）と L199-244（researcher サンプル）の heredoc に `{{PROJECT_INSTRUCTIONS}}` を追加
- `conductor.md` L100-110 の同様箇所も更新
- **m4 対応の注記**: quoted heredoc（`'AGENT_PROMPT'`、変数展開なし）が推奨。現行サンプル L116 は quoted だが L207 は unquoted のため、`{{PROJECT_INSTRUCTIONS}}` を追加する際に unquoted のほうも quoted 化を推奨する注記を近隣に入れる（`$` を含まないため literal 保持は確保されるが、将来的な誤展開事故を防ぐ）

#### 8.3 新規小節を追加

```markdown
## プロジェクト固有の追加指示（overlay）

Agent プロンプト本文に `{{PROJECT_INSTRUCTIONS}}` プレースホルダを残しておくと、
`cmux-team spawn-agent` が実行時に `.team/agent-instructions/<role>.md` の内容を
自動展開する。overlay ファイルが無い場合は空文字に置換される。

overlay の編集:
- `cmux-team get-agent-instructions --role <role>` で内容確認
- `cmux-team set-agent-instructions --role <role> --from-file <path>` で更新
- `cmux-team delete-agent-instructions --role <role>` で削除
- `cmux-team list-agent-instructions` で全ロールの有無を一覧

Conductor が heredoc で作る Agent プロンプトは、同じ `{{PROJECT_INSTRUCTIONS}}` を
そのまま残せばよい（shell 変数展開の対象ではない）。
```

**完了条件**: ja/en 両方の conductor-role.md / conductor.md に注意書き + 新セクションが存在し、heredoc サンプルにも `{{PROJECT_INSTRUCTIONS}}` が含まれている。
**検証コマンド**:
```bash
for f in skills/cmux-team/templates/{ja,en}/{conductor-role,conductor}.md; do
  grep -q "重要（全 Agent ロール共通）" "$f" || grep -q "IMPORTANT.*agent role" "$f" || echo "MISSING notice: $f"
  grep -q "プロジェクト固有の追加指示（overlay）" "$f" || grep -q "Project-Specific Instructions.*overlay" "$f" || echo "MISSING section: $f"
done
```

---

### Step 9: `dashboard.tsx` に Settings タブを追加

**対象**: `skills/cmux-team/manager/dashboard.tsx`

#### 9.1 `AppState` 拡張

```ts
interface AppState {
  // ...
  activeTab: "journal" | "artifacts" | "log" | "settings";
  settingsCursor: number;
  settingsItems: SettingsItem[];  // Settings タブ表示時のみロード
}

type SettingsItem =
  | { kind: "section"; label: string }
  | { kind: "overlay"; role: AgentRole; exists: boolean; size: number; content: string | null }
  | { kind: "config"; key: string; value: string };
```

`focusedArea` も `"settings"` を追加。

#### 9.2 データロードと refresh 戦略（M3, D17）

新規ヘルパー:

```ts
async function loadSettingsItems(projectRoot: string): Promise<SettingsItem[]> {
  const overlays = await listProjectInstructions(projectRoot);
  const overlayItems: SettingsItem[] = await Promise.all(overlays.map(async (o) => ({
    kind: "overlay" as const,
    role: o.role,
    exists: o.exists,
    size: o.size,
    content: o.exists ? await readProjectInstructions(projectRoot, o.role) : null,
  })));
  const config = await loadConfig(projectRoot);  // config.ts から import
  const configItems: SettingsItem[] = [
    { kind: "config", key: "layout", value: String(config.layout ?? "wide") },
    { kind: "config", key: "autoUpdate", value: String(config.autoUpdate ?? "off") },
    { kind: "config", key: "mainBranch", value: String(config.mainBranch ?? "-") },
  ];
  return [
    { kind: "section", label: "Agent Instructions" },
    ...overlayItems,
    { kind: "section", label: "Project Config" },
    ...configItems,
  ];
}
```

**refresh 戦略**:
- `refresh()` の中で **`state.activeTab === "settings"` の時のみ** `loadSettingsItems` を呼び出す（2s ごとの無駄な read を避ける）
- `switchTab("settings")` の中でも 1 回だけ `loadSettingsItems` を trigger する（タブに切り替わった瞬間に即反映）
- 非 Settings タブでは `state.settingsItems` は stale だが、Settings タブに戻った瞬間に refresh で更新されるので UX 上問題なし

#### 9.3 描画

`buildViewWithApp` のタブ切替三項（L1040-1060）を以下に拡張:

```ts
state.activeTab === "journal" ? (...)
  : state.activeTab === "artifacts" ? (...)
  : state.activeTab === "log" ? (...)
  : buildSettingsRows(state)  // ← 新規
```

`buildSettingsRows(state)` は 2 カラム `ui.row` を返す:
- 左: settingsItems をカーソル付きで列挙（section は bold、overlay は `✓ 142 bytes` / `✗`、config は `key=value`）
- 右: `settingsItems[settingsCursor]` のプレビュー
  - overlay: 20 行まで表示（超過時は末尾に `... (truncated)`）
  - config: 値 1 行
  - section: 空

#### 9.4 タブボタン追加

L1017-1039 の `ui.row` に `ui.button({ id: "tab-settings", label: "Settings", ..., onPress: () => switchTab("settings") })` を追加。

#### 9.5 キーバインド

- `4`: `switchTab("settings")`（L1181 の後ろに追加）
- 大文字 `S`: `switchTab("settings")`（L1188-1191 の `J/A/L` と同列に追加、D4 の m3 注記も参照）
- Tab サイクル配列に `"settings"` を追加（L1183）
- `Up/Down`: `focusedArea === "settings"` のとき `settingsCursor` を変更
- `Enter`: overlay 行なら `openArtifactInViewer` で overlay ファイルを開く、それ以外は no-op

#### 9.6 `FOCUSED_AREA_FOR_TAB` / `focusedArea` type

```ts
const FOCUSED_AREA_FOR_TAB: Record<TabId, AppState["focusedArea"]> = {
  journal: "journal",
  artifacts: "artifacts",
  log: "log",
  settings: "settings",
};
```

`focusedArea` は `"global" | "tasks" | "journal" | "artifacts" | "log" | "settings"`。

#### 9.7 footer ヒント

`focusedArea === "settings"` の case を追加:

```ts
state.focusedArea === "settings"
  ? [
      ui.kbd("↑/↓"), ui.text("select"),
      ui.kbd("Enter"), ui.text("open"),
      ui.kbd("J"), ui.text("journal"),
      ui.kbd("L"), ui.text("log"),
      ui.kbd("A"), ui.text("artifacts"),
      ui.text("(edit: cmux-team set-agent-instructions --role <role>)", { dim: true }),
      ui.kbd("ESC"), ui.text("back"),
    ]
```

タブバーの右側 / 他の `footer` にも `S settings` エントリを追加。

**完了条件**: `cmux-team start` 後に `S` または `4` で Settings タブに切替可能。overlay 8 ロール + config 3 項目が表示される。Enter で overlay ファイルがビューアで開ける。Settings 非表示時に `loadSettingsItems` が呼ばれないこと（デバッグログで検証）。
**検証方法**: 手動 E2E（cmux セッション内で `cmux-team start`）。

---

### Step 10: ドキュメント更新

#### 10.1 `skills/cmux-team/SKILL.md`

新セクション「プロジェクト固有の追加指示（agent instructions overlay）」を追加:
- 目的と配置（`.team/agent-instructions/<role>.md`）
- 編集方法（CLI 4 コマンド）
- 適用タイミング（spawn-agent 時）
- 典型パターン例（命名規則を追加したい / テスト方針を追加したい）

#### 10.2 `CLAUDE.md`

- 「テンプレート変数仕様」節の Agent ロール固有変数表に `{{PROJECT_INSTRUCTIONS}}` の行を追加（使用テンプレート: 全 Agent ロール、説明: `.team/agent-instructions/<role>.md` の内容に展開される overlay）
- 「リポジトリ構造」セクションに `.team/agent-instructions/` を追加
- ファイル構造セクション（.team/ ディレクトリ一覧）に `agent-instructions/` 行追加

#### 10.3 `docs/spec/01-skill-cmux-team.md`

overlay 機構の仕様を追加（スキル仕様の一部）。

#### 10.4 `docs/spec/03-commands.md`

4 CLI コマンド（get/set/delete/list-agent-instructions）の仕様を追加。引数・挙動・exit code。

#### 10.5 `docs/spec/04-templates.md`

- `{{PROJECT_INSTRUCTIONS}}` プレースホルダの仕様を追加
- 「spawn-agent 時に展開される」「overlay 不在時は空文字」を明記
- `AgentRole` enum のエイリアス（impl → implementer 等）を記載

#### 10.6 `README.md` / `README.ja.md`

「プロジェクト固有の追加指示」セクションを追加（ユーザー向け簡潔説明 + 使用例コマンド）。

**完了条件**: 上記 6 ファイルに変更が入り、互いに矛盾しない。

---

### Step 11: `.team/.gitignore` 確認（m6）

**対象**: `.team/.gitignore`（変更しない）

**確認済**（2.5 節参照）: `.team/.gitignore` に `agent-instructions/` を除外するルールは無く、`*/` のような包括 glob も無い。したがって overlay ファイルは新規作成時点で git の untracked として表示される。**変更不要**で閉じる。

**完了条件**: `git status` で overlay ファイル作成後に untracked として表示される（手動確認）。

---

## 5. リスク・注意点

### R1. Conductor heredoc での `{{PROJECT_INSTRUCTIONS}}` 残存

**内容**: Conductor が heredoc で最終プロンプトを手組みする際、`{{PROJECT_INSTRUCTIONS}}` を書き忘れると overlay が効かない。
**緩和**:
- Step 8 で conductor-role.md / conductor.md の「Agent 起動手順」冒頭に全ロール共通の注意書きを追加し、heredoc サンプルにも placeholder を含める
- Step 6 で `cmdSpawnAgent` が placeholder 欠落を warn ログ（`project_instructions_missing_placeholder`）で記録するため、Inspector がログ監査で検出可能
- SKILL.md / docs/spec に overlay を効かせる前提として「heredoc にプレースホルダを残す」ことを明示する
**残存リスク**: 既存の Conductor プロンプト（稼働中セッション）には反映されない。新規 spawn 以降のみ適用される（起動スナップショット方式の当然の帰結）。

### R2. `.team/prompts/*.expanded.md` の肥大化

**内容**: spawn-agent 毎に expanded ファイルが増える。
**緩和**: ファイル名は `<basename>.expanded.md` で一意。**現行の basename は `${AGENT_ID}-${role}-${timestamp}` のように timestamp を含むため、同 Conductor が連続 spawn しても衝突しない**（m1）。再 spawn で同名ファイルが発生するケースは現状無い。`.team/prompts/` は元から監査証跡として残存する設計で、専用の GC は作らない（設計原則「シンプルさを優先」に従い best-effort）。
**残存リスク**: 長期運用で容量が増える可能性。必要になった時点で GC を追加する（別タスク起票）。

### R3. overlay の誤編集でプロンプトが壊れる

**内容**: overlay に `## ` の誤った見出しレベル、長すぎる本文などを書くと Agent が混乱する可能性。
**緩和**: D2 の 100KB サイズ上限。D3 の変数記法禁止。Settings タブの read-only プレビューで事前確認可能。
**残存リスク**: overlay の semantic content は検証しない（できない）。ユーザー責任。

### R4. 100KB 制限の過大 / 過小

**内容**: 100KB は恣意的。
**緩和**: 100KB は Markdown 本文としては十分に大きく（通常の spec 文書の数倍）、context 消費 ~25K token 程度。過小の懸念は小さい。過大 (> 500KB) で context を圧迫する心配もない。
**残存リスク**: 将来的にモデルの context サイズが変化すれば見直し。

### R5. role エイリアス追加による混乱

**内容**: `impl` → `implementer`、`reviewer` → `design-reviewer` のマッピングを追加すると、将来別のロールを新設する時に衝突リスク。
**緩和**: D10 のエイリアスは既存テンプレートで現に使われているもの（`conductor-role.md` L142 の `--role impl`）に限る。新規エイリアスは追加しない。
**残存リスク**: 無視できる。

### R6. dashboard.tsx への改変範囲が広い

**内容**: タブ追加 + キーバインド + focusedArea + footer の連動箇所が多い。
**緩和**: Step 9 を 9.1〜9.7 に細分化。既存の journal/artifacts/log との並行パターンを踏襲する（差分は限定的）。D17 の refresh 戦略で非 Settings 表示時の負荷を抑える。
**残存リスク**: コピペ漏れ。Inspector の検証で grep ベースチェックを行う。

### R7. `config.ts` 抽出に伴うリグレッション

**内容**: `loadConfig` / `TeamConfig` / `resolveLayout` / `resolveAutoUpdateMode` を `config.ts` に移動する際、`main.ts` 内の呼び出し箇所（L1709, L1737, L1828, L1887, L2038 等）や既存の export 利用箇所を漏れなく差し替える必要がある。
**緩和**: Step 4 完了時点で `bunx tsc --noEmit` と既存 test（`main.test.ts` / `daemon.test.ts`）が両方 pass することを完了条件にする。`grep -nE "interface TeamConfig|async function loadConfig" skills/cmux-team/manager/main.ts` が 0 件であることも検証。
**残存リスク**: 小。test 網羅性に依存。

### R8. Settings タブ初回レンダリング時の race

**内容**: `loadSettingsItems` は非同期で、Settings タブ初表示の 1 フレーム目は `state.settingsItems` が空配列の可能性。
**緩和**: 初回描画で「Loading...」プレースホルダを出す、または `switchTab("settings")` で `loadSettingsItems` を await してから state 反映する。D17 でタブ切替時に 1 回 trigger する方針のため、実装では後者を採る。
**残存リスク**: 小。

---

## 6. 既存型エラーの先読み

### 6.1 touched files 一覧

本タスクで触る予定の `.ts` / `.tsx` ファイル:

- `skills/cmux-team/manager/schema.ts`
- `skills/cmux-team/manager/config.ts` **（新規・C2/m7）**
- `skills/cmux-team/manager/agent-instructions.ts` **（新規）**
- `skills/cmux-team/manager/agent-instructions.test.ts` **（新規）**
- `skills/cmux-team/manager/template.ts`
- `skills/cmux-team/manager/main.ts`（`loadConfig` 抽出に伴う import 差し替えを含む）
- `skills/cmux-team/manager/dashboard.tsx`
- `skills/cmux-team/manager/i18n.ts`（`project_instructions_heading` 見出し + 4 help キー追加）

### 6.2 事前 tsc ベースライン（Recommendation 8）

Planner 実行時点（2026-04-18）の `bunx tsc --noEmit` 結果:

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-247-1776448074/skills/cmux-team/manager
bunx tsc --noEmit 2>&1 | wc -l
# → 0 行（型エラー 0 件・クリーン）
```

**ベースライン: 0 件**。Implementer は着手後も下記コマンドで touched files の型エラーを 0 件に保つこと。

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-247-1776448074/skills/cmux-team/manager
bunx tsc --noEmit 2>&1 | grep -E "^(schema|config|agent-instructions|template|main|dashboard|i18n)\.(ts|tsx)"
# → 0 行で pass
```

### 6.3 新規追加と無関係の既存エラーが発生した場合

現状ベースラインが 0 件のため、本タスク実装中に発生する型エラーは全て本タスクの変更に起因すると見なせる。Implementer は発生した型エラーを本タスク内で解消すること。

万一、本タスク変更と無関係の既存エラーが別経路で混入した場合は、`cmux-team create-task --title "cleanup: T247 で発見した既存型エラー修正" --depends-on T247 ...` で起票し、impl-report に記載する。

---

## 7. 検証計画

全検証観点の対応:

| 検証観点 | 検証方法 | 担当 |
|---------|---------|------|
| 8 ロール全てのテンプレート(ja/en)に `{{PROJECT_INSTRUCTIONS}}` が含まれる | Step 7 末尾の shell loop が 0 行出力 | Inspector |
| overlay ファイルがある場合、生成されるプロンプトに内容が展開される | 手動 E2E: `.team/agent-instructions/implementer.md` に "TEST_MARKER_xyz" 書込 → Implementer agent を spawn → `.team/prompts/*.expanded.md` に "TEST_MARKER_xyz" が含まれる | Implementer + Inspector |
| overlay なし時、プロンプトに余分な空行や `{{...}}` 残骸が残らない | `agent-instructions.test.ts` で `formatProjectInstructionsBlock(null, locale)` === "" を検証、かつ `expandProjectInstructions` で `{{PROJECT_INSTRUCTIONS}}` を含む行単位で置換後、連続空行 3 つ以上（`/\n\n\n+/`）が 0 マッチになることを assertion | Implementer |
| CLI `get/set/delete/list` の round-trip が正しい | `agent-instructions.test.ts` + shell での E2E:<br>`set --body x; get` の出力が `x\n`、`delete; list` で `implementer ✗` | Implementer + Inspector |
| CLI が未知 role 名を拒否する | `set-agent-instructions --role foobar --body x` が exit 1 かつ stderr にエラー | Implementer |
| TUI Settings タブでロール一覧と overlay 内容が表示される | 手動: `cmux-team start` → `S` キー → 8 ロール + config 3 項目の表示 | Inspector (手動) |
| Settings タブから編集できない（read-only） | 手動: キー入力で編集不可。footer に "edit: cmux-team set-agent-instructions" が表示 | Inspector (手動) |
| `.team/agent-instructions/` が git 管理対象 | `git status` で overlay 作成後に untracked or staged として表示 | Implementer |
| CLI 出力（list）のフォーマットが人間可読 | 手動目視 + Decision Log D13 の例と一致 | Inspector |
| placeholder 欠落時の warn ログが出る（M2） | prompt-file に `{{PROJECT_INSTRUCTIONS}}` を**含めず** AgentRole enum の role で spawn-agent 実行 → `project_instructions_missing_placeholder` ログが `.team/logs/manager.log` に記録される | Inspector |
| locale 別見出しが正しく出る（M1） | `CMUX_TEAM_LANG=ja` で block に `## プロジェクト固有の追加指示` / `CMUX_TEAM_LANG=en` で `## Project-Specific Instructions` が出ることを test で確認 | Implementer |

### 7.1 自動テスト（`agent-instructions.test.ts`）

最低限カバーする項目:
1. `formatProjectInstructionsBlock(null, "ja")` === `""`
2. `formatProjectInstructionsBlock("", "en")` === `""`
3. `formatProjectInstructionsBlock("foo", "ja")` が `"## プロジェクト固有の追加指示"` を含む
4. `formatProjectInstructionsBlock("foo", "en")` が `"## Project-Specific Instructions"` を含む（M1）
5. `writeProjectInstructions` → `readProjectInstructions` の round-trip
6. `writeProjectInstructions` が 100KB+ でエラー
7. `deleteProjectInstructions` の no-op（存在しないファイル）
8. `listProjectInstructions` が `AGENT_ROLES` 全件を返す
9. `normalizeAgentRole("impl")` === `"implementer"`
10. `normalizeAgentRole("foobar")` === undefined
11. `expandProjectInstructions` が overlay 不在時に mode=`"empty"` で placeholder を除去し、**expanded プロンプト内で `/\n\n\n+/` がマッチ 0 件であることを assert**（m2 / Recommendation 6）
12. `expandProjectInstructions` が overlay あり時に mode=`"applied"` でブロック書式で置換する
13. `expandProjectInstructions` が `{{PROJECT_INSTRUCTIONS}}` を含まない入力を mode=`"noop"` でそのまま返す
14. `expandProjectInstructions` が未知 role に対し mode=`"unknown-role"` で placeholder を空文字化する

### 7.2 手動 E2E シナリオ

以下の 1 シナリオを Inspector が実施:

1. `cmux-team set-agent-instructions --role implementer --body "DO NOT USE semicolons; use commas. TEST_MARKER_247"`
2. `cmux-team list-agent-instructions` で `implementer ✓ N bytes` を確認
3. `cmux-team get-agent-instructions --role implementer` で中身確認
4. ダッシュボードで `S` キー → Settings タブで implementer ✓ を選択 → 右カラムに内容表示
5. 任意の実装タスクを ready にして Conductor に渡す → Implementer Agent spawn 後、`.team/prompts/<agent-id>.expanded.md` に `TEST_MARKER_247` が含まれることを確認
6. `.team/logs/manager.log` に `project_instructions_applied` ログが出ていることを確認
7. `cmux-team delete-agent-instructions --role implementer` → list で `✗`
8. 再度 Implementer spawn → expanded プロンプトに "## プロジェクト固有の追加指示" セクションが無いこと / 連続空行 3 つ以上が無いことを確認
9. locale 切替確認: `CMUX_TEAM_LANG=en cmux-team spawn-agent ...` で overlay ありの場合、expanded プロンプトの見出しが英語 `"## Project-Specific Instructions"` になることを確認
10. M2 placeholder 欠落確認: `{{PROJECT_INSTRUCTIONS}}` を含まない prompt-file で `cmux-team spawn-agent --role implementer --prompt-file ...` を実行 → `project_instructions_missing_placeholder` warn ログが出ることを確認

### 7.3 TypeScript 型チェック

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-247-1776448074/skills/cmux-team/manager
bunx tsc --noEmit 2>&1 | grep -E "^(schema|config|agent-instructions|template|main|dashboard|i18n)\.(ts|tsx)"
```

touched files に対する出力が 0 行で pass（ベースラインが 0 件なので保つだけ）。

---

## 8. サブタスク分割

実装順序（依存関係に基づく番号順）:

1. **実装**: `schema.ts` に `AgentRole` enum 追加（Step 1）
   - 対象: `skills/cmux-team/manager/schema.ts`
   - 完了条件: `AgentRole`, `AGENT_ROLES`, `normalizeAgentRole` が export される
   - 検証コマンド: `grep -c "export const AgentRole" skills/cmux-team/manager/schema.ts` = 1
2. **実装**: `config.ts` 新規作成と `loadConfig` / `TeamConfig` / `resolveLayout` / `resolveAutoUpdateMode` の抽出（Step 4 / C2）
   - 対象: `skills/cmux-team/manager/config.ts`（新規）, `skills/cmux-team/manager/main.ts`（import 差し替え）
   - 完了条件: `main.ts` に `interface TeamConfig` / `async function loadConfig` が残っていない（grep で 0 件）、既存 test pass
3. **実装**: `agent-instructions.ts` を新規作成（Step 2）
   - 対象: `skills/cmux-team/manager/agent-instructions.ts`
   - 完了条件: 6 つの API を全て export（`formatProjectInstructionsBlock` は locale 引数付き）
   - メソッド制約: `AGENT_ROLES` を schema.ts から import、`locale` 型を i18n.ts から import、`project_instructions_heading` 見出しを i18n.ts から解決
4. **実装**: `i18n.ts` に `project_instructions_heading` / 4 help キーを追加（Step 5.6 / M1）
   - 対象: `skills/cmux-team/manager/i18n.ts`
   - 完了条件: en / ja 双方のキーが存在
5. **テスト**: `agent-instructions.test.ts` 新規作成（Step 2.TEST）
   - 対象: `skills/cmux-team/manager/agent-instructions.test.ts`
   - 完了条件: 14 ケース以上の test pass
6. **実装**: `template.ts` に `expandProjectInstructions` 追加（Step 3 / C1）
   - 対象: `skills/cmux-team/manager/template.ts`
   - 完了条件: export され、mode 4 種（noop / applied / empty / unknown-role）を返し、連続空行発生なし
7. **実装**: `main.ts` に 4 CLI コマンド + switch 分岐追加（Step 5）
   - 対象: `skills/cmux-team/manager/main.ts`
   - 完了条件: 4 コマンドが --help 含めて動作
8. **実装**: `cmdSpawnAgent` の prompt-file 展開ロジック追加（Step 6 / C1 / M2 / M4）
   - 対象: `skills/cmux-team/manager/main.ts`
   - 完了条件: `{{PROJECT_INSTRUCTIONS}}` 含有時に expanded ファイル生成、欠落時に warn ログ、読み取り失敗時に fallback
   - メソッド制約: `expandProjectInstructions` を呼ぶだけにする（インライン展開禁止）、try/catch で保護
9. **配線**: 8 ロール × 2 言語 = 16 テンプレートに `{{PROJECT_INSTRUCTIONS}}` 挿入（Step 7）
   - 対象: `skills/cmux-team/templates/{ja,en}/{researcher,architect,planner,design-reviewer,implementer,inspector,dockeeper,task-manager}.md`
   - 完了条件: Step 7 末尾の shell loop が 0 行出力
10. **配線**: Conductor テンプレート（conductor-role.md, conductor.md, ja/en 計 4 ファイル）の「Agent 起動手順」冒頭に全ロール共通注意書き + heredoc サンプル更新 + 新セクション追加（Step 8 / M2）
    - 対象: `skills/cmux-team/templates/{ja,en}/{conductor-role,conductor}.md`
    - 完了条件: 4 ファイル全てに注意書き + 「プロジェクト固有の追加指示（overlay）」セクションが存在
11. **実装**: `dashboard.tsx` に Settings タブ追加（Step 9 / D17 refresh 戦略）
    - 対象: `skills/cmux-team/manager/dashboard.tsx`
    - 完了条件: `S`/`4` で Settings タブに切替可能、非 Settings 時に `loadSettingsItems` が呼ばれない
    - メソッド制約: 既存の `switchTab`, `FOCUSED_AREA_FOR_TAB`, `openArtifactInViewer` を流用、`loadConfig` は `config.ts` から import
12. **配線**: `skills/cmux-team/SKILL.md` に overlay 使用方法を追記（Step 10.1）
13. **配線**: `CLAUDE.md` にテンプレート変数と構造を追記（Step 10.2）
14. **配線**: `docs/spec/01-skill-cmux-team.md`, `03-commands.md`, `04-templates.md` に追記（Step 10.3-10.5）
15. **配線**: `README.md`, `README.ja.md` に overlay セクション追加（Step 10.6）
16. **検証**: `.team/.gitignore` 現状確認（Step 11、変更不要を確定）

### 並列実装禁止ポリシー

- 本タスクは既存機能の追加（拡張）で、旧実装を置き換えるものではないため **削除タスクは不要**
- サブタスク 1 は最初。2（config 抽出）と 4（i18n）は 1 と独立で並列可
- 3（agent-instructions.ts）は 1 + 4 完了後
- 5（test）は 3 完了後
- 6（expandProjectInstructions）は 3 完了後（3 の API を呼ぶため）
- 7（CLI コマンド）は 3 + 4 完了後、2（config 抽出）の completion を待つ必要は無い
- 8（cmdSpawnAgent）は 6 + 7 完了後
- 9, 10 は 8 完了後に並列可
- 11（dashboard）は 2 + 3 + 4 完了後
- 12-15 は他と独立で並列可
- 16 は最後

---

## 9. 作業ルール遵守

- 計画時点でコード実装はしない（plan.md のみ出力）
- 変更は十分に既存コード（`template.ts` / `main.ts` / `dashboard.tsx` / `schema.ts` / `i18n.ts` / 16 テンプレート）を読んで決定した
- 根本対策: Conductor heredoc の複雑さを避け、spawn-agent CLI に展開ロジックを集約。ロジック重複（Step 3 と Step 5）は C1 の指摘に従い単一正準関数 `expandProjectInstructions` に集約（SSOT）
- 「変更範囲が広い」（16 テンプレート + dashboard.tsx 大幅改修 + config.ts 抽出）を理由に妥協しない
- 既存の TUI タブ構造・CLI コマンドパターン・i18n 方式を踏襲（一貫性）
- locale 対応（M1）により、英語 / 日本語どちらの locale でも overlay 見出しが自然に出る
