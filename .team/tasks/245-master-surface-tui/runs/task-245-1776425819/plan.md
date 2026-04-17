# T245 実装計画: Master surface が失われた際に TUI から安全に削除する仕組み

## 1. 課題分析

### 現状の挙動

1. Master の `SESSION_ENDED (reason != "other")` または `spawnMasterPidWatcher` の PID 死亡検出で
   `master.status = "disconnected"`、`disconnectedAt = now`、`pid = undefined` に遷移。
   永続ファイル `.team/masters/<surface>.json` にも `disconnected` が書き出される。
2. `state.masters` エントリは **削除されない**。TUI (`dashboard.tsx:buildMasterSection`) は
   `⚠ [surfaceId] disconnected` を表示し続ける。
3. `pid === undefined` なので `spawnMasterPidWatcher` は動かない。復帰の見込みもないのに
   `state.masters` / `.team/masters/<surface>.json` / `team.json.masters[]` に残る。

### 実害

- `~/git/Dear` で `surface:67` が disconnected のまま残存（実例）。
- 複数 Master 並行運用（T229/T230）を長期運用すると `disconnected` エントリが蓄積する。
- `team.json.masters[]` に幽霊エントリが残ると、下流で `masters[0]` を参照するコードが
  誤った surface を参照するリスクがある（現状は全要素を使う実装なので即時障害はない）。

### 本質

**disconnected は「一時断」と「永久死」を区別できない**ため、即時削除は危険側に倒れ得るが、
一定時間経過後まで待てば「実質死亡」と確信できる。したがって **時間経過による自動 GC** と
**手動強制削除手段**の 2 経路が望ましい。

---

## 2. 技術アプローチ

### 採用案

| 記号 | 対策 | 採用 | 理由 |
|------|------|------|------|
| (a) | 自動 GC（disconnected + pid なしが N 分継続で `removeMaster`） | ✅ | 実害の大部分（幽霊エントリ蓄積）を自動的に解消。既存の `removeMaster` と `monitorConductors` tick ループに乗せれば 20 行程度で実装可能 |
| (b) | `cmux tree` で surface 生存確認して即削除 | ❌ | `CLAUDE.md` の「T195 以降 `cmux tree` 依存は完全撤廃」に反する。main thread deadlock リスクも復活させない |
| (c) | TUI キー操作で dismiss | ⏸ | 本タスクでは見送り。Master 行の focus 追加が必要で AppState 変更も伴うため、(a)+(d) で実害が解消する見込みを確認してから別タスクで検討 |
| (d) | CLI `cmux-team forget-master --surface <id>` で手動削除 | ✅ | 手動復旧手段として必須。実装は 30 行程度。自動 GC timeout を待たずに即時クリアしたい運用ケース（開発中に意図的に pane close した等）に対応 |

### 削除後の復帰リスク

- **surface ID は cmux 側で close 後に再利用されない** ため、同 ID で Master が再作成される
  ことはない。ペインを新しく立ち上げた場合は新しい surface ID になる。
- 削除後に新しい pane から `cmux-team spawn-master` すると `cmdLaunchMaster → registerSelfAsMaster`
  → `MASTER_REGISTERED` handler で別 entry が新規登録されるため、entry 消失は再生を阻害しない。
- `removeMaster` は `pidWatcherInterval` の `clearInterval` も実行するため、timer leak は発生しない。

### state.masters 削除と team.json の同期

- `updateTeamJson()` (daemon.ts:2204) は `[...state.masters.values()]` を毎 tick で書き換える。
  したがって `state.masters.delete(surface)` 直後の `updateTeamJson` 呼び出しで
  `team.json.masters[]` から自動的に除外される。
- `removeMaster` 内の `notifyStateChanged()` により TUI も即時 refresh される。
- **検証コマンド（Sub-task 4 で使用）:**
  ```bash
  # GC 後の team.json 確認
  jq '.masters | length' .team/team.json
  # GC 後の永続ファイル確認（0 件であること）
  ls -la .team/masters/ 2>/dev/null
  # ログで GC 発火確認
  grep -E "master_removed|master_gc_timeout" .team/logs/manager.log | tail
  ```

### 自動 GC パラメータ

| 項目 | 値 | 根拠 |
|------|-----|------|
| timeout (秒) | **600**（10 分） | タスク定義で推奨された値。Conductor の `DISCONNECT_TIMEOUT_SEC=300` と分離することで「Conductor は 5 分で forced close、Master は 10 分で GC」の区別を明確化。Master の方がユーザー対話の拠点なので保守的に長め |
| env 変数名 | `CMUX_TEAM_MASTER_DISCONNECT_TIMEOUT_SEC` | 既存の `CMUX_TEAM_DISCONNECT_TIMEOUT_SEC`（Conductor 用）と対称。流用は避けて独立設定にする |
| tick 間隔 | 既存の `tick()` 間隔に乗る | `CMUX_TEAM_POLL_INTERVAL`（default 10 秒）。別タイマー不要 |
| idle 判定 | GC 判定は disconnected Master が 1 件でもあれば wakeup 対象に含める | idle 化後も disconnected Master の timeout は進み続けるが、`tick` が止まると GC も止まる。今回は idle 化の条件に Master 側の考慮を入れず、**open タスクが無い場合は次の wakeup（TASK_CREATED / hook push）まで GC を保留**する設計とする。disconnect ゴミが残っても運用上の実害は TUI 表示のみで、idle 中の CPU 消費より優先度が低い |

### CLI `cmux-team forget-master` 仕様

```
Usage: cmux-team forget-master --surface <id>

Options:
  --surface <id>    削除対象の surface ID（必須）。形式: surface:NNN
  --help            ヘルプ表示

Exit codes:
  0   削除成功、または対象 surface が既に state に無い（冪等成功）
  1   daemon 未起動、HTTP POST 失敗、引数不正
```

**出力（stdout）:**
- 成功: `OK`（`postMessageAndExit` 既定パターン）
- entry 非存在: `OK (surface:NNN not found, nothing to do)`（冪等扱いで exit 0）
- エラー: `Error: <詳細>`（stderr、exit 1）

**hook ブロック:** 無し（任意の surface から実行可能）。

---

## 3. 変更対象

### 修正ファイル

| ファイル | 内容 |
|---------|------|
| `skills/cmux-team/manager/daemon.ts` | (i) `MASTER_DISCONNECT_TIMEOUT_SEC` 定数追加<br>(ii) `monitorMasters(state)` 関数新設<br>(iii) `tick(state)` から `await monitorMasters(state)` を呼び出し<br>(iv) `handleMessage` の switch に `case "FORGET_MASTER"` を追加 |
| `skills/cmux-team/manager/schema.ts` | `ForgetMasterMessage` の Zod スキーマ追加、`QueueMessage` discriminated union に追加、型 export |
| `skills/cmux-team/manager/main.ts` | (i) `cmdForgetMaster()` 関数追加<br>(ii) `switch (command)` に `case "forget-master"` 追加 |
| `skills/cmux-team/manager/i18n.ts` | `help_forget_master` キー追加（en/ja） |
| `skills/cmux-team/manager/daemon.test.ts` | GC と FORGET_MASTER のテストケース追加 |
| `skills/cmux-team/manager/main.test.ts` | `cmdForgetMaster` の引数検証テスト追加（他 cmd と同じスタイル） |
| `docs/spec/01-skill-cmux-team.md` | CLI 表に `cmux-team forget-master` 行を追加 |
| `CLAUDE.md` | 「## Manager プロトコル」節に Master GC の記述を追加（timeout・env 変数名） |

### 新規ファイル

無し（全て既存ファイルへの追記）。

### 削除ファイル

無し。

---

## 4. サブタスク分割

### 4.1 Sub-task S1: `monitorMasters` 追加（自動 GC）

**対象ファイル:**
- `skills/cmux-team/manager/daemon.ts`

**実装内容:**
1. `DISCONNECT_TIMEOUT_SEC` 定義（L2066-2067）の直下に追加:
   ```ts
   /** Master disconnected 状態の GC timeout（秒）— 超過で removeMaster */
   const MASTER_DISCONNECT_TIMEOUT_SEC =
     Number(process.env.CMUX_TEAM_MASTER_DISCONNECT_TIMEOUT_SEC) || 600;  // 10 分
   ```
2. `monitorConductors` の直後に `monitorMasters` を新設:
   ```ts
   /**
    * Master の GC 判定 — disconnected が MASTER_DISCONNECT_TIMEOUT_SEC を超えたら
    * `removeMaster` で state + 永続ファイルから削除する。
    *
    * - disconnectedAt が無い disconnected Master は保守的に skip（次 tick で `SESSION_ENDED`
    *   再到達を待つ）
    * - removeMaster は idempotent。timer stop / 永続ファイル削除 / log / notify までやる
    */
   export async function monitorMasters(state: DaemonState): Promise<void> {
     for (const [surface, master] of state.masters) {
       if (master.status !== "disconnected") continue;
       if (!master.disconnectedAt) continue;
       const elapsed = (Date.now() - new Date(master.disconnectedAt).getTime()) / 1000;
       if (elapsed > MASTER_DISCONNECT_TIMEOUT_SEC) {
         await log(
           "master_gc_timeout",
           `${formatSurface(surface, "U")} elapsed=${Math.round(elapsed)}s`
         );
         await removeMaster(state, surface, "gc_timeout");
       }
     }
   }
   ```
3. `tick(state)` 内の `await monitorConductors(state);` の直後に `await monitorMasters(state);` を追加。

**完了条件:**
- `bunx tsc --noEmit` エラー無し
- `daemon.test.ts` の `describe("master GC", ...)` が全 pass

**メソッド制約:**
- `removeMaster` を直接呼ぶこと（`state.masters.delete` や `deleteMasterFile` を手動で組み合わせない）
- `CLAUDE.md` の EventBus ポリシーに従い、`notifyStateChanged` は `removeMaster` 内の 1 箇所に集約（D3 維持）
- 新規 `bus.emit` / `bus.on` 追加は禁止

**検証コマンド:**
```bash
cd skills/cmux-team/manager && bun test daemon.test.ts -t "master GC"
```

### 4.2 Sub-task S2: `FORGET_MASTER` メッセージ定義

**対象ファイル:**
- `skills/cmux-team/manager/schema.ts`
- `skills/cmux-team/manager/daemon.ts`

**実装内容（schema.ts）:**
```ts
export const ForgetMasterMessage = z.object({
  type: z.literal("FORGET_MASTER"),
  surface: z.string(),
  timestamp: z.string().datetime(),
});

// discriminatedUnion の配列末尾に追加
export const QueueMessage = z.discriminatedUnion("type", [
  // ... 既存 ...
  ForgetMasterMessage,
]);

export type ForgetMasterMessage = z.infer<typeof ForgetMasterMessage>;
```

**実装内容（daemon.ts `handleMessage` switch）:**
```ts
case "FORGET_MASTER": {
  const master = state.masters.get(message.surface);
  if (!master) {
    await log(
      "forget_master_skipped",
      `${formatSurface(message.surface, "U")} reason=not_found`
    );
    break;
  }
  await log(
    "forget_master_requested",
    `${formatSurface(message.surface, "U")} status=${master.status}`
  );
  await removeMaster(state, message.surface, "forget_master_cli");
  break;
}
```

**完了条件:**
- `bunx tsc --noEmit` エラー無し
- daemon.test.ts の新規テスト `FORGET_MASTER handler` が pass

**メソッド制約:**
- `state.masters.get` の有無に関わらず `removeMaster` の内部で idempotent に扱えるが、**先に ensure して
  `forget_master_skipped` を明示ログ**する（後から「なぜ消えた/消えなかった」を追えるようにする）
- `status === "running"` / `"idle"` であっても本メッセージが来たら削除する（強制削除は設計上許容）。
  ただし **running の Master を殺しても安全な方へ倒さない**（プロセスを kill しない）。
  後始末は CLI 側に任せる。将来 running 時に拒否したくなったらフラグで拡張する。
- `status === "running"` の Master を消した後に永続ファイルのみ再生成される副作用は無い（
  `SESSION_STARTED` / `MASTER_REGISTERED` handler は `state.masters` が空の状態から再構築する）

**検証コマンド:**
```bash
cd skills/cmux-team/manager && bun test daemon.test.ts -t "FORGET_MASTER"
```

### 4.3 Sub-task S3: `cmux-team forget-master` CLI 実装

**対象ファイル:**
- `skills/cmux-team/manager/main.ts`
- `skills/cmux-team/manager/i18n.ts`

**実装内容（main.ts）:**
```ts
async function cmdForgetMaster(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_forget_master"));
  const surfaceArg = requireArg("surface");
  // surface:NNN 形式の軽い正規化（cmdSpawnAgent と同様に normalizeSurfaceArg を流用）
  let surface: string;
  try {
    surface = await normalizeSurfaceArg(surfaceArg);
  } catch (e: any) {
    console.error(`Error: ${e?.message ?? e}`);
    process.exit(1);
  }
  await postMessageAndExit({
    type: "FORGET_MASTER",
    surface,
    timestamp: new Date().toISOString(),
  });
}
```

**実装内容（main.ts switch）:**
`case "spawn-master":` の直後に以下を挿入:
```ts
case "forget-master":
  await cmdForgetMaster();
  break;
```

**実装内容（i18n.ts）:** 既存の `help_abort_task` と同様の形式で `help_forget_master` を en/ja 両方に追加。
内容は上記「CLI 仕様」ブロックに記載した Usage 文字列。

**完了条件:**
- `cmux-team forget-master --help` が使い方を表示する
- `cmux-team forget-master --surface surface:9999`（非存在）が exit 0 で `OK` を出力する
- `cmux-team forget-master --surface <disconnected master>` を 1 回実行後、
  `jq '.masters' .team/team.json` で配列から消えている

**メソッド制約:**
- `postMessageAndExit` を使う（他 CLI と一貫）
- 引数検証ロジックを daemon 側に持ち込まず、CLI 側で `requireArg` + `normalizeSurfaceArg` のみ
- ヘルプ文は i18n.ts 経由（ハードコード禁止）

**検証コマンド:**
```bash
# daemon 稼働前提
cmux-team forget-master --help
cmux-team forget-master --surface surface:9999  # 冪等成功
# disconnected master を用意してから:
jq '.masters' .team/team.json                    # 削除確認
grep "forget_master" .team/logs/manager.log | tail
```

### 4.4 Sub-task S4: テスト追加

**対象ファイル:**
- `skills/cmux-team/manager/daemon.test.ts`
- `skills/cmux-team/manager/main.test.ts`（軽い引数検証のみ）

**daemon.test.ts — 追加する describe ブロック:**

```ts
describe("master GC (T245)", () => {
  test("disconnected + disconnectedAt 古い → removeMaster が走る", async () => {
    // state.masters に disconnected + disconnectedAt=15分前 を用意
    // monitorMasters(state) を呼ぶ
    // expect state.masters.has(surface) を false
    // expect .team/masters/surface_XXX.json が unlink されている
    // expect log に master_gc_timeout + master_removed が出ている
  });
  test("disconnected + disconnectedAt 未経過 → 残る", async () => {
    // state.masters に disconnected + disconnectedAt=1分前 を用意
    // monitorMasters(state) を呼ぶ
    // expect state.masters.has(surface) を true
  });
  test("disconnectedAt が無い disconnected → skip（保守的）", async () => {
    // disconnectedAt undefined
    // monitorMasters(state) を呼ぶ
    // expect state.masters.has(surface) を true
  });
  test("status=running/idle の Master は GC 対象外", async () => {
    // running な master を用意
    // monitorMasters(state) を呼ぶ
    // expect state.masters.has(surface) を true
  });
  test("GC 後の updateTeamJson で masters 配列から除外される", async () => {
    // GC 走行後に updateTeamJson(state) を呼んで team.json を読む
    // expect teamJson.masters.length === 0
  });
});

describe("FORGET_MASTER handler (T245)", () => {
  test("既存 master を削除できる", async () => { /* ... */ });
  test("存在しない surface は forget_master_skipped ログで冪等 skip", async () => { /* ... */ });
  test("running master も強制削除できる（許容）", async () => { /* ... */ });
});
```

**main.test.ts — 追加するテスト:**
- `cmux-team forget-master` を `--surface` 無しで実行 → exit 1 + stderr
- `cmux-team forget-master --help` → help が表示される

**完了条件:**
- 追加したテスト全部 pass
- 既存テストに regression 無し（`bun test` 全体を流す）

**メソッド制約:**
- テスト内で daemon HTTP API を起動しない。`handleMessage(state, msg)` / `monitorMasters(state)` を
  直接呼ぶユニットテスト形式（既存テストと同様）。
- 時間経過シミュレーションは `disconnectedAt` を過去時刻にずらす方式（`Date.now()` mock せず実時間で判定）。

**検証コマンド:**
```bash
cd skills/cmux-team/manager && bun test
```

### 4.5 Sub-task S5: docs/spec と CLAUDE.md の更新

**対象ファイル:**
- `docs/spec/01-skill-cmux-team.md`
- `CLAUDE.md`

**docs/spec/01-skill-cmux-team.md:**
- L62 の CLI サブコマンド表に `cmux-team spawn-master` 行の直後を追加:
  ```
  | `cmux-team forget-master` | Master の state エントリを強制削除（`--surface` 必須）。state.masters から除去 + `.team/masters/<surface>.json` 削除 + PID watcher 停止。既に非存在なら冪等 success（exit 0）。自動 GC（`MASTER_DISCONNECT_TIMEOUT_SEC`=10分）を待たずに即時クリアしたい運用向け（T245）|
  ```

**CLAUDE.md — 「## Manager プロトコル」内の「### Conductor 監視（push + PID）」直後に追加:**
```markdown
### Master GC（disconnected 状態の自動回収）

`SESSION_ENDED`（reason != other）または PID watcher の pid 死亡検出で Master は
`status = "disconnected"` に遷移する。disconnected のまま `disconnectedAt` から
`MASTER_DISCONNECT_TIMEOUT_SEC`（デフォルト 600 秒＝10 分、env で上書き可）を超過すると、
`monitorMasters` が自動的に `removeMaster` を呼んで state + `.team/masters/<surface>.json` から削除する。

- 保守的タイムアウト: Conductor の `DISCONNECT_TIMEOUT_SEC=300` よりも長い 600 秒。Master は
  ユーザー対話の拠点であり、一時的な切断（OS sleep・ネットワーク断など）を誤って削除しないため。
- 手動強制削除: `cmux-team forget-master --surface <id>` で即時削除可能（T245）。
- 削除後の復帰: surface ID は cmux 側で close 後に再利用されないため、同 ID で資源競合は起きない。
  新しい pane から `cmux-team spawn-master` を実行すれば別 surface ID で新規登録される。
```

**完了条件:**
- `docs/spec/01-skill-cmux-team.md` の CLI 表に新行が載っている
- `CLAUDE.md` に Master GC セクションが追加されている
- 実装との乖離を `/docs-sync` で再チェックして passed

**メソッド制約:**
- ユーザー向け文言は日本語
- env 変数名は `CMUX_TEAM_MASTER_DISCONNECT_TIMEOUT_SEC` 固定（他の命名の flex 禁止）
- Conductor の GC 説明に Master 向けの記述を混ぜない（節を分ける）

**検証コマンド:**
```bash
cmux-team forget-master --help    # 表示内容が docs と一致すること（手動確認）
grep -c "MASTER_DISCONNECT_TIMEOUT_SEC" CLAUDE.md docs/spec/01-skill-cmux-team.md
```

### 4.6 実装順序

**並列実装は禁止。以下の依存順で直列に進める:**

1. **S1** (monitorMasters 追加) — schema 変更を伴わない純粋な追加。単独で動作確認可能
2. **S2** (FORGET_MASTER schema + handler) — schema.ts の discriminatedUnion に追加
3. **S3** (CLI 追加) — S2 の schema/handler を呼び出す
4. **S4** (テスト追加) — S1-S3 の実装をカバーするテストを書く
5. **S5** (docs 更新) — 実装が固まった後に記述を反映

**旧実装と新実装の並行禁止:** 既存の `removeMaster` を変えない。GC 経路と CLI 経路の両方ともこの
共通関数を呼ぶだけ。並行する「別の削除関数」を作らない。

---

## 5. リスク

### 5.1 既存機能への影響

| 影響範囲 | リスク | 緩和 |
|---------|--------|------|
| `tick()` ループ負荷 | `monitorMasters` を毎 tick で呼ぶ | `state.masters.size` は通常 1–3、for ループ自体は O(n) で軽量。`disconnectedAt` 未設定は即 continue |
| `team.json` 連続書き換え | GC 発火時に `notifyStateChanged` → tick 内の `updateTeamJson` が走る | 既存の同じ契約（Conductor の `forceCloseDisconnectedConductor`）と同等のパターン。追加の I/O 爆発はない |
| 複数 Master 運用 | 同時に複数 Master が disconnected になった場合 | for ループで順次削除される。race は Map iteration で保護される（handleMessage は await で serialize） |
| 既存 Conductor GC と混同 | `DISCONNECT_TIMEOUT_SEC` を流用したい誘惑 | env 変数名を分離（`CMUX_TEAM_MASTER_DISCONNECT_TIMEOUT_SEC`）、ログイベント名も `master_gc_timeout` と `conductor_disconnect_timeout` で区別 |

### 5.2 エッジケース

1. **disconnectedAt が stale な古い値を持つケース**（旧バージョンで永続化されたファイル）
   - `restoreMasters` で pid dead なら即 discard される設計なので、disconnected + 古い disconnectedAt
     の組み合わせは実質発生しない
   - 発生した場合も `monitorMasters` が即 GC するため問題なし
2. **pane close 直後（1 分以内）に ユーザが同じ Master を再開したいケース**
   - 10 分 timeout の間、TUI には disconnected が見え続ける。ユーザは待てないなら `forget-master` CLI で強制削除
   - 2026-04 時点の UX では「忘れ去る」方向で十分。気になるなら将来 option (c) の TUI キー操作を検討
3. **OS スリープ復帰直後の大量 disconnected イベント**
   - 全て timeout 600 秒待ってから個別 GC される。TUI には一時的に ⚠ が並ぶが、GC 済みのものから順次消える
   - 緩和: ユーザが先に `forget-master` を流してもよい（冪等）
4. **running / idle 状態の Master を `forget-master` で消したケース**
   - プロセスは生きたまま state からだけ消える。次回 `SESSION_STARTED` or `MASTER_REGISTERED` hook が来れば再登録される（`persistMasterFile` も再生成）
   - ただし pid watcher は removeMaster で clearInterval されるので、次の SESSION_STARTED まで pid
     死亡検出できない期間が生じる → **許容**（強制削除の副作用として受け入れる）
5. **`.team/masters/` ディレクトリごと消えているケース**
   - `deleteMasterFile` は try/catch で冪等（catch 空は master.ts の既存実装）
   - `listMasterFiles` もディレクトリ不在で空配列を返す

### 5.3 テスト戦略

- **ユニットテスト**: `monitorMasters` と `handleMessage(FORGET_MASTER)` を直接呼ぶ
  （daemon.test.ts の既存パターンに倣う）
- **時間制御**: `disconnectedAt` を過去時刻にセットする方式。`Date.now()` を差し替えない
- **E2E テスト**: 手動のみ。`cmux-team start` → 別 pane で `cmux-team spawn-master` →
  pane を close → 10 分待機 → `jq .masters .team/team.json` で空配列確認。
  10 分待てないので env `CMUX_TEAM_MASTER_DISCONNECT_TIMEOUT_SEC=60` で短縮して検証する
- **レグレッション**: 既存 `bun test` を全体流して Conductor GC / Master restore テストが
  影響を受けないことを確認

---

## 6. 既存型エラーの先読み

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-245-1776425819/skills/cmux-team/manager
bunx tsc --noEmit 2>&1 | grep -E "^(daemon\.ts|main\.ts|dashboard\.tsx)" || true
```

**結果: エラー 0 件。** 本タスクで新規導入するコードが型通過するかは実装中に逐次
`bunx tsc --noEmit` で確認する。

後続タスク cleanup に倒すべき既存エラーは無し。

---

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | GC 発火時間 | 600 秒（10 分） | タスク定義の推奨。Conductor の 300 秒より保守的で、OS sleep や短時間のネットワーク断を誤検出しない |
| D2 | env 変数名 | `CMUX_TEAM_MASTER_DISCONNECT_TIMEOUT_SEC`（独立） | Conductor の `CMUX_TEAM_DISCONNECT_TIMEOUT_SEC` と流用すると運用時の誤解を招く。役割別の独立設定にする |
| D3 | 削除手段 | 自動 GC + CLI のみ（TUI キー操作は別タスク） | (a)+(d) で実害（幽霊エントリ蓄積）は解消する。TUI キー操作は AppState 拡張を伴い、フィードバックが出てから設計する方が安い |
| D4 | CLI 冪等性 | 非存在 surface も exit 0 | 運用スクリプトから冪等に呼べるため。既存 `deleteMasterFile` が冪等設計なのと整合 |
| D5 | `cmux tree` で生存確認 | 不採用 | `CLAUDE.md`「T195 以降 `cmux tree` 依存は撤廃」に反する。main thread deadlock（A011）リスク再燃を避ける |
| D6 | running Master の CLI 強制削除 | 許容（kill しない） | state 除去のみ。プロセスは生かしたまま SESSION_STARTED で再登録され得る。kill まで踏み込むのは別タスク |
| D7 | `removeMaster` の共通化 | 既存関数を流用、新規 delete 関数は作らない | `removeMaster` は `clearInterval + state.masters.delete + deleteMasterFile + log + notifyStateChanged` を既に実装した完成品。D3 守護（state mutation 箇所の集約）にも整合 |
| D8 | GC ログイベント名 | `master_gc_timeout`（発火）+ `master_removed`（既存、削除完了） | Conductor 側の `conductor_disconnect_timeout` / `forced_closed` の命名と対称。トレース時に grep しやすい |
| D9 | TUI 表示の追加変更 | 無し | `buildMasterSection` は `state.masters` から描画するだけなので、GC で state から消えれば自動的に表示も消える（`⚠ disconnected` 行が不在になる） |
| D10 | 永続ファイルだけ残る case | 発生しない | `removeMaster` が `state.masters.delete` と `deleteMasterFile` を両方実行するため、state と disk は必ず同期する。途中 catch は log 出力のみで全体の流れは続行する（既存実装準拠） |

---

## 8. 完了条件（タスク全体）

- [ ] Sub-task S1: `monitorMasters` が `tick()` から呼ばれ、disconnected + timeout で `removeMaster` が走る
- [ ] Sub-task S2: `FORGET_MASTER` メッセージが schema + `handleMessage` に追加されている
- [ ] Sub-task S3: `cmux-team forget-master --surface <id>` CLI が動く（冪等含め）
- [ ] Sub-task S4: daemon.test.ts / main.test.ts の新規テストが全 pass、既存テストに regression 無し
- [ ] Sub-task S5: `docs/spec/01-skill-cmux-team.md` と `CLAUDE.md` に反映
- [ ] 本 plan.md で決めた方針をもとに、Conductor が完了処理で artifact (Axxx, type=decision) を登録する
  （**plan.md 自体は artifact ではない — artifact は Conductor が closing で作成する**）

## 9. 出力先

- 本計画書: `/Users/yamamoto/git/cmux-team/.team/tasks/245-master-surface-tui/runs/task-245-1776425819/plan.md`
- 作業 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-245-1776425819/`（ここに plan.md は作らない）
