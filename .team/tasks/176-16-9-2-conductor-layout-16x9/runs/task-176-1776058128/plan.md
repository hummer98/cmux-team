# T176: `--layout=16x9` 2 Conductor レイアウトモード 実装計画

## 0. ゴール

- `cmux-team start --layout=16x9` で 3 ペイン・4 surface・maxConductors=2 の 16:9 向けレイアウトを起動できるようにする。
- 既存 `wide`（現行 3 Conductor）モードを後方互換デフォルトとして維持する。
- 切替優先順位: CLI フラグ `--layout=<mode>` > `config.json` の `layout` > `"wide"`。
- 起動モードを `team.json.layout` に記録する（デバッグ用途）。

---

## 1. 現状分析

### 1-1. 起動フロー（`skills/cmux-team/manager/main.ts`）
- `cmdStart`（L184〜）が `--` オプションを `getArg()`（L115〜）でパース。`loadConfig()`（L98〜）は `.team/config.json` を JSON で読む。現在 `TeamConfig` interface（L89〜96）は `models` / `envrcHookPromptSkipped` のみ。
- `createDaemon`（`daemon.ts` L92〜122）で `state.maxConductors` は `CMUX_TEAM_MAX_CONDUCTORS ?? 3` 固定（L104）。
- 起動ログ（`main.ts` L218〜221）で `max_conductors=${state.maxConductors}` を出力。
- `rawResumePlan` は `state.maxConductors` 超過分を ready に差し戻す（`main.ts` L447〜452）。`initializeLayout(state, daemonSurface, rawResumePlan)` を呼ぶ（L475）。

### 1-2. レイアウト生成（`daemon.ts` / `conductor.ts`）
- `initializeLayout`（`daemon.ts` L375〜450）は team.json 復元を試み、なければ `initializeConductorSlots(state.projectRoot, state.conductors, state.maxConductors, daemonSurface, resumePlan)` を呼ぶ（L441〜447）。
- `initializeConductorSlots`（`conductor.ts` L183〜259）は `createConductorPanes(count, daemonSurface)` で pane を切り、`count` 個の Claude を launch する。
- `createConductorPanes`（`conductor.ts` L156〜179）のロジック:
  - `cmux.newSplit("right", daemon)` → Conductor-1 pane（右上）
  - `count >= 2` → `cmux.newSplit("down", daemon)` → Conductor-2 pane（左下）
  - `count >= 3` → `cmux.newSplit("down", { surface: s1 })` → Conductor-3 pane（右下）
- 結果は「左上に daemon(Manager)+Master タブ、右上 C1、左下 C2、右下 C3」という 2x2。

### 1-3. team.json 出力（`daemon.ts` `updateTeamJson` L1184〜1226）
- `manager` / `master` / `conductors` を書き出し、`phase: "running"` をセット。`layout` フィールドは無い。

### 1-4. docs
- `docs/spec/00-project-overview.md` L47 に「## レイアウト: 固定2x2」、L49〜52 に 5 surface 構成の説明。
- `docs/spec/05-install-and-infrastructure.md` にはレイアウトの節が存在しない（追加する想定）。
- `docs/spec/06-implementation-tasks.md` L42/47 にも「固定2x2」と書かれている（整合性のため触れるかは後述）。

### 1-5. テスト
- `conductor.test.ts` には `createConductorPanes` のテストが未整備（`grep` 結果ゼロ）。`daemon.test.ts`・`main.test.ts` も `layout` 関連テストなし。
- 既存テストは Bun の `test` を使用。新規テスト追加時は mock で `cmux.newSplit` を差し替える方針で統一する。

### 1-6. maxConductors の利用箇所（影響範囲）
- `daemon.ts` L104（初期化）、`daemon.ts` L440（`layout_creating_new_slots` ログ）、`daemon.ts` L444（`initializeConductorSlots` の count 引数）。
- `main.ts` L220（ログ）、L447（resume overflow）。
- 他ファイルでは `maxConductors` を直接参照しない（ファイル横断で `grep` 確認済み）。
- タスクキュー挙動: `ready` → `assigned` の割当は idle conductor が空いているかどうかで判定するため、maxConductors の値そのものよりも「実在する Conductor 数」で制御される。したがって pane 作成数を 2 にすれば自然にキューイングが発生する。

---

## 2. 設計方針

### 2-1. 内部表現

```ts
// schema.ts に追加
export type LayoutMode = "wide" | "16x9";
export const LayoutMode = z.enum(["wide", "16x9"]);

// 推奨 layout → maxConductors のマッピング
export const LAYOUT_MAX_CONDUCTORS: Record<LayoutMode, number> = {
  wide: 3,
  "16x9": 2,
};
```

- `DaemonState` に `layout: LayoutMode` を追加。
- `maxConductors` は既存通り残すが、layout から派生させる（`CMUX_TEAM_MAX_CONDUCTORS` 環境変数が指定されている場合はそちらが勝つ — 既存挙動を破壊しない）。

### 2-2. CLI / config 優先順位

```ts
function resolveLayout(config: TeamConfig, cliLayout: string | undefined): LayoutMode {
  const raw = cliLayout ?? config.layout ?? "wide";
  if (raw !== "wide" && raw !== "16x9") {
    throw new Error(`Unknown layout: ${raw} (expected "wide" or "16x9")`);
  }
  return raw;
}
```

- `main.ts` の `cmdStart` で `getArg("layout")` → `loadConfig()` の順に解決。
- 不正値は `console.error` + `process.exit(1)` で即停止（bun の test 側では throw を検証）。

### 2-3. Pane 分割の差分

| 手順 | wide (count=3) | 16x9 (count=2) |
|------|----------------|----------------|
| 1 | daemon を下に split → 下段横一本の pane（C1 基底） | daemon を下に split → 下段の pane（両 C の基底） |
| 2 | 左上を右に split → Manager/Master 同居（現行そのまま）※実際は逆順 | — |
| ... | 実際は現行の「right → down → down」パターンを保持 | 下段 pane を右に split して下段を 2 分割（C1 左、C2 右） |

**最終的な実装形（wide 現行 / 16x9 追加）:**

```ts
// conductor.ts
export async function createConductorPanes(
  count: number,
  daemonSurface?: string,
  layout: LayoutMode = "wide",
): Promise<Pane[]> {
  if (layout === "16x9") {
    // 上段フル幅 (daemon+master 同居) / 下段 2 分割
    // daemon surface を下に split して C1 pane を作る
    const c1 = await cmux.newSplit("down", daemonSurface ? { surface: daemonSurface } : undefined);
    const panes = [{ surface: c1, paneId: await getPaneIdForSurface(c1) }];
    if (count >= 2) {
      // C1 pane を右に split して C2 pane を作る（下段を等幅 2 分割）
      const c2 = await cmux.newSplit("right", { surface: c1 });
      panes.push({ surface: c2, paneId: await getPaneIdForSurface(c2) });
    }
    return panes;
  }
  // 既存 wide ロジック（そのまま）
  ...
}
```

- 16x9 では `count >= 3` のブランチは呼ばれない想定（呼ばれたら例外）。
- launch 部分（Claude 起動・resume 適用）は layout 非依存のためそのまま共通。

### 2-4. team.json への記録

- `updateTeamJson` で `teamJson.layout = state.layout` を追記。
- 既存 reader への影響は無い（未使用フィールド追加）。

### 2-5. 起動ログ

- `daemon_started` の detail に `layout=${state.layout}` を追加。
- `layout_creating_new_slots` のログに `layout=${state.layout}` を追加。

---

## 3. 実装ステップ（TDD 指向）

### Step 1: schema 追加
**ファイル:** `skills/cmux-team/manager/schema.ts`
- `LayoutMode` zod enum と TS 型、`LAYOUT_MAX_CONDUCTORS` 定数を追加。
- **テスト**（`schema` は軽量のため専用 test 追加しなくても良いが、必要なら `main.test.ts` で `resolveLayout` 経由で検証）。

### Step 2: `resolveLayout` ヘルパー
**ファイル:** `skills/cmux-team/manager/main.ts`
- `TeamConfig` に `layout?: LayoutMode` を追加。
- `resolveLayout(config, cliLayout)` を追加。
- **テスト**（`main.test.ts`）:
  - `resolveLayout({}, undefined)` → `"wide"`
  - `resolveLayout({ layout: "16x9" }, undefined)` → `"16x9"`
  - `resolveLayout({ layout: "16x9" }, "wide")` → `"wide"`（CLI 優先）
  - `resolveLayout({}, "invalid")` → throw

### Step 3: DaemonState に layout を反映
**ファイル:** `skills/cmux-team/manager/daemon.ts`
- `DaemonState` に `layout: LayoutMode` を追加。
- `createDaemon` の引数に `layout: LayoutMode = "wide"` を追加、`maxConductors` は `process.env.CMUX_TEAM_MAX_CONDUCTORS ?? LAYOUT_MAX_CONDUCTORS[layout]`。
- **テスト**（`daemon.test.ts`）: `createDaemon(root, "16x9")` → `state.maxConductors === 2` / `state.layout === "16x9"`。env 指定時は env 優先。

### Step 4: `cmdStart` から layout を注入
**ファイル:** `skills/cmux-team/manager/main.ts`
- `const cliLayout = getArg("layout");` を `cmdStart` 冒頭（preflight 後）で取得。
- `const config = await loadConfig();`（既に別箇所で読まれているため、cmdStart 冒頭でも読んで `resolveLayout` する）。
- `createDaemon(PROJECT_ROOT, layout)` に差し替え。
- `daemon_started` ログに `layout=${layout}` を追加。
- `help_start` i18n メッセージを更新（`--layout=<wide|16x9>` を追記）。

### Step 5: `createConductorPanes` を layout 対応に
**ファイル:** `skills/cmux-team/manager/conductor.ts`
- 第 3 引数 `layout: LayoutMode = "wide"` を追加。
- 16x9 分岐を追加（§2-3 の擬似コード）。
- **テスト**（新規 `conductor.test.ts` セクション）: `cmux.newSplit` を mock し、
  - layout=wide, count=3 → newSplit が `("right", daemon) → ("down", daemon) → ("down", c1)` の順で呼ばれる
  - layout=16x9, count=2 → newSplit が `("down", daemon) → ("right", c1)` の順で呼ばれる

### Step 6: `initializeConductorSlots` / `initializeLayout` に layout を透過
**ファイル:** `skills/cmux-team/manager/conductor.ts`, `daemon.ts`
- `initializeConductorSlots(projectRoot, conductors, count, daemonSurface, resumePlan, layout)` の signature 拡張。
- `initializeLayout(state, daemonSurface, resumePlan)` は `state.layout` を内部で使うだけなので呼び出し側 API は変えない。
- `layout_creating_new_slots` ログに `layout=${state.layout}` を追加。

### Step 7: team.json に layout を記録
**ファイル:** `skills/cmux-team/manager/daemon.ts`
- `updateTeamJson` で `teamJson.layout = state.layout;` を追加。
- team.json 復元パス（`initializeLayout` 冒頭）では既存 layout 情報を参考にはしない（新規作成 fallback は `state.layout` を使用）。`alive.length === 0` で新規作成に落ちる場合は現在の state.layout が優先される。
- **テスト**: `updateTeamJson` 後にファイルを読んで `layout` フィールドが反映されることを確認（`daemon.test.ts` の既存 updateTeamJson テストに追加）。

### Step 8: i18n / help / status 表示
**ファイル:** `skills/cmux-team/manager/i18n.ts`, `main.ts`
- `help_start` 日英両言語に `--layout=<wide|16x9>` を追記。
- `cmdStatus`（既存）で `state.layout` を表示するかは optional。team.json に入るので dashboard 側で拾える。**今回はログ + team.json のみに留める**（ダッシュボード変更はスコープ外）。

### Step 9: docs 更新
**ファイル:** `docs/spec/05-install-and-infrastructure.md`
- 「## レイアウトモード」節を追加。
  - wide / 16x9 の 2 モード、ペイン構成図、maxConductors 表、切替方法（CLI / config）、優先順位を記載。
- `docs/spec/00-project-overview.md` L47〜52: 「固定2x2」記述を「デフォルトは wide（2x2）、16x9 は 1+2 構成」に書き換え。
- `CLAUDE.md` の「固定2x2レイアウト」節も同様に更新（今回のスコープに含めるか要確認 — 含める方針で書いておく）。

### Step 10: 手動 E2E 検証
- §4 を実施。

---

## 4. 検証手順（タスクの 1〜6 に対応）

1. **16x9 起動確認**: `cmux-team start --layout=16x9` → `cmux tree` の出力を取得し pane 数 = 3、surface 数 = 4 を確認。`team.json` を開き `layout: "16x9"`、`conductors` 配列長が 2 であることを確認。
2. **レイアウト目視**: cmux 内で上段フル幅 + 下段 2 分割になっていることを目視確認（スクショ添付可）。
3. **キューイング**: `cmux-team create-task` を 3 連続で ready 状態にし、`cmux-team status` で 2 タスクが `assigned`、残り 1 タスクが `ready` のままであることを確認。
4. **デフォルト wide 起動**: `cmux-team stop` 後に `cmux-team start`（フラグなし）→ `team.json` の `layout: "wide"`、`conductors` 3 個。`cmux tree` で pane 4 個。
5. **config 指定**: `.team/config.json` に `{"layout":"16x9"}` を書いて `cmux-team start` → `team.json.layout === "16x9"`。
6. **CLI が config を上書き**: 5 の config のまま `cmux-team start --layout=wide` → `team.json.layout === "wide"`、pane 4、Conductor 3。

各ステップで以下を記録:
- `team.json` の `layout` / `conductors` 情報
- `.team/logs/manager.log` から `daemon_started` と `layout_creating_new_slots` 行
- `cmux tree` の pane 構成

---

## 5. リスク・懸念

### 5-1. 既存の `maxConductors` 依存
- `main.ts` L447 の resume overflow は `state.maxConductors` に依存するため、16x9 では 3 番目以降の assigned タスクが自動的に ready に差し戻される。**これは仕様通り**（タスクの検証項目 3 と一致）。
- `CMUX_TEAM_MAX_CONDUCTORS` 環境変数を使っているユーザーがいた場合、layout=16x9 と併用で矛盾する可能性あり。優先順位: env > layout 派生値（既存互換）。ドキュメントに明記する。

### 5-2. team.json 下流読み取り
- `initializeLayout`（L384〜）は `teamJson.conductors` のみ読む。`layout` フィールド追加は後方互換。
- `dashboard.tsx` 等の reader は別途 `grep` で確認。`layout` を未読み取りのまま追加するのでクラッシュしない。

### 5-3. 既存 team.json を再利用した起動
- 既存 team.json に Conductor が 3 個 alive の状態で `--layout=16x9` 起動した場合、`initializeLayout` の復元パスに入るため pane 数を強制変更しない（=3 個のまま）。
- **対応方針**: 復元パスでは `state.layout` を team.json 上の `layout` と比較し、違えばログ警告を出す（`layout_mismatch_on_resume`）。強制再構築はしない（`cmux-team stop` → `start` での明示再構築を要求）。
- これは検証手順 5〜6 で古い state が残っていると再現するため、検証前に `cmux-team stop` と `.team/team.json` クリアを手順化する。

### 5-4. resume overflow と layout 縮小の組み合わせ
- wide(3) で assigned 3 個 → stop → `--layout=16x9` で再起動すると、資金 overflow で 1 タスクは ready に戻る。現行の `resume_overflow_to_ready` ロジックで吸収されるため追加コード不要。manager.log にログが出ることを検証手順に含める。

### 5-5. ドキュメントとコードの整合
- `CLAUDE.md` の「固定2x2レイアウト」節、`docs/spec/00-project-overview.md`、`docs/spec/06-implementation-tasks.md` の記述が lock-in になっている。スコープは「spec のレイアウト節を更新する」点までだが、CLAUDE.md は開発者の行動規範に影響するため同期することを強く推奨。
- 本タスクでは `docs/spec/05-install-and-infrastructure.md` と `docs/spec/00-project-overview.md`、`CLAUDE.md`（レイアウト戦略節）の 3 ファイルを必ず更新する。`06-implementation-tasks.md` は仕様履歴寄りなので必要最小限（「現在は wide/16x9 選択可能」の 1 行追記）に留める。

### 5-6. テスト基盤
- `createConductorPanes` は現状単体テストが無いため、mock 方式（`cmux` モジュールを `mock.module` で差し替え）を `conductor.test.ts` に新規導入する。他のテストへの副作用に注意（`beforeEach` / `afterEach` で確実にリストア）。

---

## 6. 成果物・ファイル変更サマリ

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/schema.ts` | `LayoutMode` 型・zod enum・`LAYOUT_MAX_CONDUCTORS` 定数追加 |
| `skills/cmux-team/manager/main.ts` | `TeamConfig.layout` / `resolveLayout` / `cmdStart` で layout 解決 / help 更新 |
| `skills/cmux-team/manager/daemon.ts` | `DaemonState.layout` / `createDaemon` 拡張 / `updateTeamJson` に layout 追記 / ログ拡張 / resume mismatch 警告 |
| `skills/cmux-team/manager/conductor.ts` | `createConductorPanes` / `initializeConductorSlots` に layout 引数を追加し 16x9 分岐 |
| `skills/cmux-team/manager/i18n.ts` | `help_start` に `--layout` オプション追記（ja/en） |
| `skills/cmux-team/manager/main.test.ts` | `resolveLayout` テスト追加 |
| `skills/cmux-team/manager/daemon.test.ts` | `createDaemon` layout、`updateTeamJson` layout フィールドのテスト追加 |
| `skills/cmux-team/manager/conductor.test.ts` | `createConductorPanes` の wide/16x9 分岐テスト（cmux mock）追加 |
| `docs/spec/05-install-and-infrastructure.md` | 「レイアウトモード」節を追加 |
| `docs/spec/00-project-overview.md` | 「固定2x2」→「2 モード（wide/16x9）」の更新 |
| `CLAUDE.md` | 「レイアウト戦略」節を 2 モード対応に更新 |

---

## 7. 実装完了条件（Definition of Done）

- [ ] 上記 Step 1〜9 が全て完了している
- [ ] 既存の `bun test` が全て pass
- [ ] 新規追加したテストが pass
- [ ] 検証手順 1〜6 を手動実行し、全項目の期待値を満たすログ/スクショが runs 配下に残っている
- [ ] docs/spec と CLAUDE.md が新レイアウトに整合している
- [ ] `cmux-team start`（フラグなし）が破壊的変更なく起動する（後方互換確認）
