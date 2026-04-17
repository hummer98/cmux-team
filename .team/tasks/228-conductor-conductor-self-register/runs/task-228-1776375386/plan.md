# T228 実装計画書: Conductor 登録を Conductor 側からの self-register 方式に変更（改訂 v2）

> **改訂履歴**: v1 は Design Review で Changes Requested（S6 が resume 経路の state pre-population を破壊 / D3 soft cap が env 未指定で発火しない）。v2 でこれら 2 件の Critical と付随する Minor/Major を反映。

## 1. 課題分析

### 現状の問題点

Conductor の daemon への登録（`CONDUCTOR_REGISTERED` HTTP POST）は Manager 起動経路の `launchConductor`（`skills/cmux-team/manager/conductor.ts:87-102`）でのみ実施されている。

- ユーザーが `cmux split` 等で新しい pane を作り、自分で `cmux-team conductor` を実行しても daemon の `state.conductors` に登録されない。
- その後 Claude Code が起動し SessionStart hook が発火しても、`daemon.ts:905-906` で `session_started_ignored reason=not_found` として捨てられる。
- 結果として任意の surface から Conductor を追加することが不可能で、`cmux-team start` が作成する固定 pane 以外では機能しない。

### 根本原因

「登録は上位（Manager）、実行は下位（Conductor pane）」という分離が保たれていない。登録責務が起動経路（`launchConductor`）に固定されているため、同じ `cmux-team conductor` コマンドでも呼び出し経路（Manager からの `cmux send` 経由か、ユーザーが直接打ったか）によって state 反映可否が変わる。

### 影響範囲

| 経路 | 現状の動作 |
|------|-----------|
| `cmux-team start` の `initializeConductorSlots` → `launchConductor` → `cmux send 'cmux-team conductor'` | register される（HTTP POST 経由） |
| `cmux-team spawn-conductor` CLI 経由（`main.ts:1807-1813`） | `launchConductor` を呼ぶため register される |
| resume 時の `initializeConductorSlots` → `launchConductor` → `cmux send 'cmux-team resume <id>'` | register される |
| **ユーザーが pane 内で直接 `cmux-team conductor` を叩いた場合** | **register されない → SessionStart ignored** |

後者を動作させるのが本タスクの目的。

## 2. 技術アプローチ

### 選択したアプローチ: 登録責務を Conductor 実行側（`cmdConductor` / `cmdResume`）に移す。ただし resume 経路の state pre-population は保持する

1. `conductor.ts:launchConductor` から `CONDUCTOR_REGISTERED` POST を削除し、「env 焼き込み + `cmux send <command>` + `renameTab`」のみ行う薄い関数にする。
2. `main.ts:cmdConductor` の先頭（`claude exec` 前）で `CONDUCTOR_REGISTERED` を POST する。`cmdResume` も同様に POST する。
3. POST ロジックは `registerSelfAsConductor(surface)` という共通ヘルパーに切り出し、`cmdConductor` と `cmdResume` の両方から呼ぶ。
4. daemon 側の `CONDUCTOR_REGISTERED` ハンドラは「既存エントリがあれば skip + ログ、無ければ新規 set」の冪等 merge に変更する（D2）。
5. `conductor.ts:initializeConductorSlots` 内の `conductor_registered_fallback` ブロック（239-267行）は **resume 分岐（244-256行付近）のみ保持、非 resume 分岐（258-265行付近）のみ削除**する（D4 改訂版 = 修正案 (A)）。
6. `CMUX_TEAM_MAX_CONDUCTORS` は **hard cap ではなく soft cap** として、登録時に `state.conductors.size >= state.maxConductors` を越えた新規登録で警告ログのみ出す（D3 改訂版）。

### 代替案とその却下理由

| 代替案 | 却下理由 |
|--------|---------|
| A1: `launchConductor` に POST を残し、手動起動は別 CLI (`cmux-team register`) で明示的に POST させる | ユーザーが「登録を忘れる」運用が発生しやすい。cmdConductor から自動的に POST されるべき。 |
| A2: SessionStart hook 側で unknown surface を検出したら遡って conductor として登録する | hook は全シグナル無条件転送ポリシー（CLAUDE.md「hook 全送信ポリシー」T216）に反する。判定ロジックを hook に追加しない方針。 |
| A3: daemon 側で `cmux tree` を polling して新 surface を検出 | T195 で「`cmux tree` / `list-status` 依存は完全撤廃」済み。方針逆戻り。 |
| A4（Design Review (B)）: `initializeConductorSlots` 内に「resume 時のみ state を pre-set」する明示的ブロックを新設 | 現行 fallback の resume 分岐を残すだけで同じ効果。新設はコード増 |
| A5（Design Review (C)）: `main.ts:699-718` を mutate から `set` に書き換え pre-population 非依存に | resume 責務の一本化は魅力だが、変更点が増え S5 / S6 / main.ts の三箇所で整合を取る必要。最小差分ではない |
| A6（Design Review (D)）: `CONDUCTOR_REGISTERED` payload に taskId/taskRunId/worktreePath を含めて Zod schema も拡張 | schema 変更はスコープ拡大。resume 情報を hook 経由で渡すと責務境界が曖昧になる |

### 既存パターンとの整合性

- **hook 全送信ポリシー（T216）**: 今回の変更は hook ではなく CLI 側で register するため、hook はそのまま。整合。
- **T203 sessionId 自己生成**: `cmdConductor` は既に sessionId を自己生成して hook 経由で daemon に push する。登録も同じ層で行うのは自然。
- **fail-fast ポリシー（T225 direnv）**: proxy-port 到達不能 = daemon 不在 = Conductor を起動しても意味がない → fail-fast が妥当（D1）。

## 3. 変更対象

### 変更するファイル

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/conductor.ts` | `launchConductor` から HTTP POST ブロック（87-102行）削除。`initializeConductorSlots` の fallback ブロック（239-267行）のうち **非 resume 分岐（258-265行）のみ削除、resume 分岐（244-256行）は保持**。 |
| `skills/cmux-team/manager/main.ts` | `registerSelfAsConductor(surface)` ヘルパー追加。`cmdConductor` / `cmdResume` 先頭で呼ぶ。proxy-port 到達不能時は fail-fast（D1）。 |
| `skills/cmux-team/manager/daemon.ts` | `CONDUCTOR_REGISTERED` ハンドラ（911-921行）を「既存 skip + ログ」に変更。`state.conductors.size >= state.maxConductors` 判定で soft cap warning ログ追加（D3）。 |
| `skills/cmux-team/manager/daemon.test.ts` | `CONDUCTOR_REGISTERED` ハンドラのユニットテスト 3 ケースを新規追加。 |
| `docs/spec/01-skill-cmux-team.md` | `cmux-team conductor` の説明に「起動時に自身を register する」を追記。 |
| `docs/spec/05-install-and-infrastructure.md` | CONDUCTOR_REGISTERED の送信元記述を「Conductor 実行プロセス自身が POST」に更新。 |

### 新規作成するファイル

なし。

### 削除するファイル

なし（関数ブロック・分岐削除のみ）。

## 4. サブタスク分割

### S1. 実装: `registerSelfAsConductor` ヘルパーを追加
- **対象ファイル**: `skills/cmux-team/manager/main.ts`
- **場所**: `postMessage` 関数（1110行付近）の近く、`cmdConductor` より前
- **内容**:
  - signature: `async function registerSelfAsConductor(surface: string): Promise<void>`
  - `resolveProxyPort()` で proxy 生存確認
  - **proxy 未起動 (undefined) の場合**: `console.error` で以下を表示し `process.exit(1)` で fail-fast（D1）:
    ```
    daemon が起動していません (.team/proxy-port 不在 / proxy 死亡 / 壊れた proxy-port ファイル)。
    cmux-team start を先に実行してください。
    壊れた proxy-port ファイルの場合は `.team/proxy-port` を削除して `cmux-team start` をやり直してください。
    ```
  - 生存時: `fetch(http://127.0.0.1:${port}/api/messages, POST, type=CONDUCTOR_REGISTERED, surface, timestamp)` を実行
  - POST 自体の HTTP エラー（connect 失敗等）も fail-fast（`console.error` + `process.exit(1)`）。HTTP 200 以外も同様。
  - `await log("conductor_self_register", formatSurface(surface, "C"))` で記録
- **メソッド制約**:
  - 既存の `resolveProxyPort`（main.ts:1090）を使う（alive check 込み）
  - `postMessage`（main.ts:1110）は**使わない**。あれは「daemon 未起動時は黙って skip」するため、fail-fast と矛盾する
  - ログ出力は `log` 関数を import して使用
- **完了条件**:
  - `registerSelfAsConductor` 関数が main.ts に追加されている
  - proxy 不在時 process.exit(1) で exit する
  - 正常時 `conductor_self_register` イベントがログに出る
  - エラーメッセージに proxy-port 破損ケースの案内（`.team/proxy-port` を削除して再起動）が含まれる
- **検証コマンド**:
  ```bash
  grep -n "registerSelfAsConductor" skills/cmux-team/manager/main.ts
  grep -n "proxy-port を削除" skills/cmux-team/manager/main.ts
  ```

### S2. 実装: `cmdConductor` に self-register を組み込む
- **対象ファイル**: `skills/cmux-team/manager/main.ts`（1601-1675行）
- **内容**:
  - `const surface = await resolveCallerSurfaceOrExit()` の**直後**に `await registerSelfAsConductor(surface)` を呼ぶ
  - 既存コード（main branch 解決、環境変数設定、proxy URL 設定、claude exec）はそのまま
  - コメントで「self-register: cmdConductor が自身を daemon に登録（T228）」を記載
- **完了条件**:
  - `cmdConductor` 内で `registerSelfAsConductor` が呼ばれている
  - 呼び出し位置が `resolveCallerSurfaceOrExit` の直後 = claude exec の前
- **検証コマンド**:
  ```bash
  sed -n '1601,1625p' skills/cmux-team/manager/main.ts | grep -n registerSelfAsConductor
  ```

### S3. 実装: `cmdResume` にも self-register を組み込む
- **対象ファイル**: `skills/cmux-team/manager/main.ts`(1681-1744行)
- **内容**:
  - `const surface = await resolveCallerSurfaceOrExit()` の直後に `await registerSelfAsConductor(surface)` を呼ぶ
  - daemon 側ハンドラは既存 state があれば skip（S5）するため、resume で `initializeConductorSlots` が先に pre-set した ConductorState（taskId/taskRunId/worktreePath 付き）を**破壊しない**
- **完了条件**:
  - `cmdResume` 内で `registerSelfAsConductor` が呼ばれている
- **検証コマンド**:
  ```bash
  sed -n '1681,1720p' skills/cmux-team/manager/main.ts | grep -n registerSelfAsConductor
  ```

### S4. 削除: `launchConductor` から HTTP POST ブロックを削除
- **対象ファイル**: `skills/cmux-team/manager/conductor.ts`(87-102行)
- **内容**:
  - `// 1. CONDUCTOR_REGISTERED を HTTP API 経由で送信` のブロック（try/catch 全体）を削除
  - 連番コメント（2. 環境変数〜 / 3. Claude 起動 / 4. タブ名設定）を 1. / 2. / 3. に繰り上げ
  - JSDoc から `- CONDUCTOR_REGISTERED を HTTP API 経由で daemon に送信` の行を削除し、代わりに「登録は `cmdConductor` / `cmdResume` の self-register に委譲（T228）」と記載
- **完了条件**:
  - `launchConductor` 内に `CONDUCTOR_REGISTERED` 文字列が存在しない
  - `launchConductor` は 4 ステップから 3 ステップに縮む
- **検証コマンド**:
  ```bash
  grep -c "CONDUCTOR_REGISTERED" skills/cmux-team/manager/conductor.ts  # expect: 0
  ```

### S5. 実装: daemon 側 `CONDUCTOR_REGISTERED` ハンドラを idempotent merge に変更（soft cap 発動条件を state.conductors.size 比較に修正）
- **対象ファイル**: `skills/cmux-team/manager/daemon.ts`(911-921行)
- **内容**:
  - `case "CONDUCTOR_REGISTERED":` 内で最初に `state.conductors.has(message.surface)` を確認
  - **既存あり**: skip ログに観測性キーを含める:
    ```ts
    const existing = state.conductors.get(message.surface)!;
    await log(
      "conductor_register_skipped",
      `${formatSurface(message.surface, "C")} reason=already_registered existing_status=${existing.status} existing_pid=${existing.pid ?? "null"}`
    );
    break;
    ```
    （D2 / Finding 4 対応: 既存 state が `running` か `disconnected` か、PID watcher が動いているか否かを後追いできる）
  - **既存なし**: `state.conductors.size >= state.maxConductors` を判定し、**超過している場合は warning ログを出してから**登録を続行（D3 改訂版 / Finding 2 対応）:
    ```ts
    if (state.conductors.size >= state.maxConductors) {
      await log(
        "conductor_register_over_cap",
        `${formatSurface(message.surface, "C")} current=${state.conductors.size} max=${state.maxConductors}`
      );
    }
    state.conductors.set(message.surface, { ... });
    ```
    **重要**: env の有無ではなく `state.conductors.size >= state.maxConductors` で判定するため、wide デフォルト 3 + 4 個目追加でも発火する。
  - 新規登録の内容は現行通り `{ surface, status: "starting", startedAt: message.timestamp, agents: [] }`
- **完了条件**:
  - 同じ surface から 2 回 POST → 2 回目は skip ログのみで state の `status/taskId/agents` が破壊されない
  - cap 超過登録 → 警告ログが出るが登録自体は成功
  - デフォルト運用（env 未指定）でも `wide=3, 16x9=2` を超えた 4/3 個目で warning が出る
- **メソッド制約**: 既存の `state.conductors: Map<string, ConductorState>` をそのまま使う。Zod schema (`schema.ts:58`) は変更不要。
- **ユニットテスト追加**（Finding 5 対応、`skills/cmux-team/manager/daemon.test.ts`）:
  1. 新規 surface からの CONDUCTOR_REGISTERED → state.conductors に set される（`status=starting, agents=[]`）
  2. 既存あり + 同 surface からの 2 回目 → `conductor_register_skipped` ログ、既存の `status/taskId/agents` が破壊されない
  3. `state.conductors.size >= state.maxConductors` 超過 → `conductor_register_over_cap` warning ログが出て登録自体は成功する
- **検証コマンド**:
  ```bash
  grep -n "conductor_register_skipped\|conductor_register_over_cap" skills/cmux-team/manager/daemon.ts
  grep -c "CONDUCTOR_REGISTERED" skills/cmux-team/manager/daemon.test.ts  # expect: >= 3
  cd skills/cmux-team/manager && bun test daemon.test.ts
  ```

### S6. 削除: `initializeConductorSlots` の `conductor_registered_fallback` の**非 resume 分岐のみ**削除（resume 分岐は保持）
- **対象ファイル**: `skills/cmux-team/manager/conductor.ts`(239-267行)
- **内容**（Design Review 修正案 (A) を採用 — D4 改訂版）:
  - 非 resume 分岐（258-265行目付近、else ブランチの `conductors.set(surface, { status: "starting", ... })`）を**削除**する
  - resume 分岐（244-256行目付近、`if (resumeItem) { conductors.set(surface, { status: "running", taskId, taskRunId, worktreePath, taskTitle, ... })}`）は **保持**する
  - ログイベント名を `conductor_registered_fallback` から `conductor_resume_prepopulated` に変更（responsibility が明確になるため）
  - コメントを書き換える:
    ```ts
    // resume 時の state pre-population: main.ts:699-718 の resume 割当反映ループが
    // state.conductors.get(r.surface) で既存エントリを mutate するため、
    // initializeLayout 完了時点で state.conductors に resume 対象 surface が
    // 同期的に存在する必要がある。
    // 非 resume 分岐は self-register (cmdConductor → CONDUCTOR_REGISTERED POST) に
    // 委譲したため削除。
    ```
- **採用理由**（Decision Log D4 で詳述）:
  - 修正案 (A) = 最小差分、既存の main.ts:699-718 mutate ロジックをそのまま活用
  - resume 側は「HTTP POST 到達前に state が必要」という同期的制約がある（非同期化すると resume 割当反映の race condition を招く）
  - 非 resume 側は self-register で十分。POST が失敗すれば cmdConductor が fail-fast するため、state に ghost entry が残る問題は起きない
- **start 時の登録順序**:
  - **resume 対象 surface**:
    1. `initializeConductorSlots` が `cmux send 'cmux-team resume <id>'` を発行
    2. resume 分岐が `conductors.set(surface, { status: "running", taskId, taskRunId, worktreePath, taskTitle })` で **同期的に state pre-set**
    3. `initializeConductorSlots` return 後、`main.ts:699-718` が `state.conductors.get(r.surface)` で pre-set された ConductorState を mutate（`status="running"`, `startedAt`, `agents=[]` を上書き／確認）
    4. 数秒後、pane 内で `cmdResume` が `registerSelfAsConductor` を実行 → CONDUCTOR_REGISTERED POST
    5. daemon ハンドラは「既存あり → skip」（D2）。pre-set した taskId/taskRunId/worktreePath が保持される
  - **非 resume surface**:
    1. `initializeConductorSlots` が `cmux send 'cmux-team conductor'` を発行
    2. 数秒後、pane 内で `cmdConductor` が `registerSelfAsConductor` を実行 → CONDUCTOR_REGISTERED POST
    3. daemon が `starting` で state.conductors に新規登録
    4. claude が起動 → SessionStart hook → `starting` → `idle` 遷移
- **完了条件**:
  - `conductor.ts` の `initializeConductorSlots` 内に非 resume 分岐の `conductors.set(surface, { status: "starting", ... })` が存在しない
  - resume 分岐の `conductors.set(surface, { status: "running", taskId, ... })` は存在する
  - `conductor_registered_fallback` 文字列は存在せず、代わりに `conductor_resume_prepopulated` が resume 分岐のみで呼ばれる
- **検証コマンド**:
  ```bash
  grep -c "conductor_registered_fallback" skills/cmux-team/manager/conductor.ts  # expect: 0
  grep -n "conductor_resume_prepopulated" skills/cmux-team/manager/conductor.ts  # expect: 1
  grep -n 'status: "starting"' skills/cmux-team/manager/conductor.ts             # expect: 0（このファイル内で starting を set する箇所なし）
  ```

### S7. 配線: 型チェック + ユニットテスト通過を確認
- **対象ファイル**: `skills/cmux-team/manager/`
- **内容**:
  - `bunx tsc --noEmit` を実行し、新規追加エラーがゼロであることを確認
  - `bun test daemon.test.ts` で S5 で追加したユニットテスト 3 ケース含めて全 pass
- **完了条件**: 両方 exit code 0
- **検証コマンド**:
  ```bash
  cd skills/cmux-team/manager && bunx tsc --noEmit
  cd skills/cmux-team/manager && bun test
  ```

### S8. ドキュメント更新
- **対象ファイル**:
  - `docs/spec/01-skill-cmux-team.md` — `cmux-team conductor` 行に「起動時に daemon へ self-register する」旨を追記
  - `docs/spec/05-install-and-infrastructure.md` — CONDUCTOR_REGISTERED メッセージの送信元を「Conductor 実行プロセス自身」に修正
- **完了条件**: grep で「self-register」「self register」「cmdConductor が自身を登録」等が spec に追加されていること
- **検証コマンド**:
  ```bash
  grep -n "self-register\|self register" docs/spec/*.md
  ```

### サブタスク順序と並列化

- **直列必須**: S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8
- **並列実装禁止**: S2/S3（新実装）と S4（旧実装削除）は同一 commit 内で行い、中間状態で tsc を通さない。S4 単体で commit すると `launchConductor` だけ POST 不在になり、cmdConductor 側の POST がまだ無いため **start 時に全 Conductor が未登録になる** → 動作破壊。
- S8（docs）は S1-S7 完了後。

## 5. リスク

### 既存機能への影響

| リスク | 発生条件 | 対策 |
|--------|---------|------|
| `cmux-team start` の起動時に Conductor が state に登録されない | `cmdConductor` の self-register 実装漏れ | S2 で register を先頭に置く。S4 と S2 を同一 commit で完了させる（中間状態を作らない）。 |
| **resume 経路で state pre-population が失われ taskId/taskRunId/worktreePath が反映されない** | S6 で resume 分岐まで削除してしまう | **S6 は非 resume 分岐のみ削除。resume 分岐は保持**（Design Review Finding 1 修正案 (A) 採用、D4 で詳述）。`initializeConductorSlots` return 時点で resume 対象 surface は state に pre-set 済みなので main.ts:699-718 の mutate ループが成立する。resume 後に cmdResume から POST が届いても daemon ハンドラが既存 skip（S5 / D2）し、pre-set された taskId/taskRunId/worktreePath が破壊されない |
| daemon 未起動時に Conductor だけが立ち上がり無意味な claude が走る | proxy-port が無いが cmdConductor が exec を続行 | S1 で fail-fast (exit 1)。daemon 未起動時は claude を起動しない。 |
| `cmux-team spawn-conductor` CLI（main.ts:1807）が壊れる | `launchConductor` から POST が消えたため、`spawn-conductor` で起動した Conductor が登録されない？ | `spawn-conductor` も内部的に `cmux send 'cmux-team conductor'` を発行するため、pane 内で `cmdConductor` → self-register が走る。経路は T228 以降共通化され、登録は問題ない（ただし `mainBranch` 引数未渡し問題は別途 D7 で扱う — スコープ外） |
| `renameTab` が register より先に発火して tab 名だけ付いて登録なし | `launchConductor` の `cmux send` → pane 内 `cmdConductor` の実行までに数秒ラグ。renameTab はその後で実行するため登録前 | `launchConductor` は `renameTab` で `[N] Conductor` を付けるだけで、daemon 側の state とは独立。pane 上のラベルだけなので問題なし |
| soft cap warning がデフォルト運用で発火しない | env 設定の有無で判定していた旧設計 | S5 で `state.conductors.size >= state.maxConductors` 比較に修正（D3 改訂版）。wide デフォルト 3 + 4 個目でも発火する |

### エッジケース

- **E1: ユーザーが存在しない pane で `cmux-team conductor` を叩く** → `resolveCallerSurfaceOrExit` が失敗 → 既存の exit 1 パスで終了。register にも到達しない。
- **E2: daemon が途中でダウン → 再起動 → proxy port 変更** → cmdConductor は起動時の proxy-port を読むため、再 exec しないと新 port には到達しない。これは T228 以前から同じ制約。本タスクのスコープ外。
- **E3: 同じ surface で cmux-team conductor を二重起動（古い Claude がまだ動いてるのに新しく打つ）** → 2 回目の cmdConductor が POST → daemon は「既存 skip」を返す（D2 ログに `existing_status` / `existing_pid` 付き、Finding 4 対応）→ claude exec → SessionStart で新 PID / sessionId が state に反映される。state 側の agent 配列等の旧データはそのまま残るが、PID watcher が古い PID の死亡を検知して disconnected → 新 SessionStart で復帰、という既存の disconnected recovery 経路に載る。skip ログの `existing_status=disconnected existing_pid=null` で追跡可能。
- **E4: `CMUX_TEAM_MAX_CONDUCTORS=2` が設定されており 3 個目を手動登録** → soft cap（D3 改訂版）の警告ログが出るが登録は成功。dashboard 表示は `state.conductors` 全件を描画する実装のため 3 件目も表示される想定（`dashboard.tsx` のロジックは本タスクでは触らない。動作確認のみ）。
- **E5: デフォルト wide + 4 個目を手動追加** → `state.conductors.size (=3) >= state.maxConductors (=3)` のため soft cap warning 発火。env 未設定でも検知できる（Finding 2 対応）。

### テスト戦略

自動テスト（`daemon.test.ts`）と E2E 手動テストの併用。ユニットテストは S5 の 3 ケースで CONDUCTOR_REGISTERED ハンドラをカバー。E2E は以下:

| # | 手順 | 期待結果 |
|---|------|---------|
| T1 | `cmux-team start --layout wide` | 3 Conductor が従来通り起動・register される（manager.log に `conductor_register_skipped` が出ないこと） |
| T2 | T1 の後、新しい pane を開いて `cmux-team conductor` を実行 | 4 つ目の Conductor が register され、`cmux-team status` に表示される。同時に `conductor_register_over_cap current=3 max=3` warning ログが出る |
| T3 | T1 のうち 1 つの Conductor pane で `/clear` → 直後に hook-bypass で再度 `cmux-team conductor` を exec | 2 回目の POST は `conductor_register_skipped reason=already_registered existing_status=<...> existing_pid=<...>` ログで skip される。state の `taskId/agents` は保持される |
| T4 | daemon を停止（`.team/proxy-port` 削除）した後に `cmux-team conductor` を pane で実行 | エラーメッセージ（proxy-port 破損ケースの案内含む）+ exit 1 で fail-fast、claude は起動しない |
| T5 | resume 経路: `cmux-team start` で assigned タスクが復元される | `initializeConductorSlots` の resume 分岐が state を pre-set → `main.ts:699-718` が taskId/taskRunId/worktreePath/status=running を反映 → その後 cmdResume 内で self-register → daemon ハンドラが既存 state を skip。taskId/worktreePath 等の resume 時 state が保持される |
| T6 | `CMUX_TEAM_MAX_CONDUCTORS=2 cmux-team start --layout 16x9` + 手動で 3 つ目追加 | 警告ログ `conductor_register_over_cap current=2 max=2` が出るが登録は成功、全 3 件が dashboard に表示される |

## 6. 既存型エラーの先読み

着手前に worktree 内で `bunx tsc --noEmit` を実行した結果、既存エラーは **0 件（exit 0）**。

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-228-1776375386/skills/cmux-team/manager
bunx tsc --noEmit 2>&1 | grep -E "^(conductor\.ts|main\.ts|daemon\.ts)" || true
# → 該当なし
```

- **本タスクのスコープで解消するエラー**: 該当なし。
- **後続タスク（cleanup）に分離するエラー**: 該当なし。

本タスクで新規追加するコードに型エラーが出ないことを S7 で確認する。

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | proxy-port 読み取り失敗時の挙動 | **fail-fast (exit 1)**、メッセージに proxy-port 破損ケースの案内を含める | daemon 不在で Conductor claude だけ起動しても、タスク割当も SessionStart hook の state 更新も機能しない。T225 の direnv fail-fast と同じポリシー。破損 proxy-port ファイルで undefined が返る third ケースもユーザー向け文言に含めることで orphan を解消（Finding 6） |
| D2 | 重複 register の扱い | **既存あり → 早期 return + ログ**（skip）。skip ログに `existing_status` / `existing_pid` を含める | 既存 state の `status/taskId/agents/taskRunId` を破壊しないため。merge 処理を書くと既存フィールドを誤って上書きするリスクがある。skip が最も保守的。Finding 4 対応で観測性を強化 |
| D3（改訂） | capacity 制御の判定条件 | **`state.conductors.size >= state.maxConductors` 超過で warning ログのみ**（soft cap） | 初版は「env 設定の有無」を条件にしていたが、daemon.ts:192-195 で env 未指定でも `state.maxConductors` は layout 既定値で確定するため、デフォルト運用で警告が永久に発火しない（Finding 2）。判定を state.conductors.size 比較にすることで、wide デフォルト 3 + 4 個目でも検知できる |
| D4（改訂） | `initializeConductorSlots` fallback ブロックの扱い | **非 resume 分岐のみ削除、resume 分岐は保持**（Design Review 修正案 (A)）。ログイベント名を `conductor_resume_prepopulated` に改名 | 初版は「全削除」だったが、main.ts:699-718 の resume 割当反映ループが `state.conductors.get(r.surface)` で既存エントリを mutate するため、pre-population が同期的に存在しないと resume が壊れる（Finding 1）。非 resume 側は self-register で十分（POST 失敗 = fail-fast なので ghost entry 問題は起きない）。resume 側は HTTP POST 到達前に state が必要なため同期的 pre-set を維持。最小差分で修正案 (A) を採用 |
| D5 | `cmdResume` の扱い | `registerSelfAsConductor` を `cmdResume` でも呼ぶ | `launchConductor` から POST を外した後、resume 経路でも self-register が必要。D2 の skip により、既に `initializeConductorSlots` が pre-set した state は保持される |
| D6 | hard cap を daemon 側に入れないか | 入れない | 「任意の surface から Conductor を増やせる」のが本タスクの目的。hard cap は目的と矛盾する |
| D7（新規） | `cmdSpawnConductor`（main.ts:1807-1813）の `launchConductor` 呼び出しで `mainBranch` が渡されていない既存問題 | **既知の未修正箇所として残す。T228 のスコープ外** | 本タスクの scope は「Conductor 登録責務の移譲」であり、mainBranch 解決経路の修正は別責務。`cmux-team spawn-conductor` で "main" 以外のブランチを使うプロジェクトでは worktree のベースが誤るが、self-register 自体は `cmdConductor` 内で動くため register の整合性には影響しない。将来別タスク（T228 後継）で `cmdSpawnConductor` にも `resolveMainBranch()` を呼んで `launchConductor` に渡すよう修正すべき（Finding 3） |
