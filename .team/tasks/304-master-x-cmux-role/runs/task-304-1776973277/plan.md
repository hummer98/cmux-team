# T304 実装計画: Master への `x-cmux-role` ヘッダー注入

## TL;DR

`generate{Master,Conductor,Agent}Settings` が生成する settings.json に
`env.ANTHROPIC_CUSTOM_HEADERS = "x-cmux-role: <role>"` を追加する。
Claude Code native 機能（`ANTHROPIC_CUSTOM_HEADERS` 環境変数 / settings.json `env` キー）
を使うため、proxy 側の変更は不要、T211 regression も踏まない。

---

## 1. 現状調査

### 1.1 proxy 側（`skills/cmux-team/manager/proxy.ts:350-352`）

```typescript
const taskId = req.headers.get("x-cmux-task-id") || opts?.taskId;
const conductorSurface = req.headers.get("x-cmux-conductor-id") || opts?.conductorSurface;
const role = req.headers.get("x-cmux-role") || opts?.role;
```

リクエストヘッダー優先 → proxy 起動時の `opts?.role` へフォールバックする。
`startProxy` 呼び出し側（`main.ts:615`）は `role` を渡していない:

```typescript
proxyHandle = await startProxy(PROJECT_ROOT, {
  getState: () => state,
  onMessage: async (msg) => { /* ... */ },
});
```

そのため **request header が付いていない限り `role` は `undefined` → trace JSONL では
`.role // "unknown"` で置換される**。

### 1.2 `x-cmux-role` ヘッダー注入箇所（grep 結果）

```
$ grep -rn "x-cmux-role\|ANTHROPIC_CUSTOM_HEADERS" skills/cmux-team/manager/*.ts
skills/cmux-team/manager/proxy.ts:352:      const role = req.headers.get("x-cmux-role") || opts?.role;
```

**読み取り側しか存在しない。** Master / Conductor / Agent いずれも
`x-cmux-role` を付ける側のコードが無い。

### 1.3 実 trace データ（`.team/logs/traces/api-trace.jsonl`）

```
$ jq -r '.role // "unknown"' /Users/yamamoto/git/cmux-team/.team/logs/traces/api-trace.jsonl | sort | uniq -c
  53748 unknown
```

**全リクエストが `unknown`。** タスク本文の前提
「Conductor / Agent は既に role を付与している」は事実と異なる — 三役とも欠落している。

### 1.4 Master だけが抜けている具体的な理由

正確には「Master だけ」ではなく **Master / Conductor / Agent 全員抜けている**。
proxy.ts は header 経路でしか per-request role を判別できない仕組みなのに、
settings.json / env / プロンプト layer のどこからも `x-cmux-role` が注入されていない。

ただし T304 のゴール（`jq -r '.role // "unknown"'` で `master` が現れる）を満たすには
Master の注入は必須。Conductor / Agent も同じ構造で抜けているため同時修正する判断を
「2. 実装方針」で示す。

### 1.5 settings.json / hook layer の現状

各ロールの settings 生成箇所:

| 関数 | 行 | 呼び出し元 | 備考 |
|------|----|----------|------|
| `generateMasterSettings` | main.ts:1746 | cmdLaunchMaster (2190) | `env` キー未設定 |
| `generateAgentSettings(projectRoot, surface)` | main.ts:1828 | cmdSpawnAgent (2361) | `env` キー未設定 |
| `generateConductorSettings` | main.ts:1891 | cmdConductor (2052) / 2138 | `env` キー未設定 |

いずれも `settings.hooks` しか書いておらず `settings.env` は未使用（grep
`'"env"\|env:' skills/cmux-team/manager/main.ts` で該当なし）。

Notification hook の `--role master|conductor|agent` 引数は cmux-team daemon への
内部通知用で、Anthropic API へのヘッダーとは無関係。

### 1.6 T211 regression 制約（`main.test.ts:1606-1613`）

```typescript
describe("T211 Phase 4: CMUX_ROLE 完全削除 regression", () => {
  test("main.ts 内に `CMUX_ROLE` 参照が残っていない", async () => {
    const mainPath = join(import.meta.dir, "main.ts");
    const src = await readFile(mainPath, "utf-8");
    expect(src).not.toContain("CMUX_ROLE");
  });
});
```

- `main.ts` に `CMUX_ROLE` 文字列が含まれてはならない（**substring 検査なので
  コメントも NG**）
- タスク本文の選択肢 (C)「`CMUX_ROLE=master` env 注入 → proxy で env→header 変換」は
  この regression に抵触するため **却下**

### 1.7 Claude Code native 機能: `ANTHROPIC_CUSTOM_HEADERS`

[公式 docs](https://code.claude.com/docs/en/env-vars) より:

- 形式: `Name: Value`
- 複数ヘッダー: **改行区切り (`\n`)**（カンマ区切りではない）
- `settings.json` の `env` キー経由で設定可能（`process.env` と同等）
- 優先順位: shell env > settings.json `env`

例:
```json
{
  "env": {
    "ANTHROPIC_CUSTOM_HEADERS": "x-cmux-role: master"
  }
}
```

Claude Code が Anthropic API に投げるリクエストにこの header を
そのまま付与するため、proxy はリクエスト着信時の header 読み取り
（既存ロジック proxy.ts:352）だけで role を拾える。

---

## 2. 実装方針

### 2.1 採用案 — 案 (A) 改: settings.json `env` 経由で `ANTHROPIC_CUSTOM_HEADERS` 注入

各 settings 生成関数に以下を追加する:

```typescript
const settings: Record<string, any> = {
  env: {
    ANTHROPIC_CUSTOM_HEADERS: `x-cmux-role: ${role}`,
  },
  hooks: { /* 既存 */ },
};
```

| 関数 | 付与する role 値 |
|------|----------------|
| `generateMasterSettings` | `master` |
| `generateConductorSettings` | `conductor` |
| `generateAgentSettings` | `agent` |

### 2.2 採用理由

1. **Claude Code native の正式機能** — 公式 env var `ANTHROPIC_CUSTOM_HEADERS` を使う。
   自前 middleware / proxy hack 不要。
2. **proxy 側を触らない** — proxy.ts:352 の既存ロジック（header 優先 → opts フォールバック）
   がそのまま動く。proxy テストの変更も不要。
3. **Master / Conductor / Agent で一貫** — 3 つの settings 生成関数に 1 行ずつ足すだけ。
   タスク本文「他の role とも統一的に扱える」基準を最も素直に満たす。
4. **T211 regression を踏まない** — 文字列 `CMUX_ROLE` を main.ts に一切書かない。
   使うのは `ANTHROPIC_CUSTOM_HEADERS` と `x-cmux-role`（ハイフン）のみ。
5. **Notification hook の `--role` と自然に並ぶ** — daemon 内部通知でも既に
   `--role master|conductor|agent` を使っており、API header 側でも同じ値を使うことで
   混乱が無い。
6. **settings.json に env を書くだけで shell env の汚染が無い** — Master は
   `process.env.ANTHROPIC_BASE_URL = ...` を直接書いているが、
   `ANTHROPIC_CUSTOM_HEADERS` は settings.json 側で閉じさせることで
   Master プロセス自身の env を汚さず、claude 子プロセスにのみ適用される。

### 2.3 却下案

| 案 | 却下理由 |
|----|---------|
| (B) proxy 側で surface UUID / PID から role 逆引き | proxy.ts のロジック肥大化。`.team/team.json` 依存で race / stale に弱い。`startProxy` 時点の `opts.role` では per-request 判別不能なので結局 IPC or 別 lookup が要り、net cost が高い |
| (C) `CMUX_ROLE=master` env 注入 + proxy で env→header 変換 | **T211 regression 違反**（main.ts に `CMUX_ROLE` 文字列が入る）。かつ proxy は HTTP server であり per-connection の client env を知る手段がない（socket metadata から辿れない） |
| (D) Master 起動コマンド引数で直接 header 指定 | Claude Code CLI に header を渡す専用フラグが存在しない。結局 env 経由になるため (A) と同値 |
| `process.env.ANTHROPIC_CUSTOM_HEADERS` を Master プロセス側で `process.env` に直接セット | 副作用: `cmdLaunchMaster` 内で `execFileSync("claude", ..., { env: process.env })` なので動くが、`process.env` を永続汚染するので settings.json 経由で囲う方が安全。また Agent は shell `export` 経由なので手法不統一になる |

### 2.4 T211 regression の遵守確認

- 追加する文字列: `ANTHROPIC_CUSTOM_HEADERS`, `x-cmux-role: master|conductor|agent`
- これらに `CMUX_ROLE` という substring は含まれない
- 既存テスト `main.test.ts:1609` の `expect(src).not.toContain("CMUX_ROLE")` に抵触しない
- **Implementer 注意**: コメントでも `CMUX_ROLE` と書かないこと（日本語で「ロール環境変数」等で代替）

---

## 3. 変更対象ファイル

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/main.ts` | `generateMasterSettings` / `generateConductorSettings` / `generateAgentSettings` の返す settings オブジェクトに `env.ANTHROPIC_CUSTOM_HEADERS = "x-cmux-role: <role>"` を追加 |
| `skills/cmux-team/manager/main.test.ts` | 3 ロール分の settings.json が `env.ANTHROPIC_CUSTOM_HEADERS` に期待値を持つことを assert する test を新規追加 |
| `CLAUDE.md`（任意） | 「トレーサビリティ（v3.4.0）」節に「Master / Conductor / Agent の settings.json が `ANTHROPIC_CUSTOM_HEADERS=x-cmux-role: <role>` を自動注入する」ことを 1-2 行追記。docs-sync で別タスク化しても良い |

変更行数見積もり: 実装 3 箇所 × 3-4 行 = 約 12 行、テスト 3 件 × 10-15 行 = 約 45 行。

---

## 4. TDD プラン

### 4.1 新規テスト（失敗 → 実装 → 成功の順で回す）

`skills/cmux-team/manager/main.test.ts` に以下 3 test を追加:

```typescript
// T304: x-cmux-role header injection via settings.env

describe("generateMasterSettings (T304: x-cmux-role)", () => {
  test("settings.env.ANTHROPIC_CUSTOM_HEADERS に x-cmux-role: master を注入する", async () => {
    const settingsPath = generateMasterSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(settings.env).toBeDefined();
    expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-cmux-role: master");
  });
});

describe("generateConductorSettings (T304: x-cmux-role)", () => {
  test("settings.env.ANTHROPIC_CUSTOM_HEADERS に x-cmux-role: conductor を注入する", async () => {
    const settingsPath = generateConductorSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(settings.env).toBeDefined();
    expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-cmux-role: conductor");
  });
});

describe("generateAgentSettings (T304: x-cmux-role)", () => {
  test("settings.env.ANTHROPIC_CUSTOM_HEADERS に x-cmux-role: agent を注入する", async () => {
    const settingsPath = generateAgentSettings(testDir, "surface:100");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(settings.env).toBeDefined();
    expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-cmux-role: agent");
  });
});
```

### 4.2 既存テストの regression 確認

以下は現行挙動を壊さないことを確認する。**test 追加ではなく既存 test が依然 pass すること**
を念押し:

| 既存 test | 確認ポイント |
|----------|------------|
| `main.test.ts:1608` T211 Phase 4 regression | `main.ts` に `CMUX_ROLE` 文字列が無い（追加する文字列は `ANTHROPIC_CUSTOM_HEADERS` と `x-cmux-role: <role>`） |
| `main.test.ts:1474-` generateMasterSettings 既存 test 一式 | hooks.UserPromptSubmit / Stop / SessionStart / SessionEnd / Notification が引き続き正しい構造を持つ |
| `main.test.ts:40-` generateConductorSettings PreToolUse hook 構成 | hooks.PreToolUse が引き続き存在する |
| `main.test.ts:1428` T266 Conductor Notification hook role=conductor | hooks.Notification の command が引き続き `--role conductor` を含む |
| `main.test.ts:1449` T266 Agent Notification hook role=agent | hooks.Notification の command が引き続き `--role agent` を含む |
| `main.test.ts:1515` Master settings 冪等性 | 複数回呼び出して上書きされるだけで parse error にならない（env キーを追加しても JSON としての valid 性は変わらない） |

実行コマンド:
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-304-1776973277
bun test skills/cmux-team/manager/main.test.ts
bunx tsc --noEmit
```

### 4.3 手動検証手順（タスク本文の検証方法に沿う）

```bash
# 1. worktree 内で build 確認
cd /Users/yamamoto/git/cmux-team/.worktrees/task-304-1776973277
bunx tsc --noEmit  # 型エラー 0 件
bun test skills/cmux-team/manager/main.test.ts  # 全 pass

# 2. 生成物の目視確認（3 ロール分）
bun skills/cmux-team/manager/main.ts generate-master-settings  # ← 本実装では生成関数の直接実行エントリは無い。代わりに test 実行後の testDir もしくは後述の cmux-team start 後の `.team/prompts/{master,conductor,agent-surface:XXX}-settings.json` を Read で確認する
# .team/prompts/master-settings.json
# .team/prompts/conductor-settings.json
# .team/prompts/<surface>-agent-settings.json
# いずれも env.ANTHROPIC_CUSTOM_HEADERS = "x-cmux-role: <role>" を持つ

# 3. E2E 検証（main リポジトリで実行、worktree 内では NG — Master を二重起動できない）
#   a. 本 feature branch を main にマージ or 手動 `bun install` + シンボリックリンク張替え等で
#      手元の cmux-team コマンドを先端に合わせる
#   b. cmux-team start で Master 起動
#   c. Master セッションで何か問いかけ（例: "hello"）
#   d. Conductor にも何かタスクを振る（例: 軽い create-task → draft のまま）
#   e. 記録確認:
jq -r '.role // "unknown"' /Users/yamamoto/git/cmux-team/.team/logs/traces/api-trace.jsonl \
  | sort | uniq -c
#   期待: master / conductor / (agent) のいずれかが 1 件以上現れる。unknown は新規記録では 0 件
```

手動検証は Implementer が feature branch で行った後、Inspector / ユーザー手元の E2E で
再確認する想定。

---

## 5. 影響範囲

### 5.1 破壊的変更の有無

**なし。**

- 既存の proxy.ts ロジック `req.headers.get("x-cmux-role") || opts?.role` は
  header が新設されても後方互換
- settings.json に `env` キーを追加することは Claude Code 側で既定サポートされており、
  既存の hooks / statusLine / 他のキーと独立
- 古い trace JSONL（role 未記録行）は既存の `.role // "unknown"` で引き続き unknown 扱い

### 5.2 npm install / build への影響

なし。依存追加なし、tsconfig 変更なし、postinstall 変更なし。

### 5.3 docs / spec への影響

- `CLAUDE.md` 「トレーサビリティ（v3.4.0）」節に 1 行追記推奨（optional、docs-sync で拾っても可）
- `docs/spec/01-skill-cmux-team.md` / `docs/spec/04-templates.md` も必要に応じて追記（別タスク化で良い）

### 5.4 Conductor / Agent の既存動作 regression 有無

**なし。**

- Conductor / Agent は現状 `role=unknown` として記録されている（1.3 実測）
- 本修正で `conductor` / `agent` に切り替わるのは改善方向の変更
- proxy 側の fallback `opts?.role` は `startProxy` 呼び出し（main.ts:615）で渡していないため
  `undefined` のまま。新 header が届けば header 値が勝ち、届かなければ `undefined` →
  `"unknown"` と従来挙動

---

## 6. リスクと緩和

| リスク | 影響 | 緩和 |
|-------|------|------|
| Claude Code の `ANTHROPIC_CUSTOM_HEADERS` 実装が特定バージョンで未サポート | header が付かず role=unknown のまま | 既存挙動と同じ結果に退化するだけで破壊的でない。最低要件バージョンを `package.json` / README に追記（optional） |
| settings.json の `env` が Claude Code の shell env に上書きされる | shell で `ANTHROPIC_CUSTOM_HEADERS` が別目的で定義されていた場合、そちらが勝つ | cmux-team の Master/Conductor/Agent spawn 経路で shell に同名 env を export していないことを grep で確認 済（`grep -rn "ANTHROPIC_CUSTOM" skills/ → 0 件`）。ユーザー側 shell profile で設定されていれば documented behaviour として許容 |
| header value に余計な空白や改行が入り Anthropic 側が 400 を返す | リクエスト全部 400 で cmux-team が動かなくなる | `x-cmux-role: master` のような最小値で 1 ヘッダーのみ。`\n` を含まない。proxy.test.ts で手動送信して 200 確認も可能 |
| 既存の Master / Conductor / Agent が書き換わることで hook 起動順序が変わる | 理論上は無し（`env` と `hooks` は独立キー） | 既存 test の regression 確認で担保（4.2） |

---

## 7. 作業手順（Implementer 向け）

1. **branch 確認** — 既に `task-304-1776973277/task` 上にいることを確認
2. **test first** — `main.test.ts` に 3 件の新規 test を追加し、`bun test` で **失敗** することを確認
3. **実装** — `main.ts` の `generateMasterSettings` / `generateConductorSettings` /
   `generateAgentSettings` それぞれで `settings` オブジェクト構築時に
   `env: { ANTHROPIC_CUSTOM_HEADERS: "x-cmux-role: <role>" }` を追加
4. **test green** — `bun test skills/cmux-team/manager/main.test.ts` 全 pass
5. **tsc** — `bunx tsc --noEmit` エラー 0 件
6. **T211 regression 再実行** — `main.test.ts:1608` が pass すること（全体 run で自動検証される）
7. **commit** — `feat(trace): inject x-cmux-role via settings.env.ANTHROPIC_CUSTOM_HEADERS (T304)` 程度
8. **納品** — main に rebase → merge ff-only → `cmux-team close-task --task-id 304
   --deliverable-kind merged --merged-into main --merge-sha <sha> --journal ...`

---

## 8. 参考

- `skills/cmux-team/manager/main.ts`
  - `generateMasterSettings`: L1746-1819
  - `generateAgentSettings`: L1828-1889
  - `generateConductorSettings`: L1891-1974
  - `cmdLaunchMaster` ANTHROPIC_BASE_URL 設定: L2184
  - `cmdSpawnAgent` ANTHROPIC_BASE_URL 設定: L2381
- `skills/cmux-team/manager/proxy.ts:350-352`（header 読み取りロジック）
- `skills/cmux-team/manager/main.test.ts:1606-1613`（T211 regression）
- Claude Code env vars: https://code.claude.com/docs/en/env-vars
