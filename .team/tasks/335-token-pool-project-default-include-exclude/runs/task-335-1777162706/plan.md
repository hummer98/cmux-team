# T335 plan: token pool 設定モデルの改訂（project default + include/exclude）

A019 §改訂検討事項（2026-04-26）の実装計画。tag 体系を ACL から hint に緩め、project 側に `default` / `include` / `exclude` を導入し、OSS は global で一括宣言する設計に移行する。

design-review.md の Major 3 件（M1〜M3）について Conductor が確定した判断を反映済み:

- **M1**: project default の auto-discover 連携は **runtime 昇格のみ・DB 不変**
- **M2**: OSS project では **`selectable=1` の全 token を候補化**（exclude のみ尊重）。`oss_pool_tags` は **廃止**
- **M3**: Keychain 不在時も **AGENT_TOKEN_BOUND を post**、env 注入のみスキップ

---

## 1. 現状分析

### 1.1 `selectToken()` 現行実装（`skills/cmux-team/manager/token-store.ts:710-771`）

```
入力: db / holder / projectTags=["any"] / nowIso
処理:
  1. expireLeases で期限切れ lease を掃除
  2. listTokens(selectableOnly: true) で selectable=1 の token を取得
  3. activeLeases SET を構築
  4. 各 token を以下でフィルタ:
      a. tagsMatch: token.tags が "any" を含む / projectTags が "any" を含む / 交集合あり
      b. lease 中は除外
      c. snapshot あれば stale (>30 分) 除外
      d. util_5h > 0.95 ブロッカー
  5. score = 0.3 * util_5h + 0.7 * util_7d で sort
  6. acquireLease（120 秒）
```

**改訂が必要な点**:
- 引数に project 側の `default` / `include` / `exclude` を受け取る経路がない
- OSS 判定（`isOss`）に応じて候補抽出ロジックを切り替える経路がない
- tagsMatch の優先順位が一切なく、include/exclude/default の概念が未実装

### 1.2 config schema（`skills/cmux-team/manager/config.ts`）

- `TeamConfig.tokenPool: { enabled?: boolean }` のみ（T322）
- `GlobalConfig.tokenPool: { enabled?: boolean }` のみ
- `loadConfig()` は `.team/config.json` を JSON.parse して返す（緩い型）
- `loadGlobalConfig()` は `~/.cmux-team/config.yaml` を yaml で読み、`token_pool.enabled` のみを camelCase 化
- `resolveTokenPoolEnabled()` / `isTokenPoolEnabled()` が opt-in 解決

**改訂が必要な点**:
- `TeamConfig.tokenPool` に `default: string` / `include: string[]` / `exclude: string[]` を追加
- `GlobalConfig.tokenPool` に `oss_default: string` / `primary_orgs: string[]` を追加（snake_case → camelCase 詰め替え）
  - **`oss_pool_tags` は廃止**（M2 確定）。OSS 判定後の候補抽出は selectToken 側のロジックで完結させる
- 取得用ヘルパ（`resolveProjectTokenPool` / `resolveGlobalTokenPool`）を新設し、`isTokenPoolEnabled` と同じ系統で `selectToken` 呼び出し側に渡す

### 1.3 `project-tags.ts` 現行実装

- `parseRemoteOriginToTags(url)` 純粋関数: host から `["any"]` か `["org:<name>"]` を返す
- `resolveProjectTags(projectRoot)`: `.team/config.json` の `project_tags` 明示 → git remote → fallback `["any"]`
- OSS 判定の概念は **未実装**（host が OSS host or `org:` 推定不能 → `["any"]` を返すのみ）

**改訂が必要な点**:
- `primary_orgs: string[]` を入力に取り、現行の `["any"]` / `["org:X]` 結果と組み合わせて `isOss: boolean` を出す関数 `resolveProjectContext(projectRoot, primaryOrgs)` を新設
  - 戻り値: `{ projectTags: string[]; isOss: boolean }`
- 既存 `resolveProjectTags` は wrapper として残す（後方互換）

### 1.4 `cmdSpawnAgent` 内の token 選択経路（`main.ts:2669-2720`）

```
1. isTokenPoolEnabled(PROJECT_ROOT) で 3 階層解決
2. 無効 → token_pool_skipped ログのみ
3. 有効:
   a. initTokenDB()
   b. resolveProjectTags(PROJECT_ROOT) → projectTags
   c. selectToken(tokDb, surface, projectTags)
   d. 成功 → retrieveTokenFromKeychain → CLAUDE_CODE_OAUTH_TOKEN 注入 + AGENT_TOKEN_BOUND post
   e. null → token_pool_fallback（reason=no_candidate）
```

**改訂が必要な点**:
- project 側の tokenPool（default / include / exclude）と global 側の OSS 設定を読む
- `isOss` 判定を組み込む
- `selectToken` 呼び出しに新しい引数（`SelectTokenPolicy`）を渡す
- Keychain にない handle が選ばれた場合（default の runtime 昇格 / OSS 候補から由来）は `CLAUDE_CODE_OAUTH_TOKEN` 注入をスキップし `token_pool_fallback`（reason=keychain_missing）を warn 出力。AGENT_TOKEN_BOUND は post（M3）

### 1.5 既存テスト体系（`token-store.test.ts`）

- bun:test 採用、`mkdtempSync` + `TOKEN_STORE_DB_PATH` で DB 隔離
- `KEYCHAIN_TEST_MODE=1` で Keychain も in-memory
- `selectToken (tags フィルタ)` describe（L1061-1149）に 6 ケース既存
- `seedFreshSnapshot(tokenId, util5h, util7d)` ヘルパで snapshot 注入

**改訂が必要な点**:
- Project A/C 検証シナリオを 3 ケース追加（独立 describe）
- 既存の 6 ケースは現行シグネチャの後方互換が崩れない範囲で維持

---

## 2. 実装計画（TDD ステップ）

### Step A: config schema 拡張（project + global）

**目的**: `selectToken` に渡す pool policy のデータ源を整える。

#### A-1. project 側

`config.ts` の `TeamConfig.tokenPool` を拡張:

```ts
tokenPool?: {
  enabled?: boolean;
  default?: string;       // handle 文字列（@xxxx）
  include?: string[];     // handle 配列
  exclude?: string[];     // handle 配列
};
```

`loadConfig` は緩い JSON.parse のままで良いが、参照側に「getter helper」を新設して dedupe / validate する:

```ts
export interface ProjectTokenPoolPolicy {
  default: string | null;
  include: string[];
  exclude: string[];
}

export function resolveProjectTokenPool(
  projectConfig: TeamConfig
): ProjectTokenPoolPolicy
```

> **m1 反映**: `enabled` フィールドは含めない（呼び側は別経路の `resolveTokenPoolEnabled` で解決する）。`ProjectTokenPoolPolicy` は **policy 整形のみ** を担当する。

仕様:
- `default` ∈ `exclude` → `console.warn` + `exclude` 側から該当 handle を除外（default 候補化を維持）
- `default` ∈ `include` → `include` 側から黙って除外（dedup, default 優先）
- 配列は `Array.isArray` で型ガード、文字列以外を含む要素は warn して捨てる
- **handle case sensitivity（m7 反映）**: `default` / `include` / `exclude` のいずれの handle も、A-Z（大文字）を含む場合は `console.warn` で `[token-pool] config_warning: handle 'XX' contains uppercase letters; tokens are matched as-is and likely won't match (handles are lowercase by convention)` を出すが、**自動 lowercase 化や reject はしない**。そのまま返してマッチ失敗扱いにする（DB 側の handle が小文字英数のみなので結果として候補化されない）

#### A-2. global 側

`GlobalConfig.tokenPool` を拡張:

```ts
tokenPool?: {
  enabled?: boolean;
  ossDefault?: string;        // OSS project の default fallback handle
  primaryOrgs?: string[];     // 自社 org 名配列（小文字英数）
};
```

> **M2 反映**: `oss_pool_tags` は **追加しない**。OSS 判定された project では「`selectable=1` の全 token を候補化（exclude のみ尊重）」というポリシーを selectToken 側で完結させるため、tag リストとして外出しする必要はなくなった。

`loadGlobalConfig` を拡張して yaml の `token_pool.oss_default` / `primary_orgs` を camelCase に詰め替える。型違反は warn + 無視。

公開ヘルパ:
```ts
export interface GlobalTokenPoolPolicy {
  ossDefault: string | null;
  primaryOrgs: string[];
}
export function resolveGlobalTokenPool(
  globalConfig: GlobalConfig | null
): GlobalTokenPoolPolicy
```

#### A-3. テスト

`config.test.ts`（既存があればそこに、なければ新設）に以下を追加:
- `resolveProjectTokenPool` のエッジケース（default∩exclude warn / default∩include dedup / 型違反 / undefined → 空 policy / 大文字 handle warn）
- `resolveGlobalTokenPool` の yaml 経由読み込み（snake → camel 変換、`oss_pool_tags` は無視されること）
- 既存の `resolveTokenPoolEnabled` テストは無変更で pass すること
- `tokenPool.enabled=false` → pool 機能 OFF（`isTokenPoolEnabled` の挙動確認。Project B 受け入れ条件に対応）

---

### Step B: project-tags.ts に OSS 判定追加

**目的**: 「project が OSS か否か」を `cmdSpawnAgent` から取れるようにする。

#### B-1. API 追加

```ts
export interface ProjectContext {
  projectTags: string[];
  isOss: boolean;
}

export async function resolveProjectContext(
  projectRoot: string,
  primaryOrgs: string[]
): Promise<ProjectContext>
```

判定ロジック（純粋部分は `parseRemoteOriginToContext(url, primaryOrgs)` に切り出す）:

```
1. .team/config.json の project_tags 明示があれば使う:
   - tags のいずれかが "org:X" で X ∈ primaryOrgs → isOss=false
   - それ以外 → isOss=true（明示でも org が一致しなければ OSS 扱い）
   - primaryOrgs が空 → isOss=false（旧動作維持。Open Q の決定に従う）
2. project_tags 明示がなければ git remote から推定:
   - parseRemoteOriginToTags の結果 + host/org を見て primaryOrgs と突き合わせる
   - host が github.com / 既知 OSS host → isOss=true
   - host が "github.<org>.com" or その他 で org ∈ primaryOrgs → isOss=false
   - それ以外 → isOss=true
   - primaryOrgs が空 → isOss=false（旧動作維持）
3. 全部失敗 → projectTags=["any"], isOss=false
```

#### B-2. 既存 API は維持

`resolveProjectTags()` は `resolveProjectContext()` を呼んで `.projectTags` を返す薄い wrapper にする（後方互換）。

#### B-3. テスト（`project-tags.test.ts`）

- primary_orgs=[] → 全パターンで isOss=false（**m6 整合確認**: plan §4 Open Questions と一致）
- primary_orgs=["myorg"]
  - github.com の URL → isOss=true
  - github.myorg.com → isOss=false
  - github.other.com → isOss=true
  - .team/config.json の project_tags=["org:myorg"] → isOss=false
  - .team/config.json の project_tags=["org:other"] → isOss=true
- 旧 `resolveProjectTags` は既存テスト全 pass

---

### Step C: selectToken() アルゴリズム改訂

**目的**: project default / include / exclude / OSS フラグを考慮した候補抽出。

#### C-1. シグネチャ拡張

```ts
export interface SelectTokenPolicy {
  projectTags: string[];        // 既存第3引数 相当
  projectDefault: string | null;
  include: string[];
  exclude: string[];
  isOss: boolean;
  ossDefault: string | null;    // OSS の場合の default fallback
}

export function selectToken(
  db: Database,
  holder: string,
  policy?: SelectTokenPolicy | string[],   // 既存 string[] 互換も許容
  nowIso?: string
): SelectedToken | null
```

> **m4 反映**: token-store.ts:686-708 の docstring を新セマンティクス（policy 優先順位 / OSS 判定 / default 昇格）に書き換える。具体的には以下の順序で記述する:
> 1. exclude にある handle は最優先で候補外
> 2. default（effectiveDefault）として明示参照される handle は `selectable=0` でも候補化（runtime 昇格、DB 不変）
> 3. include にある handle は tags 不一致でも候補化
> 4. それ以外の `selectable=1` token は: OSS なら無条件で候補（exclude を除く）、非 OSS なら projectTags との交集合で admit
> 5. score（0.3 * util_5h + 0.7 * util_7d）昇順で 1 つ選び acquireLease

**後方互換戦略**: 第 3 引数が `string[]` だった場合、内部で
`{ projectTags, projectDefault: null, include: [], exclude: [], isOss: false, ossDefault: null }` に正規化する（既存 6 ケース無変更で pass）。

#### C-2. 候補抽出ロジック

```
expireLeases(db, nowIso)
allTokens = listTokens(db, { selectableOnly: false }) // default の runtime 昇格に対応
activeLeases = ...
candidates: { token, score }[]

# effectiveDefault: project 側 default が明示されていれば OSS でも project default が優先される。
# OSS は global oss_default を fallback として補完するだけ。（m5 反映）
effectiveDefault = projectDefault ?? (isOss ? ossDefault : null)

for token in allTokens:
  if token.handle in exclude: continue                       # exclude 最優先
  if !token.selectable && token.handle != effectiveDefault: continue
                                                              # default 以外は selectable=1 必須
  if activeLeases.has(token.id): continue
  snap = getLatestUsageSnapshot
  if snap stale → continue
  if util_5h > 0.95 → continue

  # admit 判定
  admitted = false
  if token.handle == effectiveDefault:
    admitted = true                                          # default は無条件 admit
  else if token.handle in include:
    admitted = true                                          # include は tags 無視で admit
  else if isOss:
    admitted = true                                          # OSS は selectable=1 なら全部 admit (M2)
  else if matches_tags(token.tags, projectTags):
    admitted = true                                          # 通常 tag マッチ

  if !admitted: continue

  score = 0.3*util_5h + 0.7*util_7d
  candidates.push({ token, score })

candidates.sort by score asc
best = candidates[0]
acquireLease → return
```

**重要設計判断**:
- **M1 反映**: `selectable=0` の token は **default として明示参照される場合のみ** runtime 候補化する。**DB 上の `selectable` は書き換えない**（一時的な runtime 昇格のみ。副作用ゼロ。auto-discover 経路と相互汚染しない）
- **M2 反映**: OSS project では `selectable=1` の全 token を候補化（exclude のみ尊重、tag 不問）。`oss_pool_tags` のような中間設定はない。これにより受け入れ条件「Project C: pool 対象 K2, K3 すべて」が単純なルールで満たされる
- **m5 反映**: `effectiveDefault` は project default が最優先、OSS でも project default が指定されていればそちらを使う。`ossDefault` はあくまで OSS で project default が空の場合の fallback
- include / exclude / default は handle 文字列の **完全一致**（大文字小文字区別あり）。config 側で大文字混入は warn 済み（A-1 m7）

#### C-3. テスト

既存の 6 ケース（`describe("selectToken (tags フィルタ)")`）は **そのまま pass**（policy 引数を string[] で渡す古いシグネチャを維持）。

新規 describe `selectToken (project policy / OSS)` に以下のユニットケース:
- exclude 最優先（include に同じ handle が含まれていても候補外）
- default は selectable=0 でも候補（M1: runtime 昇格、DB 不変を確認）
- default は project 優先（projectDefault 指定時は OSS でも projectDefault が選ばれる、m5）
- default は ossDefault fallback（projectDefault=null かつ isOss=true → ossDefault が effectiveDefault に）
- include は tags 不一致でも候補
- 通常 tag matching 単独（非 OSS）
- OSS project では tags 不問で全 selectable=1 が候補（M2）
- OSS でも exclude にある handle は候補外
- 複数候補で score 最小が選ばれる
- すべて候補外なら null
- 後方互換: `selectToken(db, holder, ["any"])` 形式が既存通り動く

---

### Step D: project default の auto-discover 連携 + Keychain 不在フォールバック

**目的**: `tokenPool.default` で指定された handle が auto-discover 由来（`selectable=0`）でも spawn 時に拾えるようにし、Keychain に実 token が無い場合のフォールバックを定義する。

#### D-1. selectToken 側（M1 反映）

Step C-2 のロジックで実現済み:
- `listTokens({ selectableOnly: false })` で `selectable=0` も読み込む
- `effectiveDefault` に一致する handle のみ runtime で候補化（それ以外の `selectable=0` は素通し）
- **DB 上の `selectable` は書き換えない**。spawn-agent ごとに in-memory で判定するだけ

理由（M1 確定根拠）:
- 副作用を持ち込むと auto-discover 経路（既存）と相互汚染する
- DB 書き換えしないことで、複数 spawn が同じ default handle を同時取得しても DB は不変、衝突は lease（120 秒 TTL）で回避される
- A019 §改訂検討事項の「`selectable=1` に昇格」という文面は実装と矛盾するので、Step F で A019 文面を「runtime のみ昇格・DB 不変」に書き換える

#### D-2. cmdSpawnAgent 側

`main.ts:2680-2720` を以下のように改訂:

```ts
if (poolDecision.enabled) {
  const tokDb = initTokenDB();
  const projectConfig = await loadConfig(PROJECT_ROOT);
  const globalConfig = await loadGlobalConfig();

  const projectPolicy = resolveProjectTokenPool(projectConfig);
  const globalPolicy = resolveGlobalTokenPool(globalConfig);

  // 1) project_tags + isOss 解決
  let ctx: ProjectContext;
  try {
    ctx = await resolveProjectContext(PROJECT_ROOT, globalPolicy.primaryOrgs);
  } catch (e) {
    log("project_tags_resolve_failed", ...);
    ctx = { projectTags: ["any"], isOss: false };
  }

  // 2) selectToken 呼び出し
  const selected = selectToken(tokDb, surface, {
    projectTags: ctx.projectTags,
    projectDefault: projectPolicy.default,
    include: projectPolicy.include,
    exclude: projectPolicy.exclude,
    isOss: ctx.isOss,
    ossDefault: globalPolicy.ossDefault,
  });

  if (selected) {
    // 3) Keychain から実 token を取得（不在ならフォールバック）
    let tokenStr: string | null = null;
    try {
      tokenStr = retrieveTokenFromKeychain(selected.token.handle);
    } catch (e) {
      if (e instanceof KeychainNotFoundError) {
        tokenStr = null;
      } else {
        throw e;
      }
    }

    if (tokenStr) {
      // 通常パス
      exportVars.push(`CLAUDE_CODE_OAUTH_TOKEN=${tokenStr}`);
      log("token_pool_assigned", `... handle=${selected.token.handle}`);
    } else {
      // Keychain 不在フォールバック（M3 反映）
      log("token_pool_fallback",
          `... reason=keychain_missing handle=${selected.token.handle}`,
          { level: "warn" });
      // env 注入はスキップ（CLAUDE_CODE_OAUTH_TOKEN は Master 環境継承）
    }

    // AGENT_TOKEN_BOUND は handle が決まった時点で post（tokenStr 有無に関わらず）
    postMessage({
      type: "AGENT_TOKEN_BOUND",
      surface,
      tokenHandle: selected.token.handle,
      ...
    });
  } else {
    log("token_pool_fallback", `... reason=no_candidate`);
  }
}
```

**M3 確定動作（Keychain 不在時、箇条書き）**:
- **lease**: 通常通り取得（`acquireLease` の挙動そのまま、120 秒で自動 expire）
- **AGENT_TOKEN_BOUND**: **post する**（dashboard が handle を表示するため。selected.token.handle を流す）
- **env 注入**: skip（`CLAUDE_CODE_OAUTH_TOKEN` は Master 環境継承にフォールバック）
- **usage_snapshots**: pool 側では何もしない（proxy 経路で `organization_id` ベースに別途記録される。実 token は Master のものなので集計先は Master の token に紐付く。これは仕様上 accept する）
- **log**: `token_pool_fallback reason=keychain_missing handle=@xxx` を `warn` レベルで出す

> note: `enabled` が `tokenPool.enabled` のみで決まる現行仕様は維持（`include`/`default` が空でも enabled なら pool 機能 ON）。

#### D-3. テスト

selectToken に対する unit:
- `selectable=0` + handle=projectDefault → 候補化（runtime 昇格、DB 不変を別 query で確認）
- `selectable=0` + handle≠projectDefault → 候補外
- `selectable=0` + isOss=true + ossDefault に handle 一致 → 候補化
- `selectable=0` + isOss=true + ossDefault と不一致 → 候補外（OSS であっても default 以外の selectable=0 は拾わない）

cmdSpawnAgent の Keychain 不在動作は手動 / smoke で確認（既存 integration test がない領域なので E2E まで踏み込まない。詳細は §3.5）。

---

### Step E: 検証シナリオを token-store.test.ts に追加

**目的**: A019 §改訂検討事項の検証シナリオ（K1/K2/K3 × Project A/B/C）を unit 化する。

新 describe `selectToken (project default + include/exclude シナリオ)` に以下:

```ts
function seedThreeKeys(db) {
  const k1 = insertToken(db, makeToken({ handle: "@personal", organization_id: "org-personal", tags: ["any"] }));
  const k2 = insertToken(db, makeToken({ handle: "@a-corp",   organization_id: "org-a",        tags: ["org:A"] }));
  const k3 = insertToken(db, makeToken({ handle: "@b-corp",   organization_id: "org-b",        tags: ["org:B"] }));
  seedFreshSnapshot(k1.id, 0.05, 0.05);
  seedFreshSnapshot(k2.id, 0.05, 0.05);
  seedFreshSnapshot(k3.id, 0.05, 0.05);
  return { k1, k2, k3 };
}
```

#### Project A（default=@a-corp, include=[@personal], exclude=[]）

```ts
test("Project A: default=@a-corp が最優先", () => {
  const { k1, k2 } = seedThreeKeys(db);
  // default の score を低くしておく（同点回避）
  upsertUsageSnapshot(db, { token_id: k2.id, util_5h: 0.01, util_7d: 0.01, ... });
  const sel = selectToken(db, "h", {
    projectTags: ["org:A"],
    projectDefault: "@a-corp",
    include: ["@personal"],
    exclude: [],
    isOss: false,
    ossDefault: null,
  });
  expect(sel?.token.handle).toBe("@a-corp");
});

test("Project A: default 高負荷 → include の @personal が選ばれる", () => {
  const { k2 } = seedThreeKeys(db);
  upsertUsageSnapshot(db, { token_id: k2.id, util_5h: 0.96, util_7d: 0.9, ... }); // default ブロック
  const sel = selectToken(db, "h", {
    projectTags: ["org:A"],
    projectDefault: "@a-corp",
    include: ["@personal"],
    exclude: [],
    isOss: false,
    ossDefault: null,
  });
  expect(sel?.token.handle).toBe("@personal");
});

test("Project A: K3 (@b-corp) は project_tags=['org:A'] 不一致 + include 未指定 → 候補外", () => {
  // default=@a-corp の lease を先取りして塞ぎ、@personal も exclude に入れる
  const { k1 } = seedThreeKeys(db);
  acquireLease(db, /* k2.id 相当の token */, "h2", ...);
  const sel = selectToken(db, "h", {
    projectTags: ["org:A"],
    projectDefault: "@a-corp",
    include: [],
    exclude: ["@personal"],
    isOss: false,
    ossDefault: null,
  });
  expect(sel).toBeNull();
});
```

#### Project B（enabled=false）

selectToken の責務外（cmdSpawnAgent の `if (poolDecision.enabled)` で skip）。
そのため selectToken のテストでは扱わず、`config.test.ts` 側で「`tokenPool.enabled=false` → `isTokenPoolEnabled` が false を返す」を確認するに留める（Step A-3 でカバー）。

#### Project C（OSS, project tokenPool 未設定）

```ts
test("Project C (OSS): selectable=1 の K1/K2/K3 すべてが候補化される (M2)", () => {
  const { k1, k2, k3 } = seedThreeKeys(db);
  // util を差別化して順序を決定的に
  upsertUsageSnapshot(db, { token_id: k1.id, util_5h: 0.01, util_7d: 0.01, ... }); // 最低
  upsertUsageSnapshot(db, { token_id: k2.id, util_5h: 0.10, util_7d: 0.10, ... });
  upsertUsageSnapshot(db, { token_id: k3.id, util_5h: 0.20, util_7d: 0.20, ... });
  const sel = selectToken(db, "h", {
    projectTags: ["any"],
    projectDefault: null,
    include: [],
    exclude: [],
    isOss: true,
    ossDefault: "@personal",
  });
  // ossDefault=@personal が effectiveDefault → 無条件 admit + 最低 score → 選ばれる
  expect(sel?.token.handle).toBe("@personal");
});

test("Project C (OSS): @personal を高負荷にすると K2/K3 も候補に入る", () => {
  const { k1, k2 } = seedThreeKeys(db);
  upsertUsageSnapshot(db, { token_id: k1.id, util_5h: 0.96, util_7d: 0.9, ... }); // default ブロック
  upsertUsageSnapshot(db, { token_id: k2.id, util_5h: 0.05, util_7d: 0.05, ... });
  const sel = selectToken(db, "h", {
    projectTags: ["any"],
    projectDefault: null,
    include: [],
    exclude: [],
    isOss: true,
    ossDefault: "@personal",
  });
  // @personal はブロックされ、tags=["org:A"] の @a-corp が OSS では tag 不問で admit される
  expect(sel?.token.handle).toBe("@a-corp");
});

test("Project C (OSS): exclude に @b-corp → K1/K2 のみ候補", () => {
  const { k1 } = seedThreeKeys(db);
  upsertUsageSnapshot(db, { token_id: k1.id, util_5h: 0.96, util_7d: 0.9, ... }); // default ブロック
  // @a-corp と @b-corp の score を比較したいが b は exclude
  const sel = selectToken(db, "h", {
    projectTags: ["any"],
    projectDefault: null,
    include: [],
    exclude: ["@b-corp"],
    isOss: true,
    ossDefault: "@personal",
  });
  expect(sel?.token.handle).toBe("@a-corp"); // @b-corp は exclude で除外される
});
```

> 受け入れ条件「Project C: pool 対象 K2, K3 すべて」は M2 確定により `isOss=true` 時に exclude を除く全 selectable=1 token が admit される実装で満たされる。

---

### Step F: A019 artifact の文面更新（実装 Agent が直接編集）

**目的**: M1〜M3 の確定判断と実装を A019 文面と整合させる。**m2 反映**: artifact の編集は CLAUDE.md「Artifacts」§の「直接ファイル作成」規約に従い、実装 Agent が `.team/artifacts/A019-token-pool-design.md` を直接編集する（同じコミットに含める）。

実装完了後、`.team/artifacts/A019-token-pool-design.md` に以下の修正を入れる:

1. **frontmatter の `updated:` を実装日（`2026-04-DD`）に更新**
2. **M1 関連（§改訂検討事項「project default の auto-discover 連携」）**:
   - 旧: 「spawn-agent 時に自動的に `selectable=1` に昇格して候補化する」
   - 新: 「DB 上の `selectable` は変更せず、spawn-agent 時に `tokenPool.default` で参照されている handle のみを runtime（in-memory）で候補化する。複数 spawn が同じ default を同時取得しても DB は不変、衝突は lease（120 秒 TTL）で回避する」
3. **M2 関連（§改訂検討事項「OSS project の候補化ポリシー」「global config schema」「検証シナリオ Project C」）**:
   - `oss_pool_tags` の記載を **削除**（global config schema・検証シナリオ表・本文すべて）
   - 「OSS 判定された project では、`exclude` を除いた `selectable=1` の全 token を候補化する」と明記
   - global `token_pool` schema は `enabled` / `oss_default` / `primary_orgs` の 3 フィールドのみとする
   - 検証シナリオ Project C の「pool 対象 K2, K3 すべて」が、この単純ルールで満たされる旨を補足
4. **M3 関連（§改訂検討事項「Keychain 不在時のフォールバック」）**:
   - 「Keychain にない token が選ばれた場合、env 注入はスキップ（Master 環境継承フォールバック）。`AGENT_TOKEN_BOUND` は **post する**（dashboard 表示のため）。`usage_snapshots` は proxy 経路で `organization_id` ベースに別途記録されるので pool 側で何もしない。lease は通常通り取得し 120 秒で自動 expire。`token_pool_fallback reason=keychain_missing handle=@xxx` を warn ログ出力」と動作を箇条書きで明記

---

## 3. テスト戦略

### 3.1 Unit test の組み立て方

- **DB**: `mkdtempSync` + `TOKEN_STORE_DB_PATH` で隔離（既存パターン踏襲）
- **Keychain**: `KEYCHAIN_TEST_MODE=1` で in-memory（selectToken は Keychain を触らないため、cmdSpawnAgent integration ではない）
- **snapshot**: 既存 `seedFreshSnapshot(tokenId, util5h, util7d)` を流用

### 3.2 シナリオ表現の安定性

スコア同点を避けるため、検証ケースでは **意図的に util を差別化** する（例: default を 0.01 に、include を 0.05 に、その他を 0.10 に）。同点で sort 順に依存する記述は避ける。

### 3.3 既存テストの非回帰

- `selectToken` の引数 `string[]` を許容する後方互換 path を残す
- 既存 6 テスト（`selectToken (tags フィルタ)` describe）はコード変更なしで pass
- `resolveProjectTags` の wrapper は既存 7 ケース（project-tags.test.ts）pass
- `resolveTokenPoolEnabled` の既存テストは pass

### 3.4 Unit テスト カバー範囲（m3 反映 §1/2）

> **m3 前段**: 自動テストでカバーする範囲。

| # | ケース | 期待 | テスト場所 |
|---|---|---|---|
| U1 | default ∈ exclude | warn + exclude から除外（default 候補化維持） | config.test.ts |
| U2 | default ∈ include | dedup（include 側無視）、default として候補化 | config.test.ts |
| U3 | OSS 判定失敗（git remote エラー） | isOss=false（旧動作維持） | project-tags.test.ts |
| U4 | primary_orgs=[] | 全 project が isOss=false（旧動作維持） | project-tags.test.ts |
| U5 | selectable=0 の handle が default に指定 | 候補化（runtime 昇格、DB 不変を別 query で確認） | token-store.test.ts |
| U6 | selectable=0 の handle が default 以外 | 候補外（OSS でも） | token-store.test.ts |
| U7 | OSS project で selectable=1 全 token が tag 不問で候補化 | 全 token admit、exclude のみ尊重 | token-store.test.ts |
| U8 | exclude に未知 handle | 無視（型 OK なら警告無し） | config.test.ts |
| U9 | tokenPool.enabled=false | isTokenPoolEnabled が false → cmdSpawnAgent で skip | config.test.ts |
| U10 | 大文字混じり handle | warn のみ、reject も rename もしない | config.test.ts |
| U11 | `selectToken(db, holder, ["any"])` 旧シグネチャ | 既存 6 ケース全 pass（後方互換） | token-store.test.ts |
| U12 | effectiveDefault は projectDefault 優先（OSS でも） | projectDefault 指定時は ossDefault を上書き | token-store.test.ts |

### 3.5 手動 smoke チェックリスト（m3 反映 §2）

> **m3 後段**: 自動化しない（cmdSpawnAgent / Keychain / cmux ペイン spawn 経由は integration なので手動確認）。受け入れ条件「スケーラビリティ E2E」は以下のリストで担保する。

実装完了後、以下を手動で実行して結果を実装結果報告に記載する:

- [ ] **smoke-1 (Project A: default 注入)**:
  - `~/.cmux-team/config.yaml` に `token_pool: { primary_orgs: [myorg] }` を設定
  - Project A の `.team/config.json` に `token_pool: { enabled: true, default: "@a-corp", include: ["@personal"] }`
  - `cmux-team token add @a-corp --tags org:A`、`cmux-team token add @personal --tags any`
  - `cmux-team spawn-agent` → log で `token_pool_assigned handle=@a-corp` を確認、env に `CLAUDE_CODE_OAUTH_TOKEN` が注入される
- [ ] **smoke-2 (Project A: include 候補化)**:
  - smoke-1 の状態から `cmux-team token select-block @a-corp` 等で default を一時無効化（or util_5h 高負荷を擬似）
  - `cmux-team spawn-agent` → log で `handle=@personal` を確認
- [ ] **smoke-3 (Project A: 新 token 追加が他に影響しない)**:
  - `cmux-team token add @new-tok --tags any`
  - Project A の include に追加せず spawn-agent → @new-tok が候補化されないこと（ログで非選択を確認）
  - Project A の include に `@new-tok` を 1 行追加 → spawn-agent で候補化されること
  - 他 project（B/C）の `.team/config.json` は無変更で挙動が変わらないこと
- [ ] **smoke-4 (Project C: OSS 自動判定 + 全候補化)**:
  - github.com を origin remote に持つ project で `cmux-team spawn-agent` → log に `isOss=true` 相当の判定が出る
  - selectable=1 の全 token が候補に入ること（log の token_pool_assigned 履歴で K1/K2/K3 のいずれかが選ばれていれば OK）
- [ ] **smoke-5 (Keychain 不在フォールバック, M3)**:
  - DB に handle=`@phantom` を直接 INSERT、Keychain には登録しない
  - Project A の default を `@phantom` に設定 → spawn-agent
  - log で `token_pool_fallback reason=keychain_missing handle=@phantom` warn を確認
  - env に `CLAUDE_CODE_OAUTH_TOKEN` が注入されない（Master 環境継承）
  - dashboard / `cmux-team status` 等で AGENT_TOKEN_BOUND の handle=@phantom が表示される
  - lease が 120 秒で expire することを `cmux-team token list` で確認

### 3.6 エッジケース（必ずカバー）

| # | ケース | 期待 |
|---|---|---|
| E1 | default ∈ exclude | warn ログ + exclude 無視（default 候補化） |
| E2 | default ∈ include | dedup（include 側無視）、default として候補化 |
| E3 | OSS 判定失敗（git remote エラー） | isOss=false（旧動作維持） |
| E4 | primary_orgs=[] | 全 project が isOss=false（旧動作維持） |
| E5 | selectable=0 の handle が default に指定 | 候補化（runtime 昇格、DB 不変） |
| E6 | selectable=0 の handle が default 以外 | 候補外（既存通り） |
| E7 | Keychain に default の handle が無い | env 注入スキップ + AGENT_TOKEN_BOUND post + token_pool_fallback(reason=keychain_missing) + lease は維持 |
| E8 | exclude に未知 handle | 無視（型 OK なら警告無し） |
| E9 | tokenPool.enabled=false | selectToken 自体が呼ばれない（cmdSpawnAgent で skip） |
| E10 | OSS project で selectable=1 全 token が候補（M2） | tag 不問、exclude のみ尊重 |
| E11 | 大文字を含む handle が config に書かれる | warn のみ、マッチ失敗扱い（DB は小文字なので候補化されない） |

---

## 4. Open Questions の決定方針

| Question | 採用方針 |
|---|---|
| `primary_orgs` 未設定時の OSS 判定 | **「全て non-OSS」**（旧動作維持）。`primary_orgs=[]` または未指定 → `isOss=false` 固定 |
| `default` ∩ `include` | **default 優先**。include 側を黙って dedup（warn 出さない） |
| `exclude` ∋ `default` | **warn ログ + exclude を無視**。`console.warn` で `[token-pool] config_warning: default '@xxx' is also in exclude — ignoring exclude entry`。default としての候補化は維持 |
| OSS project の候補化ポリシー（M2 確定） | **`selectable=1` の全 token を候補化（exclude のみ尊重）**。`oss_pool_tags` は廃止 |
| selectable 昇格挙動（M1 確定） | **runtime 昇格のみ・DB 不変**。A019 文面は Step F で書き換え |
| Keychain 不在時の AGENT_TOKEN_BOUND（M3 確定） | **post する（dashboard 表示優先）**。env 注入のみスキップ。lease は維持。warn ログを出す |
| 大文字混じり handle の扱い | **warn のみ、reject も rename もしない**（マッチ失敗扱い）|

---

## 5. 影響範囲とリスク

### 5.1 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/token-store.ts` | `selectToken` シグネチャ拡張（後方互換維持）/ `SelectTokenPolicy` 型追加 / docstring 更新（m4） |
| `skills/cmux-team/manager/config.ts` | `TeamConfig.tokenPool` / `GlobalConfig.tokenPool` 拡張、`resolveProjectTokenPool` / `resolveGlobalTokenPool` 追加、`loadGlobalConfig` の yaml 詰め替え拡張（`oss_pool_tags` は追加しない） |
| `skills/cmux-team/manager/project-tags.ts` | `resolveProjectContext` / `parseRemoteOriginToContext` 追加、既存 `resolveProjectTags` は wrapper 化 |
| `skills/cmux-team/manager/main.ts` | `cmdSpawnAgent` の token 選択経路を新 API に書き換え、Keychain 不在フォールバック追加（M3 動作） |
| `skills/cmux-team/manager/token-store.test.ts` | Project A/C 検証シナリオ + selectable=0 default 昇格 + OSS 全候補化 のユニット追加 |
| `skills/cmux-team/manager/config.test.ts` | `resolveProjectTokenPool` / `resolveGlobalTokenPool` の新規 describe + tokenPool.enabled=false 確認 |
| `skills/cmux-team/manager/project-tags.test.ts` | `resolveProjectContext` の OSS 判定パターン追加 |
| `.team/artifacts/A019-token-pool-design.md` | M1/M2/M3 の文面整合 + `updated:` 日付更新（実装 Agent が直接編集、Step F） |

**触らない**:
- DB schema
- `cmux-team token add|list|remove|rotate` CLI（Keychain 連携）
- `traces.db` / `api_usage` / `usage_snapshots` の書き込み経路（proxy 側）

### 5.2 後方互換性

- 既存 project（`tokenPool` 未設定）: `resolveProjectTokenPool` が `{ default: null, include: [], exclude: [] }` を返し、`enabled` 解決は別 path（`resolveTokenPoolEnabled`）が今まで通り処理 → 現行動作維持
- 既存 token tag 体系: 変更なし。意味（hint 化）は config 側の優先順位で実現、DB schema/値は不変
- `selectToken(db, holder, ["any"])` のような既存呼び出しは internally policy 化される。**ただし** main.ts の呼び出しは新 API に切り替えるので、外部から token-store.ts を import している場所がないことを `grep -rn "selectToken("` で確認する

### 5.3 パフォーマンス

- `listTokens({ selectableOnly: false })` に変えるが、auto-discover 込みでも token 数は数十オーダーのため linear scan で問題なし
- DB アクセス回数は変わらない（lease 検索 / snapshot 取得は token ごと）
- yaml load は 1 spawn-agent あたり 1 回。bun の `yaml` import は既に T322 で実績あり

### 5.4 リスク

- **shape 変更による型エラー**: `selectToken` の policy 型を string[] と union にしたことで、エディタで型推論が効かない呼び出しが発生する可能性。実装時 `bun test` + `bun check` で検出する
- **Keychain 不在時の usage 計上ズレ**: pool 計上のために AGENT_TOKEN_BOUND を post するが、proxy 側 usage_snapshots は実 token（Master 環境継承の token）の `organization_id` で集計されるので、dashboard の handle 表示と usage の集計先がズレる。これは仕様上 accept する（M3 確定）。lease は 120 秒で expire するので意図しない長期占有はしない
- **runtime 昇格の副作用なし**: DB 書き換えしないので、複数 spawn が同じ default handle を同時取得しても DB は不変、lease で衝突回避

---

## 6. 作業境界

- **`.team/artifacts/A019-token-pool-design.md` は実装 Agent が直接編集する**（m2 反映、CLAUDE.md「Artifacts」§の「直接ファイル作成」規約に従う）。Step F で文面整合 + `updated:` 日付更新を同じ commit に含める
- DB schema 変更しない
- Keychain 連携の実装変更しない（既存 `retrieveTokenFromKeychain` / `KeychainNotFoundError` を再利用）
- `cmux-team token add` CLI も変更しない（default 昇格は selectToken の runtime 動作のみで実現）
- proxy 側 / api_usage 経路は触らない

---

## 7. 実装順（推奨 commit 単位）

1 つの PR で全部入れる前提だが、コミットは Step ごとに分割すると review しやすい:

```
commit 1: Step A (config schema + resolver)         ← 単独で test 緑
commit 2: Step B (project-tags OSS 判定)            ← 単独で test 緑
commit 3: Step C (selectToken 拡張 + docstring)     ← 既存 6 + 新規 unit が緑
commit 4: Step D (cmdSpawnAgent 接続 + Keychain フォールバック) ← integration（手動 smoke）
commit 5: Step E (Project A/C シナリオ unit)         ← unit 緑
commit 6: Step F (A019 文面整合 + updated 日付)      ← 同 PR 内で実装と一緒にコミット
```

各 commit で `bun test` を全て通す（既存テスト非回帰確認）。手動 smoke (§3.5) は commit 4 以降で実施し、結果を実装結果報告に記載する。
