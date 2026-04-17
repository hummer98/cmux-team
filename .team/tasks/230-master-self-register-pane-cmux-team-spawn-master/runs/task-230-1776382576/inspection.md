# T230 検品レポート — Master self-register

- **role**: inspector-task-230
- **run_id**: task-230-1776382576
- **worktree**: `/Users/yamamoto/git/cmux-team/.worktrees/task-230-1776382576`
- **完了日時**: 2026-04-17

## Verdict: GO

## Summary

plan S1–S11・S13 + Final は完了しており、`MASTER_REGISTERED` メッセージ型 / `registerSelfAsMaster` / `cmdLaunchMaster` 組み込み / daemon handler / F1 fallback / proxy-port 変化時の再 spawn / docs/spec 更新・CLAUDE.md 修正までが整合している。型チェック `bunx tsc --noEmit` は exit 0、`bun test` は **423 pass / 0 fail**、D3 守護 grep は `state.masters.set` 3 箇所（659 / 1118 / 1188）で想定通り。S12（normalizeSurfaceForPath 統合 / stopDaemon clearInterval / master.test.ts）のみ follow-up 送りで impl-report に明記されており Critical ではない。Critical 0 / Major 0 / Minor 3 で GO 基準（Critical 0 AND Major ≤ 2）を満たす。

## Findings

### 1. [minor] S12 follow-up タスクが未起票

- **観測**: impl-report §5 で S12-1 / S12-2 / S12-3 を follow-up 推奨としているが、`.team/tasks/` 配下に対応する task 起票は無し（本タスク内で確認した範囲）。
- **影響**: 実害は無いが「推奨」が宙に浮くと T229 Minor と同じ状態に戻る可能性あり。
- **推奨**: マージ後に `cmux-team create-task --status ready` で 3 件起票する運用で十分。ブロッカーではない。

### 2. [minor] F1 fallback の対象範囲がコメント信頼ベース

- **場所**: `daemon.ts:1104-1133`
- **観測**: `SESSION_STARTED` で `master/conductor/agent` の何れにも該当しない場合に **master として仮登録**する。コメントで「agent/conductor は事前登録されるためここに来るのは実質 master のみ」と説明されているが、`CONDUCTOR_REGISTERED` の POST が極端に遅延した場合は conductor を master として誤登録する可能性が理論上残る。
- **影響**: 実運用では `registerSelfAsConductor` が claude exec の前に POST されるので通常は発生しない。後続の `CONDUCTOR_REGISTERED` 到達時点で `state.conductors` に個別に登録され、`state.masters` 側は `idempotent` でなく残ってしまう（削除経路は無い）。
- **推奨**: 別タスクで fallback 経路に「`CONDUCTOR_REGISTERED` 後に `state.masters` 側のエントリを掃除する」補正、または `SESSION_STARTED` の fallback に `reason=master_registered_not_received_yet` 以外の trace を足して事後分析可能にする検討。本タスクでは許容。

### 3. [minor] `registerSelfAsMaster` / `registerSelfAsConductor` のコード重複

- **場所**: `main.ts:1169-1204` / `main.ts:1217-1252`
- **観測**: ほぼ同一構造のヘルパーが並列で存在（fail-fast / fetch / exit 1 / log）。impl-report §3 F6 で意図的現状維持としている。
- **影響**: 保守コスト微増。将来的に Conductor / Master 以外の self-register ロールが追加される場合は共通化が妥当。
- **推奨**: 本タスクでは許容。別タスクで `registerSelf(role, surface)` に統合する follow-up を検討。

## 検査観点ごとの確認結果

### 1. 計画充足

- `spawnAndRegisterMaster` は daemon.ts から完全削除（`grep "spawnAndRegisterMaster" daemon.ts` → 0 件）。
- `registerSelfAsMaster` は `resolveProxyPort` → `fetch POST MASTER_REGISTERED` → `log("master_self_register", ...)` の 3 ステップ構成で T228 `registerSelfAsConductor` と同型。
- plan S1–S11 / S13 の検証コマンドは全て期待値を満たす。S12 は follow-up に退避（impl-report §5 明記）。

### 2. Dead/Zombie code

- `spawnAndRegisterMaster` の定義・呼び出しともに 0 件。
- `master.ts:spawnMaster` から `startedAt` 生成は削除済み。残る `startedAt` 参照は `persistMasterFile` payload 組み立て（正当）のみ。
- 旧 `state.master` (単数) への参照 0 件 (`grep "state\.master[^s]"` → 0)。
- 未使用 import 無し（`bunx tsc --noEmit` exit 0）。

### 3. テスト

- `bun test` → **423 pass / 0 fail / 938 expect() / 20 files / 14.3s**。
- `daemon.test.ts` に `describe("handleMessage: MASTER_REGISTERED (T230)")` が存在。T1 新規登録 / T2 idempotent skip（6 フィールド保護）/ T3 pid 同梱 watcher 起動 / T4 F1 fallback / T5 状態遷移 / T6 proxy-port 変更縮退 を確認。

### 4. 設計原則

- `state.masters.set` の出現位置は `daemon.ts:659`（restoreMasters）/ `daemon.ts:1118`（SESSION_STARTED F1 fallback）/ `daemon.ts:1188`（MASTER_REGISTERED handler）の 3 箇所で一致。plan の 2 箇所から F1 対応で 1 箇所増えるのは Design Review F1 の妥当な拡張。
- `registerSelfAsMaster` と `registerSelfAsConductor` は並列構造で DRY 的には重複だが可読性優先で許容（Finding 3）。

### 5. 統合

- `cmdLaunchMaster` (`main.ts:1889-`) は `resolveCallerSurfaceOrExit()` の直後・`generateMasterPrompt` の前で `await registerSelfAsMaster(surface)` を呼ぶ。
- `MASTER_REGISTERED` は `schema.ts:123` で `QueueMessage` discriminated union に追加されている。
- `handleMessage` の switch に `case "MASTER_REGISTERED":` (`daemon.ts:1169`) が存在し、重複登録時は skip + log、新規時は set + persist + 条件付き watcher + notifyStateChanged。
- fail-fast: `resolveProxyPort()` の戻り値が falsy なら `process.exit(1)`、POST 失敗（`!res.ok` or throw）も exit 1。

### 6. 型エラー

- `bunx tsc --noEmit` → **exit 0**（エラーなし）。

### 7. docs/spec / CLAUDE.md

- `docs/spec/01-skill-cmux-team.md`: `cmux-team spawn-master` の行が self-register / fail-fast / 任意 pane 起動可を明記する記述に更新。
- `docs/spec/05-install-and-infrastructure.md`: `spawn-master` 行 + `.team/masters/` ライフサイクル節が MASTER_REGISTERED 経路 + F1 fallback + `startMaster` の復元 0 件時 1 個自動起動に更新。
- `CLAUDE.md`: `team.json.masters` のフィールド列挙が実装と一致する `{ surface, status, pid?, startedAt }` に修正、T230 追記あり。

### 受け入れ条件

- [x] `MASTER_REGISTERED` が schema.ts に定義されている
- [x] `cmdLaunchMaster` 内で self-register が実行される
- [x] 任意の pane で `cmux-team spawn-master` → 複数 Master 共存可能（コードパスを確認 / E2E は未実施だが handler 単体テストで担保）
- [x] daemon boot 時の復元以外で `state.masters` を直接 set している箇所が MASTER_REGISTERED handler + F1 fallback のみ
- [x] 既存 1 Master 運用が壊れない（423 pass）
- [x] 重複 register で既存 state が破壊されない（T2 テストが証明）
- [x] docs/spec 更新済み
