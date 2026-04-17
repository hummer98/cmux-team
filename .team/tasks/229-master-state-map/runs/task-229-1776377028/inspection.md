# Inspection: T229

## Verdict
**GO**

## 受け入れ条件チェック

- [x] `state.masters` が `Map<string, MasterState>` として存在（`daemon.ts:48`）
- [x] `state.masterSurface` / `masterPid` / `masterStatus` / `masterPromptPreview` / `masterPromptAt` / `masterPidWatcherInterval` の **実参照は全て解消**（残留 grep 0 件）
- [x] hook handler（SESSION_STARTED / ENDED / ACTIVE / IDLE / ASK / CLEAR）の 6 箇所が全て `state.masters.get(surface)` / `state.masters.has(surface)` ベースに置換済（`daemon.ts:1012, 1147, 1216, 1288, 1378, 1430`）
- [x] 旧形式 → 新形式の自動マイグレーション実装済（`migrateMasterLayout` `daemon.ts:547`、`.gitignore` 書き換えは `initInfra` 内 `daemon.ts:440-468`）。冪等性あり
- [x] `TaskState.createdBy` / frontmatter `created_by` / artifact `author` が surface ベース（`task.ts:24,35,349,364`, `artifact.ts:180-204`、`CMUX_SURFACE` env 由来）
- [x] `cmdStart` の挙動は従来通り 1 Master spawn（`restoreMasters` で 0 件なら `spawnAndRegisterMaster` が 1 回だけ）
- [x] `docs/spec/00-project-overview.md` / `01-skill-cmux-team.md` / `05-install-and-infrastructure.md` / `CLAUDE.md` 更新済（`.team/masters/` 新セクション追記、artifact author 破壊的変更明記、`team.json.masters` 配列仕様明記）

## 型チェック結果

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
EXIT=0
```

エラー 0 件。

## 残留 grep 結果

```
$ grep -rn 'state\.masterSurface\|state\.masterPid\|state\.masterStatus\|state\.masterPromptPreview\|state\.masterPromptAt\|state\.masterPidWatcherInterval' skills/cmux-team/manager/
→ 0 件
```

旧フラットフィールドへの実参照は完全に解消されている。なお `masterSurface` / `masterPid` の単語自体は以下に残るが、いずれも `state.*` プレフィックス無しでローカル変数・コメント・e2e.ts 内のテスト変数名・log キーであり、要件上問題ない:

- `daemon.ts:46` — コメント（廃止記録）
- `daemon.ts:441-452` — `masterSurfaceIdx`（`.gitignore` 書き換え用のローカル変数名）
- `e2e.ts:46,280-318` — E2E テスト内のローカル変数
- `main.ts:1421` / `main.test.ts:1080` — コメント

## plan.md 対応チェック

| セクション | 対応 | 備考 |
|---|---|---|
| S1 `schema.ts` | ✓ | `MasterStateSchema` / `MasterState` 型追加。`pidWatcherInterval` は intersection で runtime 専用（`schema.ts:149-160`）。logger.ts / cmux.ts 非依存 |
| S2 `master.ts` | ✓ | `spawnMaster` 戻り値 `{ surface, startedAt }`（L105-129）、`normalizeSurfaceForPath` / `persistMasterFile` / `deleteMasterFile` / `listMasterFiles` 新設。`isMasterAlive` 廃止 |
| S3-1〜S3-2 | ✓ | `DaemonState.masters = Map<string, MasterState>`（`daemon.ts:48`）、`createDaemon` で `masters: new Map()` 初期化（L205） |
| S3-3 initInfra | ✓ | 初期 team.json は `masters: []`（L511）、`updateTeamJson` で `delete teamJson.master`（L1958） |
| S3-4 startMaster | ✓ | `restoreMasters` が pid 必須で discard、`proxyPortChanged` 分岐で全 Master を `removeMaster`、0 件なら `spawnAndRegisterMaster`（L702-729） |
| S3-5 hook handler 6 箇所 | ✓ | 全て `state.masters.get(message.surface)` に置換、Master 分岐が先頭に配置され `break` で早期脱出 |
| S3-6 `spawnMasterPidWatcher` | ✓ | `(state, surface, pid): void` シグネチャ。master 不在 race 対策あり（L1812-1815） |
| S3-7 `removeMaster` | ✓ | `daemon.ts:735`。`clearInterval` + `state.masters.delete` + `deleteMasterFile` + log + `notifyStateChanged` を 1 関数に集約 |
| S3-8 `updateTeamJson` | ✓ | `teamJson.masters = [...state.masters.values()].map(...)`、`delete teamJson.master` 毎回実行（L1951-1958） |
| S3-9 サイドバー状態 | ✓ | dashboard.tsx / statusline.ts / proxy.ts で `state.masters.values()` ベース |
| S3-10 stopDaemon の watcher 全停止 | △ | `shutdown()` で個別に `clearInterval` は呼んでいないが `process.exit(0)` 前の `updateTeamJson` のみ。実害なし（プロセス終了で interval は破棄される）。**Minor finding** |
| S4 `migrateMasterLayout` | ✓ | `initInfra` 末尾で 1 回（L530-536）、冪等、team.json.master.pid 拾い上げ、旧 marker unlink、失敗しても daemon 続行 |
| S5 `dashboard.tsx` | ✓ | `buildMasterSection` が masters 配列を iterate してリスト表示（L338-380）。spinner check は「1 つでも running」で判定 |
| S6 `statusline.ts` | ✓ | `StatuslineState.masters: Array<{surface, status?, pid?}>`（L27）、`resolveRole` で `state.masters.some(m => m.surface === surface)` |
| S7 `proxy.ts` /master-state | ✓ | optional `surface`、単一 Master auto-resolve、複数 Master で ambiguous → `master_state_surface_ambiguous` + **HTTP 400**（L265-329） |
| S8 `main.ts` cmdStart / cmdStatus / cmdCreateTask / caffeinate | ✓ | full-quit で `state.masters.keys()` を iterate（L592）、cmdStatus は配列 + 旧オブジェクト両対応（L1055-1081）、cmdCreateTask は `createdBy: process.env.CMUX_SURFACE`（L2321-2322）、caffeinate は `state.masters.values().some(...)`（L779） |
| S9 `task.ts` | ✓ | `TaskMeta.createdBy` / `TaskState.createdBy` / frontmatter `created_by` / parser 対応（L23-24, 35, 62, 349, 364） |
| S10 `artifact.ts` | ✓ | `defaultAuthor = process.env.CMUX_SURFACE ?? "unknown"`、既存 author は `existing.author || defaultAuthor` で後方互換保持（L180-204） |
| S11 `.gitignore` 自動書き換え | ✓ | `initInfra` 内に inline で実装（`daemon.ts:440-468`）。冪等、両方存在すれば旧行削除 |
| S12 docs/spec + CLAUDE.md | ✓ | 00/01/05 と CLAUDE.md 全て更新（`team.json.masters` 配列、`.team/masters/` 新セクション、artifact author 破壊的変更明記） |

## テスト実行結果

```
$ bun test
 414 pass
 0 fail
 861 expect() calls
Ran 414 tests across 20 files. [9.99s]
```

T229 関連の主要テスト（`daemon.test.ts: describe("startMaster restore (T229)")`）:
- pid 生存 → Map に 1 個登録、spawn しない ✓
- pid 死亡 → ファイル discard ✓
- pid 欠落 → ファイル discard ✓

`statusline.test.ts` / `proxy.test.ts` の masters 配列・`/master-state` ambiguous 400・明示 surface 経路テストも通過。

## Minor Findings (GO でも記載)

1. **`normalizeSurfaceForPath` の二重定義**
   - `daemon.ts:104`（T181、Agent/Conductor done 用）: `[^a-zA-Z0-9_-]` → `_` 全置換
   - `master.ts:16`（T229、Master file 用）: `:` のみ `_` に置換
   - 両者は同名だが正規化ルールが異なる。現状 surface は `surface:<数字>` なので実挙動は一致。plan §ファイル名規則では master.ts 版の仕様のみ示しており、命名衝突への言及は無い。将来 surface の命名規則が変わった場合の混乱リスクあり。

2. **`normalizeSurfaceForPath("")` → throw 未実装**
   - plan §ファイル名規則 / `docs/spec/05-install-and-infrastructure.md:385` では「空文字入力は throw」と明記
   - 実装（`master.ts:16-18`）は単純な `replaceAll(":", "_")` で throw しない
   - 実害は低い（空 surface は実運用で出ない）が、docs との乖離あり。`surface.length === 0` チェック + throw を 2 行足すだけ

3. **plan §S3-10 の stopDaemon 全 watcher 停止未実装**
   - plan: graceful shutdown で全 master の `clearInterval` 呼び出し
   - 実装: `shutdown()` は `process.exit(0)` に interval 破棄を任せる
   - Node.js プロセス終了で setInterval ハンドルは回収されるため実害なし。ただし plan 要件と不一致

4. **plan §テスト対象 の normalizeSurfaceForPath 3 ケース未追加**
   - plan §ファイル名規則のテスト対象（`"surface:100"` / `"surface:abc-def"` / `""` → throw）が daemon.test.ts に存在しない
   - 他の T229 restore テストは追加済み

5. **CLAUDE.md `team.json.masters` の項目名不一致**
   - CLAUDE.md: 「各要素は `{ surface, status, startedAt, pid?, lastPromptPreview?, lastPromptAt? }`」と記載
   - 実装（`daemon.ts:1952-1957`）は `{ surface, status, pid, startedAt }` のみで `lastPromptPreview` / `lastPromptAt` は含まれない
   - ドキュメントと実装に乖離あり。実装に合わせて「`{ surface, status, pid?, startedAt }`」へ修正、もしくは `prompt` を team.json にも出力する対応を検討

## Verdict 理由

plan.md の S1〜S12 主要項目は全て実装されており、型チェック・全テスト（414 件）通過、`state.masterX` 残留 0 件、hook handler 6 箇所全て Map ベースに対称化、マイグレーション（ファイル + team.json + .gitignore）冪等実装、/master-state の曖昧時 400、TaskState.createdBy / artifact.author の surface 化まで受け入れ条件を満たしている。

`cmdStart` の外部挙動（1 Master spawn）は維持され、既存 1 Master 運用を壊していないことが確認できる。後方互換パス（`team.json.masters ?? team.json.master → []`）も cmdStatus / e2e.ts に仕込まれており、旧形式 team.json からの読み込みも動作する。

Minor Findings は 5 件あるが、いずれも Critical ではない:
- 1 / 4: 整合性の懸念だが動作に影響しない
- 2: docs と実装の軽微な乖離、`throw` 2 行の追加で解消可能
- 3: plan 要件との不一致だが、Node.js のプロセス終了挙動で実害なし
- 5: ドキュメントの軽微な誤記

総合として T229 の「Master を複数受け入れる基盤整備」の目的は達成されており、T230 での self-register / 複数 spawn 実装の土台として利用可能な状態。**GO** と判定する。
