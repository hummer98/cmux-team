# T192 実装計画: ロガー改善（surface 表記簡略化 + バージョン記録）

> **改訂 (2026-04-14)**: Design Review (Changes Requested) の Blocking 指摘 1〜6 と Non-blocking 指摘 7〜11 を反映。主な変更:
> - **剥がしルールを `surface` 系のみに狭める**（`task_id=` / `conductor_id=` / `artifact_id=` / `agent_id=` は `key=value` 維持）
> - `SurfaceRole` に `"S"` を追加
> - `parseJournalEntries` の更新方針を具体化
> - `formatSurface` の空入力仕様を明記
> - `conductors_restored` の `surfaces=` 形式を決定
> - 置換完全性の grep 手順を必須化

---

## 1. 現状分析

### 1.1 logger.ts
- `skills/cmux-team/manager/logger.ts` は 30 行のシンプルな実装。
- export は `log(event, detail = "")` のみ。フォーマット: `[<localISO>] <event> <detail>`。
- ヘルパー `localISOString()` は内部のみ。

### 1.2 log(...) 呼び出し分布（全体）
合計 **175 件 / 12 ファイル**（実装系のみ抜粋）:
- `daemon.ts`: 52
- `main.ts`: 47
- `conductor.ts`: 26
- `e2e.ts`: 16
- `envrc-prompt.ts`: 15
- `proxy.ts`: 6
- `dashboard.tsx`: 3
- `master.ts`: 3
- `template.ts`: 3
- `cmux.ts`: 2
- `task.ts`: 1
- `eventBus.ts`: 1

> **注意（Non-blocking 11 反映）**: `proxy.ts` / `template.ts` / `task.ts` / `eventBus.ts` / `envrc-prompt.ts` は surface を含まないため **変更なし**。今回の改修対象は surface を含む log 呼び出しを持つ `daemon.ts` / `conductor.ts` / `master.ts` / `main.ts` / `cmux.ts` の 5 ファイル。

### 1.3 surface 出現を含む log 呼び出し
`log("...", ...surface...)` 形式: **24+ 件**
- `daemon.ts`: 18
- `conductor.ts`: 5
- `master.ts`: 1
- `cmux.ts`: 1
- `main.ts`: 2

主なパターン:
- `surface=${conductor.surface}`
- `surface=surface:665`（cmux 由来の生 ID）
- `conductor_surface=surface:665 surface=surface:719`（親子関係）

### 1.4 dashboard.tsx の log パース
- `parseLogLine` (264:dashboard.tsx) — `[ts] event detail` を分解、`level` のみ判定。色付けはイベント名＝`error` のみ。
- `parseJournalEntries` (280:dashboard.tsx) — `event=conductor_started / task_completed / task_aborted / task_deleted` の分岐で `task_id=(\S+)` / `title=...` / `journal_summary=...` / `surface=surface:(\S+)` / `conductor_id=(\S+)` を抽出する。**surface 以外の抽出箇所は剥がしルール狭めにより今回変更不要**（Blocking 1 参照）。

### 1.5 daemon_started
- `main.ts:316` の単一箇所で発火。version は現状含まれていない。
- `package.json` (root) の `version` は `3.45.0`（読み取り対象）。

### 1.6 e2e.ts の依存パターン
`waitForLog` / `includes` で **exact substring** を使用する箇所:
- `waitForLog("task_completed task_id=1", ...)` (L386, L391, L396, L479-481)
- `waitForLog("conductor_started task_id=10", ...)` (L467-469, L484)
- `logBefore.includes("conductor_started task_id=13")` (L476)

これらが壊れないよう、**`task_id=N` 形式を維持する**（Blocking 1）。

---

## 2. logger.ts 改修設計

### 2.1 追加するヘルパー

```ts
export type SurfaceRole = "C" | "A" | "M" | "U" | "S";
//                                               ^^^ role 不明（cmux 低レベル箇所）用。Blocking 2 反映。

/**
 * "surface:665" / "665" → "C[665]"
 * 空文字 / undefined 入力時は "" を返す（トークンごと消えて視覚的にスペースが連続するが、
 * 呼び出し側で detail を構築する際に "" を含めても挙動が安定することを優先）。
 * Blocking 4 反映。
 */
export function formatSurface(surface: string | undefined, role: SurfaceRole): string;

/**
 * ("surface:665","surface:719","C","A") → "C[665]>A[719]"
 * 片方が空なら空でない側のみ（例: "C[665]>"ではなく"C[665]"）。
 * 両方空なら ""。
 */
export function formatPair(
  parent: string | undefined,
  child: string | undefined,
  parentRole: SurfaceRole,
  childRole: SurfaceRole,
): string;
```

> **Non-blocking 7 反映**: `formatTaskId` / `formatArtifactId` は **剥がしルール狭めにより不要になった**（`task_id=N` / `artifact_id=Axxx` は `key=value` 維持）。logger.ts にはこれらのヘルパーを **追加しない**。

> **Non-blocking 7 反映**: `formatVersion()` は logger.ts に置かず、**main.ts 起動時に 1 度だけ package.json を読み state に保持** する（後述 3.2）。logger.ts を I/O ヘルパーで汚さない。

### 2.2 剥がしルール（狭められたスコープ）

`log(event, detail)` の `detail` 文字列を組み立てる側で適用する。**logger.ts 自身は文字列を解釈しない**。

**トークン化対象（今回剥がす）**:
- `surface=surface:665` → `C[665]`
- `conductor_surface=surface:665 surface=surface:719` → `C[665]>A[719]`
- `agent_surface=surface:719` → `A[719]`

**`key=value` を維持する（剥がさない）**:
- `task_id=192` → そのまま `task_id=192`
- `conductor_id=conductor-1` → そのまま
- `artifact_id=A001` → そのまま
- `agent_id=agent-xxx` → そのまま
- `role=`, `pid=`, `exit=`, `session_id=`, `count=`, `mode=` 等 → そのまま

> **Blocking 1 反映（要点）**: e2e.ts の `waitForLog("task_completed task_id=1")` や `parseJournalEntries` の `task_id=(\S+)` / `conductor_id=(\S+)` 抽出が壊れないようにするため、今回剥がすのは **surface 系のみ**。T192 / A001 といったプレフィックス風の見た目はログ本文には出さず、**dashboard.tsx の `parseLogLine` 側で描画変換する**（`task_id=(\d+)` → `T\d+` スタイル着色）。

> 設計判断: ロール文字列をハードコードする（例: `` `${formatSurface(s, "C")}` ``）。`SurfaceRole` union により grep / 型チェックで漏れを発見できる。

### 2.3 後方互換
- 旧 `surface=surface:665` 形式のログ行は `dashboard.tsx` 側のパーサーが両対応で受ける（5.3）。
- logger.ts の `log()` API シグネチャは不変。

---

## 3. daemon_started の version 取得

### 3.1 取得元
ルート `package.json`（`@hummer98/cmux-team`、version 3.45.0）を `import.meta.dir` からの相対パスで読む。

### 3.2 実装方針（Non-blocking 7 反映 — 1 案に確定）

**main.ts 側で起動時に 1 度だけ読み、state に保持する**（logger.ts には I/O を持ち込まない）:

```ts
// main.ts
import { readFile } from "fs/promises";
import { join } from "path";

async function loadVersion(): Promise<string> {
  try {
    const pkg = await readFile(
      join(import.meta.dir, "../../../package.json"),
      "utf-8",
    );
    return `v${JSON.parse(pkg).version}`;
  } catch {
    return "v?.?.?";
  }
}

// 起動時:
const version = await loadVersion();
state.version = version;
await log("daemon_started", `${version} pid=${process.pid} poll=${poll}ms ...`);
```

- `package.json` の `files` に `skills/cmux-team/manager/**/*.ts` が含まれるため、`__dirname` の 3 階層上 (`manager/` → `cmux-team/` → `skills/` → root) に root `package.json` が来ることは保証される。
- 失敗時は `v?.?.?` を返し daemon 起動を阻害しない。
- `state.version` は後続イベント（将来 `conductor_started` などで version を添付したくなった場合）でも使える。

---

## 4. call-site 置換戦略

### 4.1 置換パターン一覧（before / after）

剥がしルールが狭まったことを反映。

| # | before | after |
|---|--------|-------|
| 1 | `log("conductor_registered", \`surface=${s} pane=${p}\`)` | `log("conductor_registered", \`${formatSurface(s,"C")} pane=${p}\`)` |
| 2 | `log("conductor_started", \`task_id=${t} surface=${s} role=${r}\`)` | `log("conductor_started", \`task_id=${t} ${formatSurface(s,"C")} role=${r}\`)`<br>※ `task_id=` は維持 |
| 3 | `log("agent_done", \`conductor_surface=${cs} surface=${as} task_id=${t} role=${r} exit=${e}\`)` | `log("agent_done", \`${formatPair(cs,as,"C","A")} task_id=${t} role=${r} exit=${e}\`)` |
| 4 | `log("master_started", \`surface=${s}\`)` | `log("master_started", \`${formatSurface(s,"U")}\`)` |
| 5 | `log("master_session_idle", \`surface=${s}\`)` | `log("master_session_idle", \`${formatSurface(s,"U")}\`)` |
| 6 | `log("daemon_surface", \`surface=${s} (env)\`)` | `log("daemon_surface", \`${formatSurface(s,"M")} (env)\`)` |
| 7 | `log("error", \`getPaneForSurface failed: surface=${s} ${err}\`)` | `log("error", \`getPaneForSurface failed: ${formatSurface(s,"S")} ${err}\`)`<br>※ cmux.ts はロール不明のため "S" |

### 4.2 ロール判定の所在

- **Conductor 系**: `daemon.ts` / `conductor.ts` の Conductor surface を扱う箇所 = **C**
- **Master 系**: `master.ts` / `daemon.ts` の `master_*` イベント = **U**
- **Agent 系**: `agent_*` イベント子側 = **A**、親付きなら `formatPair(..., "C", "A")`
- **Daemon (Manager) 自身**: `daemon_started`, `daemon_surface`, `infra_ready` = **M**
- **ロール不明**（`cmux.ts` 低レベル箇所等）: **S**

### 4.3 ファイル別の該当箇所

`daemon.ts`:
- L452 master_respawn_proxy_changed (U)
- L459 master_alive (U)
- L463 master_check_failed (U)
- L476 master_started (U)
- L535 `conductors_restored` — **`surfaces=C[665],C[719],C[800]` 形式**（Blocking 5 反映。key= を維持し token をカンマ区切り。単一 surface イベントとの表記整合性を優先）
- L695 master_session_started (U)
- L719 session_started_ignored (U)
- L733 conductor_registered (C)
- L762 master_session_ended (U)
- L817 master_session_active (U)
- L826/829 conductor_recovered / conductor_ready (C)
- L840 session_stop_dropped (-)
- L882 master_session_idle (U)
- L911/915 conductor_recovered / conductor_ready (C)
- L958 master_session_ask_ignored (U)
- L1432 writeAgentDone failed (A — error 文)
- その他 `conductor_forced_close` / `conductor_journal_written` / `agent_recovered` / `agent_spawn_failed` など頻出イベントも同一方針で置換（**4.4 の grep 手順で網羅確認**）

`conductor.ts`:
- L64 getPaneIdForSurface failed (C)
- L124 CONDUCTOR_REGISTERED send failed (C)
- L260 conductor_registered_fallback (C)
- L453 renameTab failed (C)
- L577 conductor_reset (C)

`master.ts`:
- L23 Master surface validation failed (U)
- L41 master_spawned (U)

`cmux.ts`:
- L160 getPaneForSurface failed (**S** — ロール不明のため汎用プレフィックス。シグネチャ変更は避ける)

`main.ts`:
- L486 / L496 daemon_surface (M)
- L602 resume_assignment_missing_conductor (C)

### 4.4 親子関係イベント（`C>A` 形式）

`daemon.ts` 内で `conductor_surface=... surface=...` を併記している全行を `formatPair(parent, child, "C", "A")` に置換。対象: `agent_done`, `agent_spawn_failed`, `agent_recovered`, `agent_killed` など。

### 4.5 置換完全性担保の grep 手順（Blocking 6 — 必須）

**実装者はコミット前に以下を必ず実行し、いずれも 0 件になっていることを確認する**:

```sh
# 新規コードに surface=${...} が残っていないか
! rg -n 'surface=\$\{' skills/cmux-team/manager --type ts --type tsx

# 新規コードに surface=surface: リテラルが残っていないか（dashboard.tsx は除外 — 後方互換パーサーのため）
! rg -n 'surface=surface:' skills/cmux-team/manager/{daemon,conductor,master,main,cmux}.ts

# 親子併記パターンが formatPair に置換されているか
! rg -n 'conductor_surface=\$\{.*surface=\$\{' skills/cmux-team/manager --type ts
```

このチェックを plan 8 の実装順序の各ステップ末尾にも入れる。

---

## 5. TUI dashboard 色付け

### 5.1 改修箇所
- `parseLogLine` (264:dashboard.tsx)
  - 戻り値に `roles?: { token: string; role: SurfaceRole }[]` を追加
  - 正規表現で `([CAMUS])\[(\d+)\]` を抽出（**S** も含む）
  - **追加の描画変換**（Blocking 1 / Non-blocking 反映）: detail 中の `task_id=(\d+)` / `conductor_id=(\S+)` / `artifact_id=A\d+` を検出し、描画時に `T\d+` / `A\d+` 風の着色スタイルを適用できるメタ情報を返す（ログ本文には変換しない）
- 描画側（`parseLogLine` 利用箇所、L758 周辺）
  - detail を文字列ではなく `ui.text` のセグメントリストとしてレンダリングし、トークンに色を付ける

### 5.2 配色

| ロール | 色 | rgb |
|--------|-----|-----|
| C (Conductor) | シアン | `rgb(0, 200, 220)` |
| A (Agent) | 黄 | `rgb(220, 200, 0)` |
| M (Manager) | マゼンタ | `rgb(200, 80, 200)` |
| U (User/Master) | 緑 | `rgb(80, 200, 80)` |
| S (role unknown) | グレー | 既存 GRAY を再利用 |
| T (Task) | 青 | `rgb(100, 150, 255)`（描画時変換） |
| A (Artifact) | オレンジ | `rgb(220, 140, 0)`（描画時変換、`A[...]` ロールと異なるスタイル。ログ本文は `artifact_id=Axxx` のまま） |

MAGENTA を新規追加（既存 `dashboard.tsx:128-132` は GREEN/YELLOW/RED/CYAN/GRAY のみ）。

### 5.3 `parseJournalEntries` の新旧両対応（Blocking 3 反映）

既存の `surface=surface:(\S+)` 抽出に加え、新フォーマット `[CAMUS]\[(\d+)\]` も両方試す。**task_id / conductor_id は剥がしルール狭めにより変更不要**（既存の `task_id=(\S+)` / `conductor_id=(\S+)` 抽出はそのまま残す）。

推奨実装パターン（各イベント分岐で共通化）:

```ts
const surface =
  detail.match(/surface=surface:(\S+)/)?.[1]
  ?? detail.match(/[CAMUS]\[(\d+)\]/)?.[1]
  ?? "";

// task_id / conductor_id は新旧で変わらないので既存のまま
const taskId = detail.match(/task_id=(\S+)/)?.[1];
const conductorId = detail.match(/conductor_id=(\S+)/)?.[1];
```

`conductors_restored` の `surfaces=` は新フォーマットで `surfaces=C[665],C[719],C[800]` 形式のため、パース側も両対応:

```ts
// 旧: surfaces=surface:665,surface:719
// 新: surfaces=C[665],C[719]
const surfacesMatch = detail.match(/surfaces=(\S+)/)?.[1] ?? "";
const surfaceIds = surfacesMatch
  .split(",")
  .map((s) =>
    s.match(/surface:(\S+)/)?.[1] ?? s.match(/[CAMUS]\[(\d+)\]/)?.[1] ?? "",
  )
  .filter(Boolean);
```

### 5.4 `manager.log` への着色禁止
ANSI エスケープを書き込まない。装飾は `dashboard.tsx` の描画段階のみ。

### 5.5 セグメント描画のフォールバック方針
初版は常にセグメント方式で実装する。`@rezi-ui/core` の部分セグメント着色が実環境で崩れる場合は **次 PR で「ドミナントロール色を行全体に当てる簡易版」にフォールバック** する（今回のスコープではセグメント方式のみ）。

---

## 6. CLAUDE.md 更新箇所

### 6.1 「ロギングポリシー」セクション

- 「ログフォーマット」サブセクションを以下で差し替え:
  ```
  [2026-04-04T10:30:00+09:00] event_name C[665] task_id=192 role=inspector exit=0
  [2026-04-04T10:30:01+09:00] agent_done C[665]>A[719] task_id=192 role=inspector exit=0
  ```

- 「ID プレフィックス表記」サブセクションを新規追加:

  | プレフィックス | 意味 | 色（dashboard） |
  |---|---|---|
  | `C[NNN]` | Conductor surface | シアン |
  | `A[NNN]` | Agent surface | 黄 |
  | `M[NNN]` | Manager surface | マゼンタ |
  | `U[NNN]` | User/Master surface | 緑 |
  | `S[NNN]` | role 不明の surface（cmux 低レベル箇所のみ） | グレー |
  | `task_id=NNN` | タスク ID（`T` 剥がしなし、key=value 維持） | 描画時に青着色 |
  | `artifact_id=Axxx` | アーティファクト ID（key=value 維持） | 描画時にオレンジ着色 |
  | `conductor_id=xxx` | Conductor ID（key=value 維持） | — |

- 「禁止事項」に追記:
  - `surface=surface:NNN` 形式は **新規コードで使わない**（既存ログ互換のため受信側パーサーは寛容に）
  - **旧フォーマット行は dashboard で色付けされず白テキストで表示される**（Non-blocking 9 反映）

### 6.2 docs/spec/ への波及
現状 logging policy は CLAUDE.md にのみ記載。spec への転載は今回のスコープ外。将来 `docs/spec/` に logging 章を新設する PR を別出しするかは要検討（今回は合意済み）。

---

## 7. テスト戦略

### 7.1 logger.test.ts への追加ケース
- `formatSurface("surface:665", "C")` → `"C[665]"`
- `formatSurface("665", "A")` → `"A[665]"`
- `formatSurface("", "C")` → `""`
- `formatSurface(undefined, "C")` → `""`
- `formatSurface("surface:999", "S")` → `"S[999]"`
- `formatPair("surface:665", "surface:719", "C", "A")` → `"C[665]>A[719]"`
- `formatPair("", "surface:719", "C", "A")` → `"A[719]"`
- `formatPair("surface:665", "", "C", "A")` → `"C[665]"`
- `formatPair("", "", "C", "A")` → `""`

> `formatTaskId` / `formatArtifactId` / `formatVersion` のテストは **不要**（これらのヘルパーは実装しない方針に変更）。

### 7.2 dashboard のユニットテスト（Non-blocking 8 反映）
`parseLogLine` に `export` を追加するのみ（ファイル分割はしない、将来必要になったら別 PR）。

ケース:
- 旧フォーマット（`surface=surface:665`）→ `roles = []`、本文そのまま
- 新フォーマット（`C[665]`）→ `roles = [{token:"C[665]", role:"C"}]`
- 親子（`C[665]>A[719]`）→ 2 トークン抽出
- `S[665]` → `roles = [{token:"S[665]", role:"S"}]`
- `task_id=192` の描画変換メタ情報が返る

### 7.3 e2e.ts の確認
- `waitForLog("task_completed task_id=1")` など既存の 11 箇所以上の exact substring マッチが **引き続き通る**ことを確認（剥がしルール狭めにより task_id 形式は維持されるため本質的に変更不要）。

### 7.4 統合確認（手動）
- `cmux-team start` → `manager.log` を tail し、`surface` 系のみ新フォーマットで出力され、`task_id=` 等が維持されていることを確認
- `cmux-team status --log 20` の出力を視認
- TUI dashboard Log タブで色分けを確認（C/A/M/U/S + task_id/artifact_id の描画時着色）

---

## 8. 実装順序

1. **logger.ts にヘルパー追加 (`formatSurface`, `formatPair`) + 単体テスト** — 既存 `log()` を破壊しないので副作用なし
2. **logger.test.ts に formatXxx ケース追加**（7.1 全件）— 緑にしてから次へ
3. **main.ts に `loadVersion()` を追加し `daemon_started` に version を入れる** — 1 箇所の改修。`waitForLog("daemon_started", ...)` は event 名のみマッチなので壊れない
4. **call-site 置換（ファイル別、小→大）**:
   1. `master.ts`
   2. `main.ts`
   3. `conductor.ts`
   4. `daemon.ts`（最大 — `conductor_forced_close` / `conductor_journal_written` / `agent_recovered` / `agent_spawn_failed` も含む）
   5. `cmux.ts`（"S" 汎用プレフィックス）
   - **各ファイル単位で 4.5 の grep 手順を実行**。`bun test` で回帰検出
5. **dashboard.tsx の `parseLogLine` 改修 + 色付け描画 + parseJournalEntries の両対応化** — `MAGENTA` 定数追加、レンダラ更新、`conductors_restored` の `surfaces=C[...],...` パース対応
6. **CLAUDE.md 更新**（6.1 の表と禁止事項）
7. **手動確認** — daemon 再起動 → manager.log とダッシュボードを目視、e2e 全件グリーン

---

## 9. リスク

### 9.1 後方互換
- **既存の `manager.log`**: 旧フォーマット行が混在。`parseJournalEntries` は `surface=surface:` / `[CAMUS]\[(\d+)\]` の両対応で受ける。
- **e2e の `waitForLog`**: 剥がしルール狭めにより `task_id=N` は維持されるため影響なし。`daemon_started` の detail 追加（version 先頭付与）も event 名＋後続 substring で判定されるため問題なし。

### 9.2 抜け漏れ検出（Blocking 6 — 必須手順）

以下を **コミット前に必ず実行**（4.5 に詳細）:

```sh
! rg -n 'surface=\$\{' skills/cmux-team/manager --type ts --type tsx
! rg -n 'surface=surface:' skills/cmux-team/manager/{daemon,conductor,master,main,cmux}.ts
! rg -n 'conductor_surface=\$\{.*surface=\$\{' skills/cmux-team/manager --type ts
```

全 175 件の `log(...)` 呼び出しのうち、surface を含むのは ~24 件。残りは無関係（1.2 の注記参照）。

### 9.3 cmux.ts のロール不確定問題
- `cmux.ts:160` の `getPaneForSurface failed` はロール不明。シグネチャ変更を避け、**"S" 汎用プレフィックス**で `S[665]` 形式を使う。
- `SurfaceRole` union に `"S"` を含めることで型チェックが通る。
- CLAUDE.md の表に `S = Surface (role unknown — cmux 低レベル箇所のみ)` を明記（Non-blocking 10 反映）。

### 9.4 version 取得の堅牢性
- `import.meta.dir` ベースの相対解決（3.2）で堅牢。npm install 後の配置（`package.json` の `files` で `skills/cmux-team/manager/**/*.ts` が含まれる）でも `__dirname` の 3 階層上に root `package.json` が来ることが保証される。
- 失敗時は `v?.?.?` で fallback し daemon 起動を阻害しない。

### 9.5 dashboard 色付けの互換
- 初版はセグメント方式のみ実装。`@rezi-ui/core` で崩れる場合は次 PR で簡易版にフォールバック（今回のスコープ外）。

### 9.6 `conductors_restored` の surfaces= パース互換
- 新形式 `surfaces=C[665],C[719],C[800]` は dashboard.tsx の `parseJournalEntries` で両対応（5.3）。
- 外部解析スクリプトが現時点で `surfaces=` を消費していないことを確認済み（本リポジトリ内の grep 結果より）。将来外部ツールが参照する場合は別途追随を要する。
