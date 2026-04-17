# T207 実装計画 — paneId 永続化を廃止し surface → pane を on-demand 解決に統一する

- Task: T207
- Run: task-207-1776243788
- Author: planner
- Worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-207-1776243788`

---

## 1. 課題分析

### 1.1 現状

`ConductorState.paneId` は team.json に永続化され、以下 5 経路で取り回されている。

| # | 場所 | 用途 |
|---|------|------|
| A | `schema.ts:59` (`ConductorRegisteredMessage.paneId`) | キューメッセージのフィールド |
| B | `schema.ts:168` (`ConductorState.paneId`) | in-memory state 型 |
| C | `daemon.ts:564` (initializeLayout 復元) | team.json から `paneId` を読み戻す |
| D | `daemon.ts:836,842` (handleMessage CONDUCTOR_REGISTERED) | message から state へコピー＋ログ |
| E | `daemon.ts:1601` (updateTeamJson) | state から team.json へ書き戻す |
| F | `main.ts:868` (cmdSendMessage CONDUCTOR_REGISTERED) | `--pane-id` CLI 引数から message へ |
| G | `main.ts:517-522` (onFullQuit) | `cmux list-pane-surfaces --pane <paneId>` で pane 内 surface 一括 close |
| H | `main.ts:1583-1645` (cmdSpawnAgent) | team.json 読み出し → fallback で `getPaneForSurface` → `cmux new-surface --pane` |
| I | `conductor.ts:49-67` (`getPaneIdForSurface`) | `cmux tree` パースで surface→pane 解決（cmux.ts の `getPaneForSurface` と完全重複） |
| J | `conductor.ts:101-119` (`launchConductor`) | `paneId` 引数を取り、未指定なら I を呼んで CONDUCTOR_REGISTERED に乗せる |
| K | `conductor.ts:159-209` (`createConductorPanes`) | newSplit 後に I で paneId を引き、`{surface, paneId}[]` を返す |
| L | `conductor.ts:238-281` (`initializeConductorSlots`) | K の結果を J に渡す＋fallback で state にも paneId を入れる |
| M | `conductor.ts:508-524` (`resetConductor`) | `cmux list-pane-surfaces --pane <paneId>` で pane 内 surface を一括 close |
| N | `i18n.ts:126,646` | `--pane-id <pane-id>` ヘルプ文字列 |

### 1.2 根本原因（dual source of truth）

- **真のソース**: cmux daemon が surface→pane mapping を保持しており、`cmux tree` および `cmux list-pane-surfaces` で常に最新値が引ける
- **キャッシュ**: cmux-team は同じ情報を `ConductorState.paneId` として team.json に永続化
- 真のソースとキャッシュを **両方更新する経路はない**（pane 移動は cmux の閉じた世界の操作）

### 1.3 影響範囲（実害）

T207 task.md 記載通り 2026-04-15 に発生:

```
1. C[121] を手動 `CONDUCTOR_REGISTERED --pane-id manual-121` で登録
2. team.json に `paneId: "manual-121"` がキャッシュされる
3. spawn-agent が `cmux new-surface --pane manual-121` を実行
4. 失敗 → `new-split right` フォールバック
5. A[180] が C[121] の pane:70 ではなく別 pane:101 に生成される（レイアウト崩壊）
```

paneId を永続化していなければ、spawn-agent は `getPaneForSurface(C[121])` を呼んで pane:70 を即座に取得でき、ダミー値の影響は受けなかった。

### 1.4 staleness 要因

| 要因 | 説明 |
|-----|------|
| 手動 close-surface 後の pane 統合 | cmux 側で pane が消えると paneId は無効化されるが team.json は古いまま |
| 手動 send_message 経由の dummy 値 | 上記実害ケース |
| pane 移動（将来機能） | cmux で surface を別 pane に move した場合 |
| 起動時の `getPaneIdForSurface` 失敗 | tree パース失敗時に paneId が undefined のまま永続化 |

→ いずれも「永続化を廃止して必要時に都度引く」だけで解消する。

---

## 2. 技術アプローチ

### 2.1 採用方針: 方針 A（フィールド完全削除）

**`ConductorState.paneId` および `ConductorRegisteredMessage.paneId` を完全削除する。** 必要箇所では `cmux.getPaneForSurface(surface, workspace)` を on-demand 呼び出す。

#### 方針 B（キャッシュ扱い）を採らない理由

| 観点 | 方針 A（削除） | 方針 B（キャッシュ） |
|------|--------------|---------------------|
| 実害の根治性 | dummy 値が混入する経路自体を消す | キャッシュ層に validation ロジックが必要 → バグの温床 |
| 二重ソースの解消 | 完全に解消 | 残る（読み取り側で常に validate しないと意味がない） |
| 実装複雑度 | 単純 | キャッシュ無効化 + stale 検出 + 再解決 のロジックが必要 |
| 性能インパクト | spawn-agent / resetConductor 時に `cmux tree` 1 回（数 ms） | キャッシュヒット時 0 回 |
| 性能の重要度 | 低（spawn-agent / resetConductor は秒〜分単位の操作） | — |

→ **A 一択。** 性能が問題になる頻度ではない。

### 2.2 サブ方針: 1 cmd で済ませる経路の確認

タスク文書「`cmux list-pane-surfaces --pane <paneId>` の代替が 1 cmd で済むか 2 段階か」への回答:

- **spawn-agent**: surface→pane 解決のみ必要 → `getPaneForSurface(surface)` 1 cmd で OK
- **resetConductor / onFullQuit**: 「Conductor surface と同じ pane に属する全 surface」を列挙 → 2 段階必要だが、`cmux tree` 1 回で **両方の情報を取得可能**

そこで `cmux.ts` に **新ヘルパー `listSiblingSurfaces(surface, workspace)`** を導入する:

```ts
// cmux tree を 1 回だけ呼び、surface が属する pane の全 surface を返す
export async function listSiblingSurfaces(surface: string, workspace?: string): Promise<string[]>
```

これにより:
- `getPaneForSurface` + `listPaneSurfaces` の 2 コマンド呼び出しを 1 コマンドに集約
- 呼び出し側は paneId を意識しない
- 既存 `listPaneSurfaces` は内部用途で残す（or 削除可能だが一旦残す）

### 2.3 既存パターンとの整合性

| 既存パターン | T207 での適用 |
|------------|--------------|
| `state.workspace` を daemon 内で取得・伝播（`main.ts:543-563`） | `initializeLayout` / `resetConductor` に `workspace` 引数を追加 |
| spawn-agent (CLI process) で `cmux.getCallerWorkspace()` を呼ぶ | spawn-agent 側はそのまま（state 不在のため） |
| `getPaneForSurface(surface, workspace)` (cmux.ts:155) | 既に存在 — そのまま使う。`conductor.ts:51` の重複定義 `getPaneIdForSurface` は削除 |
| ヘルパーを cmux.ts に集約 | `listSiblingSurfaces` を cmux.ts に追加 |

### 2.4 workspace 引数の伝播経路

```
cmdStartDaemon (main.ts:543-563)
  └─> state.workspace = await cmux.getCallerWorkspace()
        ├─> initializeLayout(state, ...)               [state.workspace を内部で参照]
        │     └─> initializeConductorSlots(... layout)  [既存シグネチャ — workspace を追加]
        │           └─> createConductorPanes(...)       [paneId を返さなくなる]
        │           └─> launchConductor(projectRoot, surface, workspace?)  [paneId 引数削除]
        ├─> handleMessage(... CONDUCTOR_REGISTERED)    [paneId フィールド廃止]
        └─> resetConductor(conductor, projectRoot, workspace?)  [新規引数]

cmdSpawnConductor (main.ts:1552)        [独立 CLI process — daemon の state なし]
  └─> launchConductor(projectRoot, surface)             [workspace 不要 — getCallerWorkspace を内部で]

cmdSpawnAgent (main.ts:1560)            [独立 CLI process — daemon の state なし]
  └─> cmux.getCallerWorkspace() を従来通り直接呼ぶ
  └─> cmux.getPaneForSurface(conductorSurface, workspace) で都度解決
```

---

## 3. 変更対象

| ファイル | 変更概要 | 行数の目安 |
|---------|---------|------------|
| `skills/cmux-team/manager/schema.ts` | `ConductorRegisteredMessage.paneId` 削除 / `ConductorState.paneId` 削除 | -3 / +0 |
| `skills/cmux-team/manager/cmux.ts` | `listSiblingSurfaces(surface, workspace)` 追加 / `listPaneSurfaces` は内部用に残置 | +20 |
| `skills/cmux-team/manager/conductor.ts` | `getPaneIdForSurface` 削除 / `launchConductor` から `paneId` 引数削除 / `createConductorPanes` の戻り値型を `string[]` に変更 / `initializeConductorSlots` のフォールバックから paneId 削除 / `resetConductor` を `listSiblingSurfaces` に切替・`workspace` 引数追加 | -30 / +10 |
| `skills/cmux-team/manager/daemon.ts` | `initializeLayout` 復元処理から `paneId: c.paneId` 削除 / handleMessage CONDUCTOR_REGISTERED から paneId 削除 / `updateTeamJson` から paneId 削除 / `resetConductor` 呼び出し 3 箇所に `state.workspace` を追加 | -5 / +5 |
| `skills/cmux-team/manager/main.ts` | onFullQuit を `listSiblingSurfaces` に切替 / cmdSendMessage CONDUCTOR_REGISTERED から `pane-id` 引数削除 / cmdSpawnAgent の paneId 経路を `getPaneForSurface` 単発呼び出しに統一（team.json 読み出し削除） | -25 / +10 |
| `skills/cmux-team/manager/i18n.ts` | `--pane-id <pane-id>` ヘルプ行削除（en/ja） | -2 |
| `skills/cmux-team/manager/conductor.test.ts` | `createConductorPanes` の戻り値型変更に追従（`panes[0]!.surface` のみ参照しているテストはそのまま動く想定） | 0〜-5 |

合計: 約 **-65 / +50 行**（差し引き 15 行減）

### 3.1 削除されるが互換は不要な箇所

- team.json から `paneId` フィールドが消える → 後方互換は考慮不要（task.md に明記、起動時に再構築される）
- `cmdSendMessage --pane-id` 引数 → 互換不要（`CONDUCTOR_REGISTERED` は内部経路用）

---

## 4. サブタスク分割

> **制約**:
> - **並列実装禁止**: 旧 paneId と新 on-demand を共存させない。下記サブタスクはトップダウンで一括 PR 化する
> - **削除タスク必須**: `getPaneIdForSurface` / `--pane-id` ヘルプなど、不要になったコードは明示的に削除する

### S1. cmux.ts に listSiblingSurfaces を追加

- **対象**: `skills/cmux-team/manager/cmux.ts`
- **内容**: `cmux tree` を 1 回呼び、surface が属する pane 内の全 surface (`surface:NNN` 文字列の配列) を返すヘルパーを追加する
- **完了条件**:
  - `export async function listSiblingSurfaces(surface: string, workspace?: string): Promise<string[]>` が存在
  - 内部実装は `tree(workspace)` 1 回で完結
  - 失敗時は `log("error", ...)` を出して `[]` を返す
- **検証**: `rg "export async function listSiblingSurfaces" skills/cmux-team/manager/cmux.ts`

### S2. conductor.ts の重複ヘルパー getPaneIdForSurface を削除

- **対象**: `skills/cmux-team/manager/conductor.ts:49-67`
- **内容**: `getPaneIdForSurface` と `// --- paneId 取得ヘルパー ---` セクションを完全削除（`cmux.getPaneForSurface` がすでに同等機能を持つ）
- **完了条件**: ファイル内に `getPaneIdForSurface` が存在しない
- **検証**: `rg "getPaneIdForSurface" skills/cmux-team/manager/` → 0 件

### S3. createConductorPanes の戻り値から paneId を削除

- **対象**: `skills/cmux-team/manager/conductor.ts:159-210`
- **内容**:
  - 戻り値型を `Promise<{ surface: string; paneId?: string }[]>` → `Promise<string[]>` に変更
  - `panes.push({ surface: s, paneId: ... })` を `panes.push(s)` に変更
  - `getPaneIdForSurface` の呼び出しを全削除
- **完了条件**:
  - 関数シグネチャが `Promise<string[]>`
  - 関数本体に `paneId` 文字列が出現しない
- **検証**:
  - `rg "createConductorPanes" skills/cmux-team/manager/conductor.ts` で型を確認
  - `rg "paneId" skills/cmux-team/manager/conductor.ts` → 0 件（このサブタスク完了時点で）

### S4. launchConductor から paneId 引数を削除

- **対象**: `skills/cmux-team/manager/conductor.ts:98-148`
- **内容**:
  - シグネチャを `launchConductor(projectRoot, surface, opts?)` に変更（`paneId` 引数削除）
  - `CONDUCTOR_REGISTERED` HTTP POST から `paneId: paneId ?? ""` を削除
  - 「未指定なら getPaneIdForSurface で解決」のフォールバックも完全削除
- **完了条件**:
  - 引数が `(projectRoot, surface, opts?)` の 3 つに固定
  - `paneId` 文字列がこの関数内に出現しない
- **検証**: `rg -A 3 "export async function launchConductor" skills/cmux-team/manager/conductor.ts`

### S5. initializeConductorSlots を新シグネチャに追従

- **対象**: `skills/cmux-team/manager/conductor.ts:214-291`
- **内容**:
  - `for (const [i, pane] of panes.entries())` の `pane.paneId` 参照を全削除（pane は string になる）
  - `launchConductor(projectRoot, pane, ...)` に変更（pane.surface → pane）
  - フォールバック登録時の `paneId: pane.paneId` も削除
- **完了条件**:
  - 関数内で `paneId` が参照されない
  - tsc が通る
- **検証**: `rg "paneId" skills/cmux-team/manager/conductor.ts` → 0 件

### S6. resetConductor を listSiblingSurfaces に切替・workspace 引数を追加

- **対象**: `skills/cmux-team/manager/conductor.ts:502-564`
- **内容**:
  - シグネチャを `resetConductor(conductor, projectRoot, workspace?)` に変更
  - `if (conductor.paneId) { ... listPaneSurfaces ... } else { ... }` の分岐を撤廃
  - 単一経路: `await cmux.listSiblingSurfaces(conductor.surface, workspace)` で同 pane の surface 列を取得し、`s !== conductor.surface` のみ closeSurface
  - 取得失敗時（`[]` 返却時）は agent.surface を個別に閉じる旧フォールバックを残す（safety net）
- **完了条件**:
  - 関数シグネチャに `workspace?: string` がある
  - 関数本体に `paneId` が出現しない
- **検証**:
  - `rg "resetConductor" skills/cmux-team/manager/conductor.ts`
  - `rg "paneId" skills/cmux-team/manager/conductor.ts` → 0 件

### S7. daemon.ts の resetConductor 呼び出しに workspace を渡す

- **対象**: `skills/cmux-team/manager/daemon.ts:1132,1546,1570`
- **内容**: 3 箇所すべて `await resetConductor(conductor, state.projectRoot, state.workspace ?? undefined)` に変更
- **完了条件**: 3 箇所すべて 3 引数化
- **検証**: `rg "resetConductor\(" skills/cmux-team/manager/daemon.ts` → 全行 `state.workspace` を含む

### S8. daemon.ts handleMessage CONDUCTOR_REGISTERED から paneId 削除

- **対象**: `skills/cmux-team/manager/daemon.ts:833-844`
- **内容**:
  - `paneId: message.paneId` 行を削除
  - ログから `pane=${message.paneId}` を削除（Conductor surface のみログ）
- **完了条件**: handleMessage CONDUCTOR_REGISTERED ブロックに `paneId` が出現しない
- **検証**: `rg -A 8 "case \"CONDUCTOR_REGISTERED\"" skills/cmux-team/manager/daemon.ts | rg paneId` → 0 件

### S9. daemon.ts initializeLayout 復元処理から paneId 削除

- **対象**: `skills/cmux-team/manager/daemon.ts:556-569`
- **内容**: `restoredConductor` オブジェクト構築時の `paneId: c.paneId` 行を削除
- **完了条件**: `restoredConductor:` 直下に `paneId` がない
- **検証**: `rg "restoredConductor" skills/cmux-team/manager/daemon.ts` → 該当オブジェクトに paneId なし

### S10. daemon.ts updateTeamJson から paneId 削除

- **対象**: `skills/cmux-team/manager/daemon.ts:1592-1610`
- **内容**: `teamJson.conductors = [...].map(c => ({...}))` の `paneId: c.paneId` 行を削除
- **完了条件**: updateTeamJson 内で `paneId` が出現しない
- **検証**: `rg "updateTeamJson" -A 30 skills/cmux-team/manager/daemon.ts | rg paneId` → 0 件

### S11. main.ts onFullQuit を listSiblingSurfaces に切替

- **対象**: `skills/cmux-team/manager/main.ts:515-524`
- **内容**:
  - `if (conductor.paneId)` 分岐を撤廃
  - `cmux.listSiblingSurfaces(conductor.surface, state.workspace ?? undefined)` で surface を列挙して close
- **完了条件**: 該当ブロックに `paneId` / `listPaneSurfaces` が出現しない
- **検証**: `rg "onFullQuit" -A 25 skills/cmux-team/manager/main.ts | rg paneId` → 0 件

### S12. main.ts cmdSpawnAgent の paneId 経路を統一

- **対象**: `skills/cmux-team/manager/main.ts:1582-1645`
- **内容**:
  - team.json から `paneId = conductor?.paneId` を読む箇所を削除
  - paneId 解決を `await cmux.getPaneForSurface(conductorSurface, callerWorkspace)` の単発呼び出しに統一
  - `worktreePath` / `taskId` / `taskTitle` の team.json 読み取りはそのまま残す（paneId とは独立した責務）
  - フォールバック `try/catch` の二段階構造を廃止し、解決失敗時は `paneId === undefined` のまま `cmux.newSurface(undefined)` → `new-split right` への既存フォールバック経路に乗せる
- **完了条件**: cmdSpawnAgent 内で team.json 読み出し直後に `paneId` を取得しない
- **検証**: `rg -A 60 "async function cmdSpawnAgent" skills/cmux-team/manager/main.ts | rg "conductor\\?.paneId"` → 0 件

### S13. main.ts cmdSendMessage CONDUCTOR_REGISTERED から pane-id 引数削除

- **対象**: `skills/cmux-team/manager/main.ts:864-871`
- **内容**: `paneId: getArg("pane-id") ?? ""` を削除（schema.ts でフィールドが消えるため必須）
- **完了条件**: switch case `CONDUCTOR_REGISTERED` に `pane-id` が出現しない
- **検証**: `rg -A 5 'case "CONDUCTOR_REGISTERED"' skills/cmux-team/manager/main.ts | rg "pane-id"` → 0 件

### S14. schema.ts から paneId フィールドを削除

- **対象**: `skills/cmux-team/manager/schema.ts:56-61, 165-170`
- **内容**:
  - `ConductorRegisteredMessage` から `paneId: z.string()` を削除
  - `ConductorState` 型エイリアスから `paneId?: string;` を削除
- **完了条件**: schema.ts に `paneId` が出現しない
- **検証**: `rg paneId skills/cmux-team/manager/schema.ts` → 0 件

### S15. i18n.ts から `--pane-id` ヘルプ行削除

- **対象**: `skills/cmux-team/manager/i18n.ts:126,646`
- **内容**: en / ja 両方の `--pane-id <pane-id>` 行を削除
- **完了条件**: i18n.ts に `pane-id` が出現しない
- **検証**: `rg "pane-id" skills/cmux-team/manager/i18n.ts` → 0 件

### S16. tsc 通過確認

- **対象**: `skills/cmux-team/manager/`
- **内容**: `bunx tsc --noEmit` を実行しエラー 0 件を確認
- **完了条件**: exit 0
- **検証**: `cd skills/cmux-team/manager && bunx tsc --noEmit; echo $?` → 0

### S17. 関連テストの更新

- **対象**: `skills/cmux-team/manager/conductor.test.ts:107-187`
- **内容**:
  - `createConductorPanes` の戻り値型変更により `panes[0]!.surface` が `panes[0]` に変わる必要があるか確認
  - 必要に応じて修正（テストが `pane.paneId` を参照していなければ `panes[0]!` だけ修正で済む）
  - `treeSpy` mock は不要になる可能性があるため整理する
- **完了条件**: `bun test conductor.test.ts` が通る
- **検証**: `cd skills/cmux-team/manager && bun test ./conductor.test.ts; echo $?` → 0

### S18. 全テスト通過確認

- **対象**: `skills/cmux-team/manager/`
- **内容**: `bun test` 全件を実行
- **完了条件**: exit 0、新規失敗 0 件
- **検証**: `cd skills/cmux-team/manager && bun test 2>&1 | tail -20`

### S19. paneId / listPaneSurfaces 残存ゼロ確認

- **対象**: `skills/cmux-team/manager/`
- **内容**: 削除漏れチェック
- **完了条件**:
  - `rg paneId skills/cmux-team/manager/` → 0 件（コメント・ログ含む）
  - `rg "listPaneSurfaces" skills/cmux-team/manager/` の結果が `cmux.ts` の export 1 箇所のみ（または完全 0 件 — S20 で一括判断）
  - `rg "pane-id" skills/cmux-team/manager/` → 0 件
- **検証**: 上記 grep をすべて実行し、結果を plan 末尾の Decision Log に記録

### S20. listPaneSurfaces export 自体の取り扱い決定

- **対象**: `skills/cmux-team/manager/cmux.ts:65-68`
- **内容**: `listSiblingSurfaces` 導入後に `listPaneSurfaces` への呼び出しが 0 件になっていれば、export ごと削除する
- **完了条件**:
  - S19 で外部呼び出し 0 件であれば `listPaneSurfaces` を削除
  - `rg "listPaneSurfaces" skills/cmux-team/manager/` → 0 件
- **検証**: 上記 grep

### S21. E2E 動作確認（手動）

- **対象**: 起動済み cmux-team
- **内容**:
  1. `cmux-team start` で daemon 起動 → team.json に paneId が含まれないこと
  2. 任意のタスクを ready → Conductor が picking → spawn-agent 経由で Agent タブが Conductor と同じ pane 内に作成されること
  3. `cmux-team abort-task` → resetConductor が走り、Agent タブが正しく close されること
  4. daemon 再起動 → conductors_restored ログが出て pane 関連の警告が出ないこと
- **完了条件**: 上記 4 ステップが正常に完了
- **検証**: `cmux-team status` で確認 + `manager.log` を tail

---

## 5. リスク

### 5.1 既存機能への影響

| 機能 | リスク | 緩和策 |
|------|------|--------|
| `reconnectConductors` (initializeLayout 復元) | 復元時に paneId が無いことで何か壊れる可能性 | paneId は実行時にしか参照されないため、復元データから消しても影響なし。次回 spawn-agent / resetConductor で `getPaneForSurface` が呼ばれて解決される |
| `spawn-agent` の race | spawn-agent 中に Conductor pane が move されたら？ | 現状（team.json キャッシュ）でも同 race あり。新方式は **常に最新値を引く** ため race window が短くなる（改善方向） |
| `resetConductor` の race | reset 中に sibling surface が close/move されたら？ | listSiblingSurfaces の結果をスナップショットとして使い、各 `closeSurface` は `.catch(() => {})` で握り潰す（既存パターン） |
| `cmdSendMessage --pane-id` の互換 | 既存スクリプトが `--pane-id` を渡している可能性 | 引数を ignore する形にせず削除する。task.md で「後方互換不要」と明記済み。i18n.ts のヘルプも同時削除 |

### 5.2 エッジケース

| ケース | 挙動 |
|------|------|
| `cmux tree` 失敗（cmux deadlock 等） | `getPaneForSurface` / `listSiblingSurfaces` が `undefined` / `[]` を返す → spawn-agent は `new-split right` フォールバック、resetConductor は agent.surface を個別 close（safety net） |
| `state.workspace` 未設定 | `getPaneForSurface(surface, undefined)` で全 workspace 横断 tree を引く → 別 workspace の surface と衝突する可能性。**daemon 起動時に workspace は確実に取得される（main.ts:543-563）** ため通常は到達しない経路。ログを残しておくことで検知可能 |
| Conductor surface が死亡 (PID dead) | `getPaneForSurface` が undefined を返す → 既存フォールバック経路へ |
| 同名 Conductor が複数 workspace に存在 | workspace 引数を渡すことで隔離される（CLAUDE.md「cmux API 使用上の注意」と整合） |

### 5.3 テスト戦略

| 手段 | 内容 |
|------|------|
| 型チェック | `bunx tsc --noEmit` (S16) — paneId 削除に伴うコンパイルエラーを早期発見 |
| 単体テスト | `bun test` (S18) — `createConductorPanes` テストの戻り値型追従、新規失敗ゼロ確認 |
| 手動 E2E | S21 の 4 ステップ — 実害シナリオを直接踏める唯一の方法 |
| `manager.log` 監視 | `conductor_registered` ログから `pane=...` が消えていることを確認、`getPaneForSurface failed` の発生頻度を観察 |

---

## 6. 既存型エラーの先読み

`bunx tsc --noEmit` を `skills/cmux-team/manager/` で実行した結果（worktree 上、HEAD `d4cda21`）:

```
EXIT=0
（出力なし）
```

**対象ファイル（schema.ts, daemon.ts, main.ts, conductor.ts, cmux.ts）に既存の型エラーは存在しない。**

- 6.1 本タスクで解消すべきエラー: **該当なし**
- 6.2 後続 cleanup に分離すべきエラー: **該当なし**

---

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | 方針 A（フィールド完全削除） vs 方針 B（キャッシュ扱い） | **A** | 実害（dummy 値混入）の根治には源泉削除が必須。性能インパクトは spawn-agent / resetConductor のいずれも秒〜分単位の操作のため `cmux tree` 1 回追加で問題なし。キャッシュ層を残すと validation の漏れがバグの温床になる |
| D2 | `cmux list-pane-surfaces --pane <paneId>` の代替手段 | **新ヘルパー `listSiblingSurfaces(surface, workspace)` を追加し、`cmux tree` 1 回で済ませる** | 2 段階呼び出し（getPaneForSurface → listPaneSurfaces）にすると tree() コストが 2 倍になる。集約ヘルパーを cmux.ts に置けば呼び出し側は paneId を意識しない |
| D3 | `listPaneSurfaces` を残すか削除するか | **S20 で外部呼び出し 0 件を確認したら削除** | dead code を残す理由がない。残すとしても新規追加禁止のコメントを置く必要があり管理コストが増える |
| D4 | `--pane-id` CLI 引数の互換維持 | **互換維持しない（削除する）** | task.md で明示的に「後方互換は考慮不要」と指示されている。`CONDUCTOR_REGISTERED` は内部経路のため外部スクリプトが叩く想定がない |
| D5 | `resetConductor` への `workspace` 引数追加 vs `state` 全体を渡す | **`workspace?` 引数のみ追加** | 既存シグネチャの破壊を最小化。state 全体を渡すと `conductor.ts` が daemon の内部構造に強く結合する |
| D6 | spawn-agent (CLI process) で `state.workspace` を取れない問題 | **spawn-agent は `cmux.getCallerWorkspace()` を従来通り直接呼ぶ** | spawn-agent は別プロセスで daemon state にアクセスできないため。`callerWorkspace` 取得は既に行われており追加コストなし |
| D7 | `getPaneIdForSurface` (conductor.ts) と `getPaneForSurface` (cmux.ts) の重複 | **`conductor.ts` 側を削除し、`cmux.ts` 側に統一** | cmux 関連ヘルパーは cmux.ts に集約するのが既存パターン。conductor.ts の方は workspace 引数を取らないため API として不完全 |
| D8 | 段階的廃止 vs 一括削除 | **一括削除（task.md の「並列実装禁止」制約に準拠）** | 旧 paneId と新 on-demand を共存させると意図しないキャッシュ参照が残る危険がある |

---

## 8. 完了判定チェックリスト

- [ ] S1〜S20 すべて完了
- [ ] `rg paneId skills/cmux-team/manager/` → 0 件
- [ ] `rg "pane-id" skills/cmux-team/manager/` → 0 件
- [ ] `rg listPaneSurfaces skills/cmux-team/manager/` → 0 件
- [ ] `bunx tsc --noEmit` exit 0
- [ ] `bun test` 全件 pass
- [ ] S21 手動 E2E 完了
- [ ] team.json から `paneId` フィールドが消えていること（`jq .conductors[0] .team/team.json` で確認）
