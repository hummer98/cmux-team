# T321 実装計画 — `project_tags` resolver

## ゴール

`cmux-team spawn-agent` 経路で `selectToken(tokDb, surface)` の第 3 引数 `projectTags` を解決済み配列で渡し、tags フィルタを実機能化する。`selectToken` 本体・env 注入・`AGENT_TOKEN_BOUND` 通知・`isTokenPoolEnabled` ガードは既に実装済みなので **触らない**。

---

## 1. 設計判断

### 1.1 resolver を配置するファイル — **新規 `skills/cmux-team/manager/project-tags.ts`**

| 候補 | 評価 |
|---|---|
| **新規 `project-tags.ts`**（採用） | 関心の分離が明確。git remote 解析 + config 読み + ロギングという複合関心を `token-store.ts`（SQLite + Keychain）/ `config.ts`（純粋な JSON/YAML 読み）に混ぜない。test ファイルも対称に配置できる |
| `token-store.ts` 同居 | token-store は単一ファイルで完結する設計（artifact A019 の方針）。git exec 依存と Keychain 依存が混じると test も重くなる。却下 |
| `config.ts` 同居 | config.ts は純粋に JSON/YAML 読みのみで `child_process` を import していない。git exec を持ち込むと責務が広がる。却下 |

`project-tags.ts` の export:

```typescript
export const FALLBACK_TAGS: readonly string[] = ["any"];

/** 純粋関数 — 単体テストの主ターゲット */
export function parseRemoteOriginToTags(url: string): string[];

/** projectRoot 経由の総合解決（CLI から呼ぶ entry point） */
export async function resolveProjectTags(projectRoot: string): Promise<string[]>;
```

### 1.2 git remote 取得実装 — **`promisify(execFile)` + 2000ms timeout**

- `execFile("git", ["remote", "get-url", "origin"], { cwd, timeout: 2000 })` を `promisify` で await
- 既存の `gh-cache-repo.ts:resolveOriginRepo` と同じパターンで踏襲する
- エラー時（非 git / origin 未設定 / timeout / git 未インストール）は **catch して空文字を返す内部ヘルパ** にし、上位は常に空文字 → fallback 判定で簡潔に
- spawnSync は不採用: cmdSpawnAgent は既に async コンテキストなので blocking する理由がない

### 1.3 host 判定ルール（task.md と A019 の解釈）

入力 url を `parseRemoteOriginToTags(url)` に通し、以下のロジックで配列を決定する:

| host (lowercase) | 出力 tags |
|---|---|
| `github.com` / `www.github.com` | `["any"]` （public GitHub はタグなし扱い） |
| `gitlab.com` / `bitbucket.org` 等の有名 OSS host | `["any"]` |
| `github.kddi.com` | `["org:kddi"]` （host の最初のラベルを `org:` prefix） |
| `github.acme.com` | `["org:acme"]` |
| `git.internal.example.com` | `["org:git"]`（最初のラベル採用、規約通り） |
| 解析不能 / remote 取得失敗 | `["any"]` |

最初のラベル抽出: `host.split(".")[0]`。`github` 単独 host（ありえないがガード）はそれをそのまま使うのではなく、上の特例で `github.com` 完全一致にしか hit しないように先に弾く。

URL 形式は既存 `gh-cache-repo.ts:parseRemoteUrl` の正規表現セット（SSH `git@host:o/r.git` / HTTPS `https://host/o/r(.git)` / `ssh://`・`git://` 形式）を **再利用しない** — gh-cache 側は `host` を `api.github.com` / `host/api/v3` 形式に正規化してしまうため。`project-tags.ts` 側で raw host を返す独自パーサを置く（regex 自体は同型でコピー）。

### 1.4 `resolveProjectTags(projectRoot)` 実装方針

```typescript
async function resolveProjectTags(projectRoot: string): Promise<string[]> {
  // 1. .team/config.json の project_tags 明示優先
  try {
    const cfg = JSON.parse(await readFile(join(projectRoot, ".team/config.json"), "utf-8"));
    if (Array.isArray(cfg.project_tags) && cfg.project_tags.every(t => typeof t === "string") && cfg.project_tags.length > 0) {
      return cfg.project_tags;
    }
  } catch (e) {
    // ENOENT は無視 / JSON parse 失敗は warning ログ後に fallback
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`project_tags_config_parse_failed: ${(e as Error).message}`);
    }
  }

  // 2. git remote origin から推定
  try {
    const url = await readGitOriginUrl(projectRoot);  // 内部 helper, 失敗時 "" を返す
    if (url) return parseRemoteOriginToTags(url);
  } catch { /* fallback */ }

  // 3. fail-safe
  return [...FALLBACK_TAGS];
}
```

ログ: `console.error` ではなく logger.ts 経由を使うべきか?
→ resolver は CLI プロセス（spawn-agent）でも将来 daemon 経路でも使われ得るため、ここは `console.error` のままにし、main.ts の caller 側で `await log("project_tags_resolve_failed", ...)` を出す方針。resolver 自身は **副作用のないログ stub** にしておく。

### 1.5 `main.ts:2683` 周辺の修正

`cmdSpawnAgent` は `async function cmdSpawnAgent(): Promise<void>` (line 2483) のため `await` 追加は問題なし。

```diff
   } else {
     // T321: token pool からトークンを選択して CLAUDE_CODE_OAUTH_TOKEN を注入
     try {
       const tokDb = initTokenDB();
-      const selected = selectToken(tokDb, surface);
+      let projectTags: string[];
+      try {
+        projectTags = await resolveProjectTags(PROJECT_ROOT);
+      } catch (e: any) {
+        await log("project_tags_resolve_failed", `${formatSurface(surface, "A")} err=${e?.message ?? e}`);
+        projectTags = ["any"];
+      }
+      const selected = selectToken(tokDb, surface, projectTags);
       if (selected) {
```

- `import { resolveProjectTags } from "./project-tags";` を main.ts 冒頭の import 群に追加
- 既存 catch ブロック（`token_pool_fallback` ログ）はそのまま温存
- resolver 内部でも `["any"]` を返すので **二重防護**: resolver は throw しない実装にしつつ、caller 側でも `try/catch` でガードする

### 1.6 main.ts 内の他 `selectToken` caller 確認

`grep -n selectToken skills/cmux-team/manager/*.ts` の結果:
- `main.ts:120` — import only
- `main.ts:2683` — 唯一の呼出箇所（spawn-agent）
- `daemon.ts:1480` — コメント内言及のみ（`AGENT_TOKEN_BOUND` のコメント）
- `schema.ts:54, 227` — コメント内言及のみ
- `schema.test.ts:81` — コメント内言及のみ
- `token-store.ts:710` — 定義箇所

**結論**: 修正対象は `main.ts:2683` の 1 箇所のみ。シグネチャ変更不要。

### 1.7 test ファイルの配置と命名

新規 `skills/cmux-team/manager/project-tags.test.ts`。

`bun test` の単体ターゲットとして個別実行可能。token-store.test.ts には混ぜない（責務分離。token-store.ts は git/config 非依存を保つ）。

---

## 2. 実装ステップ（TDD: write tests first → implement → green）

### Step 1: `parseRemoteOriginToTags` の単体テストを書く（red）

`project-tags.test.ts` に純粋関数テストを記述（実装はまだ無いので red）:

| input url | expected |
|---|---|
| `"git@github.com:foo/bar.git"` | `["any"]` |
| `"https://github.com/foo/bar"` | `["any"]` |
| `"https://github.com/foo/bar.git"` | `["any"]` |
| `"git@github.kddi.com:foo/bar.git"` | `["org:kddi"]` |
| `"https://github.kddi.com/foo/bar"` | `["org:kddi"]` |
| `"git@github.acme.com:foo/bar.git"` | `["org:acme"]` |
| `"https://gitlab.com/foo/bar"` | `["any"]` |
| `"https://bitbucket.org/foo/bar"` | `["any"]` |
| `"ssh://git@github.kddi.com:22/foo/bar.git"` | `["org:kddi"]` |
| `""` | `["any"]` |
| `"not-a-url"` | `["any"]` |

### Step 2: `parseRemoteOriginToTags` を実装（green）

regex セットは `gh-cache-repo.ts` から流用しつつ raw host を保持する派生実装。

### Step 3: `resolveProjectTags` の integration テストを書く（red）

mkdtemp で temp project root を作って:

| シナリオ | 準備 | expected |
|---|---|---|
| `.team/config.json` に `project_tags: ["org:foo"]` | config.json を書く（git remote 不要） | `["org:foo"]` |
| `.team/config.json` に `project_tags: []`（空） | 空配列は無視 → 次段階へ | git remote 経由 or `["any"]` |
| `.team/config.json` が JSON parse 失敗 | `{` のみ書く | `["any"]`（warning が console.error に出る／expect は値のみ確認） |
| `.team/config.json` なし & git remote 取得失敗 | `git init` 無し（普通の temp dir） | `["any"]` |
| `.team/config.json` に `project_tags: "not-array"` | 不正型 → 無視 | `["any"]` |

git remote の動的セットアップは fragile（git が無い CI/環境で fail）なので **`resolveProjectTags` の git fallback 経路は integration では deep test しない**。git ロジックは Step 1 の純粋関数テストで網羅する戦略。

### Step 4: `resolveProjectTags` を実装（green）

config.json 読み + parseRemoteOriginToTags + readGitOriginUrl の組合せ。`readGitOriginUrl` は内部 (export しない) helper として `promisify(execFile)` で呼ぶ。timeout 2000ms。

### Step 5: `main.ts:2683` 周辺を修正

import 追加 + try/catch + `selectToken(tokDb, surface, projectTags)` に変更。`project_tags_resolve_failed` ログを caller 側で出す。

### Step 6: タイプチェック + 単体テスト緑化

```bash
bun test skills/cmux-team/manager/project-tags.test.ts
bun test skills/cmux-team/manager/token-store.test.ts   # 既存の 69 ケース回帰確認
bunx tsc --noEmit
```

### Step 7: spawn-agent E2E 統合テストの取り扱い（task.md §3）

task.md は「`cmdSpawnAgent` を呼んで `exportVars` を検証」と書いているが、現実の `cmdSpawnAgent`:
- `process.exit(...)` を多数の経路で呼ぶ
- `cmux.send()` 副作用、`postMessage()` 副作用、PROJECT_ROOT グローバル依存
- direnv check / preflight / throttle guard 等を経由

そのままの形で test するには大規模な refactor（`exportVars` の build を export 関数に切り出す等）が必要で、本タスクのスコープを超える。

**判断**: §3 の E2E は **「Step 5 までで成立する単体テスト + 既存 token-store.test.ts の selectToken 回帰」で代替** とし、フルの cmdSpawnAgent E2E は別タスク（後続）に切り出す提案を完了報告に含める。

代替で追加するテスト（`project-tags.test.ts` に同居 or 別ファイル）:
- `selectToken(db, holder, ["org:kddi"])` で `tags=["any"]` token と `tags=["org:kddi"]` token がそれぞれ候補に含まれることを確認（**既に token-store.test.ts でカバー済みの可能性が高い** → 既存 test を grep して有無を確認、無ければ追加）

---

## 3. 検証コマンド

```bash
# 単体テスト（個別ファイル指定で速い）
bun test skills/cmux-team/manager/project-tags.test.ts

# 既存テストの回帰確認（selectToken のシグネチャ・挙動）
bun test skills/cmux-team/manager/token-store.test.ts
bun test skills/cmux-team/manager/main.test.ts

# 型チェック全体
bunx tsc --noEmit

# 任意: spawn-agent CLI を手動で叩いて token_pool_assigned ログを確認
# （token pool が enabled で tokens.db に登録済みアカウントがある場合のみ）
cmux-team status
tail -f .team/logs/manager.log
```

bun test 全体実行は T327 で調査中の hang 問題があるため避ける（CLAUDE.md / 既知の注意点に従う）。

---

## 4. 想定リスク・スコープ外

### スコープ外（明示的にやらない）

- **既存 `selectToken` シグネチャの変更** — task.md に「絶対変えない」と明記。default 値 `projectTags = ["any"]` も維持
- **`cmdSpawnAgent` フル E2E テスト** — Step 7 の理由でスコープ外。後続タスクに分離
- **`AGENT_TOKEN_BOUND` ロジックの変更** — T323 で実装済、触らない
- **`isTokenPoolEnabled` のロジック変更** — T322 で実装済、触らない
- **`TeamConfig` の型に `project_tags` を追加** — `loadConfig` の戻り値 (TeamConfig) を経由せず、resolver 側で直接 `.team/config.json` を読む。理由: TeamConfig に増やすと spec 04-templates / docs/spec/05 にも反映が必要になり影響範囲が広がる。本タスク内ではローカル読みで完結させ、必要なら別タスクで TeamConfig に昇格させる

### リスク

| リスク | 影響 | 緩和策 |
|---|---|---|
| git 未インストール / non-git project root | resolver が遅延 or hang | execFile に 2000ms timeout、catch で `["any"]` fallback |
| `.team/config.json` の `project_tags` が想定外型（数値 / null） | 例外で spawn-agent が落ちる | 型ガード（Array.isArray + every string）。失敗時 fallback |
| caller 側で resolver が throw | spawn-agent が pool selection だけ失敗 | resolver 内部で throw しない実装 + caller 側でも try/catch |
| 既存 selectToken default 引数変更による sub-tle な挙動差 | 並行作業の他 caller（実際には 0 件）が影響 | grep 結果通り main.ts:2683 のみ。default 値は維持 |
| project-tags.ts の log 出力が test で console を汚す | テストノイズ | `console.error` のみ使用、テストは値ベースで assert（出力内容は assert しない） |
| host の最初ラベル抽出（`github.kddi.com` → `kddi`）の規約解釈ミス | 異なる tag が出る | task.md の表どおり `github.kddi.com` → `org:kddi`、それ以外（`github.acme.com`）→ `org:acme` を test で固定。task.md の「最初のラベル」は host ラベルが `github` で始まらない場合のみ適用 |

### task.md の「host の最初のラベル」解釈の確定

task.md §1 は次の通り:

> - host が github.com 系（".com" で終わるが github.com 完全一致）→ タグなし → ["any"]
> - host が github.kddi.com 系（社内）→ ["org:kddi"]
> - その他カスタム host (github.acme.com 等) → ["org:<host の最初のラベル>"]

`github.kddi.com` の例で `["org:kddi"]` が期待値 → 「最初のラベル」とは **`github.` を取り除いた次のラベル**ではなく、host を `.` で split した **2 番目のラベル**（`github` の次）を指す、と解釈する。`github.acme.com` → 2 番目のラベル `acme` → `["org:acme"]` で整合。

確定ルール:
- host を `.` で split した配列を `[a, b, c, ...]` とする
- `a === "github"` かつ `b === "com"`（つまり `github.com` ちょうど）→ `["any"]`
- `a === "github"` かつ host が `github.<x>.com` → `["org:<x>"]`
- それ以外 → `["org:<a>"]`（最初のラベル）

これを `parseRemoteOriginToTags` の test 表に固定する（Step 1 の表は確定済み）。

---

## 5. 完了条件チェックリスト

- [ ] `skills/cmux-team/manager/project-tags.ts` 新規追加、`resolveProjectTags` / `parseRemoteOriginToTags` を export
- [ ] `skills/cmux-team/manager/project-tags.test.ts` 新規追加、Step 1 / Step 3 の test ケースが pass
- [ ] `skills/cmux-team/manager/main.ts` の `selectToken(tokDb, surface)` 呼出を `selectToken(tokDb, surface, projectTags)` に変更、`resolveProjectTags` import を追加
- [ ] `bun test skills/cmux-team/manager/project-tags.test.ts` pass
- [ ] `bun test skills/cmux-team/manager/token-store.test.ts` pass（回帰確認）
- [ ] `bun test skills/cmux-team/manager/main.test.ts` pass（回帰確認）
- [ ] `bunx tsc --noEmit` clean
- [ ] cmdSpawnAgent E2E は別タスクとして提案する完了報告を残す（本タスクではスコープ外）
