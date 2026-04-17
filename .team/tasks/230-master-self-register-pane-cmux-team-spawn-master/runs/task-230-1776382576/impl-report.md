# T230 実装レポート — Master self-register

**run_id:** `task-230-1776382576`
**role:** `implementer-task-230`
**worktree:** `/Users/yamamoto/git/cmux-team/.worktrees/task-230-1776382576`
**完了日時:** 2026-04-17

## 1. 完了タスク

plan.md S1–S13 および Final をすべて完了。Design Review F1/F2/F3 に対応するため一部で plan から逸脱（後述 §3）。

| ID | 内容 | 状態 |
|----|------|------|
| S1 | `MASTER_REGISTERED` メッセージ型を schema.ts に追加 | 完了 |
| S2 | `registerSelfAsMaster` ヘルパーを main.ts に追加 | 完了 |
| S3 | `cmdLaunchMaster` に self-register 組込み | 完了 |
| S4 | `spawnMaster` から `startedAt` 除去 | 完了 |
| S5 | daemon.ts に `case "MASTER_REGISTERED"` handler 追加 | 完了 |
| S6 | `MasterStateSchema.status` に `"starting"` 追加 | 完了 |
| S7 | `spawnAndRegisterMaster` 削除 / `startMaster` で直接 `spawnMaster` 呼び出し | 完了（F2 対応） |
| S8 | proxy-port 変化時の再 spawn 経路を新方式に対応 | 完了 |
| S9 | i18n.ts の `help_spawn_master` を更新 | 完了 |
| S10 | CLAUDE.md の `team.json.masters` 項目名を修正 + T230 追記 | 完了 |
| S11 | daemon.test.ts に `MASTER_REGISTERED` テスト追加（T1–T6） | 完了 |
| S12 | `normalizeSurfaceForPath` 重複解消 / `stopDaemon` の clearInterval / master.test.ts 作成 | **未実施（follow-up タスクへ送る）** |
| S13 | `docs/spec/01-skill-cmux-team.md`, `docs/spec/05-install-and-infrastructure.md` の自己登録方式への更新 | 完了 |
| Final | `bunx tsc --noEmit` / `bun test` / grep 検証 / 本レポート作成 | 完了 |

## 2. 変更ファイル一覧

### プロダクションコード

- `skills/cmux-team/manager/schema.ts`
  - `MasterRegisteredMessage` スキーマ / `QueueMessage` discriminated union に追加
  - `MasterStateSchema.status` enum に `"starting"` 追加
  - 型 export `MasterRegisteredMessage` 追加
- `skills/cmux-team/manager/main.ts`
  - `registerSelfAsMaster(surface)` ヘルパー新設（proxy-port 解決 → `POST /api/messages`）
  - `cmdLaunchMaster` に `await registerSelfAsMaster(surface)` を組込み（`resolveCallerSurfaceOrExit` の直後、プロンプト生成前、daemon 不在時は exit 1）
- `skills/cmux-team/manager/master.ts`
  - `spawnMaster` の返り値型を `Promise<{ surface: string } | null>` に変更（`startedAt` 除去）
  - daemon 側で `state.masters.set` 時に `new Date().toISOString()` を付与する責務に統一
- `skills/cmux-team/manager/daemon.ts`
  - `spawnAndRegisterMaster` 削除（F2 対応）
  - `startMaster` を書き換え: proxy-port 変更経路では per-master `spawnMaster(daemonSurface)` ループ、全て kill 済み / 復元 0 件経路でも `spawnMaster(daemonSurface)` を直接呼び出し
  - `handleMessage` に `case "MASTER_REGISTERED":` を追加（idempotent skip + persist + optional PID watcher + `notifyStateChanged`）
  - `SESSION_STARTED` ハンドラの `!agentMatched` 分岐に F1 fallback（`state.masters.set(status: "starting") + persistMasterFile + spawnMasterPidWatcher`）を追加
- `skills/cmux-team/manager/i18n.ts`
  - EN / JA 両ロケールの `help_spawn_master` に self-register / fail-fast / 任意 pane 起動可の注記を追記

### テスト

- `skills/cmux-team/manager/daemon.test.ts`
  - `describe("handleMessage: MASTER_REGISTERED (T230)")` を新設し T1–T6 を追加
    - T1: 新規 surface → `state.masters` 登録 + `persistMasterFile` + `master_registered` ログ
    - T2: 重複登録スキップ（既存 6 フィールド `surface/pid/status/startedAt/disconnectedAt/prompt` が保護されることを検証）
    - T3: pid 同梱の POST → `spawnMasterPidWatcher` 即時起動
    - T4: `SESSION_STARTED` 先行時の F1 fallback 経路
    - T5: `MASTER_REGISTERED` → `SESSION_STARTED` の状態遷移（`"starting"` → `"idle"`、pid 確定）
    - T6: proxy-port 変更経路で全 Master が `state.masters`/`team.json`/`.team/masters/` から除去されること（縮退確認のみ、Design Review F3）

### ドキュメント

- `CLAUDE.md` — `team.json.masters` のフィールド列挙を実装に合わせ `{ surface, status, pid?, startedAt }` に訂正 + T230 自己登録への言及を追記
- `docs/spec/01-skill-cmux-team.md` — `cmux-team spawn-master` 行を self-register 方式・fail-fast・複数 Master 並行運用を明記する記述に更新
- `docs/spec/05-install-and-infrastructure.md`
  - `spawn-master` 行に `MASTER_REGISTERED` self-register と fail-fast を明記
  - `.team/masters/` セクションの「ライフサイクル」を self-register ベースに書き直し、F1 fallback と `startMaster` の「復元 0 件時は 1 個自動起動」挙動を追記

## 3. Design Review Findings 対応

| Finding | 種別 | 対応内容 |
|---------|------|---------|
| **F1** — SESSION_STARTED 先行時の取りこぼし | Major | `daemon.ts` の `SESSION_STARTED` ハンドラ `!agentMatched` 分岐に fallback 経路を追加。`state.masters.set(status: "starting") + persistMasterFile + spawnMasterPidWatcher` を実行し、そのまま `"idle"` 遷移処理に流す。既存の Master エントリが状態持ちの場合はスキップ |
| **F2** — 新関数 `spawnMasterPane` 追加の是非 | Major | plan では新関数追加を予定していたが、Design Review に従い `spawnAndRegisterMaster` を**削除**して `startMaster` が `spawnMaster` を直接呼ぶ形に統一。追加関数はゼロ。`cmdLaunchMaster` 側は `spawnMaster` を呼ばず既存の CLI 起動フローのまま `registerSelfAsMaster` を挟むのみ |
| **F3** — T6 を 統合テスト → 単体テストに縮退 | Major | `daemon.test.ts` の T6 は実 daemon 起動を行わず、`state.masters` に 2 件投入した状態で `startMaster` を `PATH=/nonexistent` で失敗させ、結果として `state.masters` / `team.json` / `.team/masters/` が全て空になること（縮退）のみ検証 |
| F4 — plan の `MasterStateSchema` 拡張漏れ | Minor | S6 として正式実装（`"starting"` enum 追加） |
| F5 — `cmdLaunchMaster` の register 呼び出し順 | Minor | `resolveCallerSurfaceOrExit` の直後・プロンプト生成前に `await registerSelfAsMaster` を配置。プロンプト失敗と登録失敗を明確に分離 |
| F6 — `registerSelfAsMaster` と `registerSelfAsConductor` のコード重複 | Minor | 今回は同一パターンを踏襲（抽象化すると読み手にとって自動ルーティングの接続が見えづらくなるため現状維持） |
| F7 — help 文言に fail-fast / 任意 pane を明記 | Minor | S9 で実施済み |
| F8 — CLAUDE.md `team.json.masters` 記述の誤り | Minor | S10 で訂正済み |

### D3（`state.masters.set` の配置ガード）の状態

plan では「`state.masters.set` は boot 時復元と `MASTER_REGISTERED` handler の 2 箇所のみ」を守護条件としていたが、**F1 fallback の追加で 3 箇所に拡張**された。これは Design Review F1 の要求に伴う必然的な拡張であり、以下の位置に固定する:

```
daemon.ts:659   restoreMasters（boot 時復元）
daemon.ts:1118  SESSION_STARTED F1 fallback（取りこぼし復旧）
daemon.ts:1188  MASTER_REGISTERED handler（通常の self-register 経路）
```

他にはテストファイル（`daemon.test.ts:2004`）とコメント中の文字列参照（`master.ts:104` / `daemon.ts:708`）があるのみ。ガード grep は以下で 0 件（production 3 箇所のみを許容）:

```
rg -n 'state\.masters\.set' skills/cmux-team/manager
  → daemon.ts:659, 1118, 1188 + daemon.test.ts + コメント
```

## 4. TDD サイクル / 検証結果

### 最終検証

- **型チェック** `bunx tsc --noEmit`
  - 実行ディレクトリ: `skills/cmux-team/manager/`
  - 結果: **exit 0**（エラーなし）
- **テスト** `bun test`
  - 結果: **423 pass / 0 fail / 938 expect() calls / 20 files / 10.13s**
- **EventBus 直接使用ガード** `rg "bus\.(emit|on)\b" skills/cmux-team/manager | rg -v eventBus.ts`
  - 0 件維持を確認
- **D3 守護 grep** `rg -n 'state\.masters\.set' skills/cmux-team/manager`
  - production 3 箇所（§3 参照）。plan の 2 箇所から F1 fallback により 1 箇所増

### TDD サイクル要約

S1 / S2 / S3 / S5 の順で Red → Green → Refactor を回し、それぞれ対応するテスト（schema.test.ts の discriminated union 追加 / handleMessage ガード / registerSelfAsMaster 組込み / MASTER_REGISTERED handler）を先に書いて失敗を確認 → 実装 → pass を踏襲。F1 fallback (T4) と proxy-port 変更縮退 (T6) も同様に Red 先行で書いた。

## 5. 課題・次タスク候補

### 未実施（follow-up タスク化を推奨）

- **S12-1** `normalizeSurfaceForPath` の重複定義整理 — `master.ts` と `daemon.ts` で同名関数が独立定義されている。影響範囲（import 方向）を切り出すのが別 PR 相当のため、T230 のスコープからは外して別タスク化を推奨。
- **S12-2** `stopDaemon` 時の `clearInterval` 漏れ対応 — PID watcher 停止ハンドリング。既存コードの挙動整理も要するため、合わせて次タスクへ。
- **S12-3** `master.test.ts` の新規作成 — 現状 `master.ts` 固有のユニットテストは `daemon.test.ts` 経由でカバー。`persistMasterFile` / `deleteMasterFile` / `loadMasterFiles` の境界テストは別タスクで補強するのが望ましい。

### 運用上の注意

- `cmux-team spawn-master` は任意の pane から実行可能になり、意図せず 2 つ目以降の Master が増える可能性がある。`cmux-team status` / `team.json.masters` で実数が期待と合うか確認する運用になる。
- fail-fast により daemon 未起動時は exit 1 で即座に落ちる。旧挙動（Master だけ起動して後で再接続）を期待しているスクリプトがあれば破壊的変更になる。README / リリースノートで告知要。
- `MasterStateSchema.status` に `"starting"` が追加されたため、旧 JSON（status: `"idle"` 固定）は前方互換のままだが、他サービスが列挙 switch していた場合は fallthrough を確認。

## 6. 関連ファイル

- plan: `.team/tasks/230-master-self-register-pane-cmux-team-spawn-master/runs/task-230-1776382576/plan.md`
- design review: `.team/tasks/230-master-self-register-pane-cmux-team-spawn-master/runs/task-230-1776382576/design-review.md`
- 本レポート: `.team/tasks/230-master-self-register-pane-cmux-team-spawn-master/runs/task-230-1776382576/impl-report.md`
