# T245 Research: Master surface disconnected エントリの削除ポリシー

## 1. 調査の前提(現状の挙動)

### 1.1 disconnected 化の経路

1. **SESSION_ENDED (reason != other)** で Master の `status` を `disconnected` に遷移（`skills/cmux-team/manager/daemon.ts:1332-1352`）。`pid` を `undefined` にし `disconnectedAt` を記録、`persistMasterFile` でファイルへ書き戻す。
2. **PID watcher の dead 検出**（`__testSpawnMasterPidWatcherTick`、`daemon.ts:2024-2050`）でも同様に `status=disconnected` + `pid=undefined` + `disconnectedAt` を記録して永続化する。watcher は dead 検出後に自分自身の interval を clear するため、以降 pid ベースの監視は動かない。
3. SESSION_ENDED の `reason="other"` は `insertHookSignal` への記録のみで state 遷移しない（T216、`daemon.ts:1320-1330`）。`/clear` 直後の曖昧な終了通知を誤判定しないための保険。

### 1.2 disconnected エントリが残る理由

- 現在 Master 側には Conductor の `monitorConductors` → `forceCloseDisconnectedConductor`（`daemon.ts:2152-2199`）のような定期 GC が存在しない。
- `state.masters` からエントリが削除されるのは以下のみ:
  - 起動時の `restoreMasters`（pid 欠落 or dead の場合は `deleteMasterFile` で unlink、`daemon.ts:663-705`）
  - `proxy_port_changed` → `removeMaster`（`daemon.ts:728`）
  - fallback cleanup: CONDUCTOR_REGISTERED / AGENT_SPAWNED で `fallback:true` 仮登録を掃除（`daemon.ts:1217-1228 / 1028-1039`）
  - 明示的な呼び出しのみ。disconnected 状態そのものを契機とした削除経路は無い。
- したがって一度 disconnected になったエントリは daemon 再起動まで永続する（`updateTeamJson` が `state.masters.values()` をそのまま書き戻すため `team.json` にも `.team/masters/<surface>.json` にも残り続ける）。

### 1.3 実例（~/git/Dear）

```json
// ~/git/Dear/.team/team.json の masters 抜粋
[
  { "surface": "surface:62", "status": "idle", "pid": 7367, "startedAt": "...08:28:48Z" },
  { "surface": "surface:67", "status": "disconnected", "startedAt": "...09:37:29Z" },
  { "surface": "surface:72", "status": "idle", "pid": 96454, "startedAt": "...10:52:51Z" }
]
```

`.team/masters/surface_67.json`:

```json
{
  "surface": "surface:67",
  "status": "disconnected",
  "startedAt": "2026-04-17T09:37:29.258Z",
  "disconnectedAt": "2026-04-17T10:07:58.981Z"
}
```

disconnectedAt から 4 時間以上経過しても残っており、TUI の `buildMasterSection`（`dashboard.tsx:338-380`）は ⚠ + `disconnected` として黄色ラベルを表示し続ける。

## 2. サブ質問ごとの調査結果

### 2.1 どの条件で削除すべきか

候補 (a)-(d) を以下の観点で評価:

- **再現性**: 確実に発火するか
- **人間介入**: ユーザー操作が必要か
- **実装負荷**: コード量 / 既存パターンとの整合
- **副作用**: 誤削除や復旧不能リスク
- **設計原則との整合**: CLAUDE.md「上位が下位を監視する（pull 型）」「異常検知時のリカバリーは人間に委ねる」「決定論的なものはコードで」

| 選択肢 | 再現性 | 人間介入 | 実装負荷 | 副作用 | 原則整合 |
|--------|--------|---------|---------|--------|---------|
| (a) time-based GC | ◎ 必ず発火 | 不要 | 小（`monitorConductors` と対称の 1 関数） | 小（disconnected のみ対象、SESSION_STARTED 復帰の窓は確保） | ◎ Conductor の forced cleanup と同じ形 |
| (b) cmux tree ポーリング | ○ tree が返せば確実 | 不要 | 中（tree JSON パース + workspace 指定） | 中（tree は cmux daemon deadlock を引き起こす A011 の前科があり T195 で監視用途からは完全撤廃済み） | ✗ 「T195 以降 `cmux tree` / `list-status` への依存は完全撤廃」と真っ向から矛盾 |
| (c) TUI dismiss キー | ○ ユーザーがキーを押したとき | 必要 | 中（`dashboard.tsx` の Master section にカーソル / キーハンドラ追加） | 小 | ○ 明示操作なので誤削除リスクなし |
| (d) CLI `forget-master` | ○ 呼べば確実 | 必要 | 小（既存 `spawn-master` / `kill-agent` の型と同じ cmdXxx + message 経路） | 小 | ○ 既存の手動介入 CLI と同じ形 |

**(b) は却下**: CLAUDE.md 「ループ継続・アイドル化」「Manager プロトコル」で `cmux tree` を監視系から排除した経緯（T195）と、A011 で記録された cmux deadlock リスクに真っ向から反する。状態確認のためだけに tree を呼び戻すのは退行。

**(a) を第一選択**: `monitorConductors` の `DISCONNECT_TIMEOUT_SEC` → `forceCloseDisconnectedConductor` と完全に対称。Conductor 側が既に「一定時間 disconnected が継続したら forced cleanup」を採用しており、Master 側だけ同じ原則を適用しないのは不整合。time-based GC は「disconnected 状態が N 分継続したら GC」という決定論的ルールで、AI 判断を介さず実装可能。

**(d) を第二選択（escape hatch）**: (a) の N 分を待てないケース（テスト、デバッグ、明らかに pane が消えていると分かっているとき）のための手動口。既存の `spawn-master` / `kill-agent` と対称な `cmux-team forget-master --surface <id>` として追加。

**(c) は非スコープ**: ユーザー体験としては良いが、(a)+(d) で問題は解決する。TUI のカーソル操作・キーハンドリングを Master section に足すのは現状の dashboard アーキテクチャ（`focusedArea: "global" | "tasks" | "journal" | "log" | "artifacts"` — `dashboard.tsx:312`）の拡張が必要で、費用対効果が見合わない。将来必要になったら別タスクで追加する。

### 2.2 削除のリスク — 同 surface で Master が復帰するケース

#### surface ID の再利用について

`cmux tree` と `cmux --json tree` の実出力を確認したところ、`surface:N` の N はワークスペースごとの連番で、一度作成された surface ID は close 後も基本的には再利用されない（単調増加）。実例: Dear ワークスペースの現在の Master は surface:62 / :67 / :72 と散発的で、close で空いた番号を穴埋めしていない。したがって**「削除したら別の用途で同 surface が再作成されて衝突する」リスクは実質ゼロ**。

#### SESSION_STARTED 復帰経路の確認

`daemon.ts:1059-1077` の SESSION_STARTED ハンドラ:

```typescript
case "SESSION_STARTED": {
  // Master surface チェック
  const master = state.masters.get(message.surface);
  if (master) {
    master.pid = message.pid;
    master.status = "idle";
    master.disconnectedAt = undefined;
    // ...
  }
```

- **エントリが state.masters に残っていれば**: 同 surface で SESSION_STARTED が飛んできた場合、既存エントリを復活させる（pid 設定・idle 化・disconnectedAt クリア）。
- **エントリを削除した後で**: `state.masters.get(surface)` が undefined → agent チェック → fallback 経路（`daemon.ts:1174-1208`）で `fallback:true` の新 entry を作成 → 後続の `MASTER_REGISTERED`（`cmdLaunchMaster` → `registerSelfAsMaster`）で fallback フラグが落とされる（`daemon.ts:1270-1285`）。

`cmdLaunchMaster`（`main.ts:1853-1906`）は **必ず** claude exec 前に `registerSelf("master", surface)` で `MASTER_REGISTERED` を POST する。つまり Master が再起動される経路では必ず MASTER_REGISTERED が先に来るか、遅れても fallback に上書きで合流する。**entry が消えていても再登録は正常に完了する。**

結論: **削除しても復帰パスは壊れない**。むしろ同 surface が再利用される極稀なケースでも、古い disconnected entry が新規 MASTER_REGISTERED の「既存スキップ」経路（`daemon.ts:1268-1290` idempotent skip）を誤発動させて pid/startedAt を壊す方が怖い — 積極的に掃除した方が安全。

### 2.3 永続ファイル `.team/masters/<surface>.json` の扱い

既存の `removeMaster`（`daemon.ts:760-780`）は:

1. `master.pidWatcherInterval` を clearInterval（再 watcher 起動対策）
2. `state.masters.delete(surface)`
3. `await deleteMasterFile(state.projectRoot, surface)` — `.team/masters/<surface>.json` を unlink
4. `master_removed ... reason=<理由>` をログ
5. `notifyStateChanged` で TUI refresh 発火

**state とファイルの両方を removeMaster 一本で掃除済み。GC / forget-master いずれも `removeMaster` を呼ぶだけでよい。** 新規のファイル操作関数を書く必要はない。

### 2.4 `team.json` への反映

`updateTeamJson`（`daemon.ts:2225-2266`）は:

```typescript
teamJson.masters = [...state.masters.values()].map((m) => ({
  surface: m.surface,
  status: m.status,
  pid: m.pid,
  startedAt: m.startedAt,
}));
```

`state.masters` から派生して書き出す。**state.masters から消えれば次回の `updateTeamJson` で team.json.masters[] からも自動的に除外される。** 呼び出し側で `team.json` を明示的に書き換える必要はない。`notifyStateChanged` → `updateTeamJson` の既存フロー（daemon tick 内）に乗る。

### 2.5 TUI 側のエクスペリエンス

disconnected エントリを即消しすると:
- 画面からは「そこに Master があった」痕跡が消える
- ただし `.team/logs/manager.log` に以下が残る:
  - `master_session_ended U[67] reason=...` （disconnected 化時）
  - `master_removed U[67] reason=gc_timeout` or `reason=forget-master` （削除時）
- `.team/traces/traces.db` の `hook_signals` にも SessionEnd の raw が保全される（T216）

**ログに十分な痕跡が残るため、TUI から消えること自体は問題にならない**。将来的に「最近の Master 履歴」タブが欲しくなったら Journal / Artifact の仕組みを使えばよい（本タスクでは非スコープ）。

## 3. 選択肢の比較表

| | (a) time-based GC | (b) cmux tree poll | (c) TUI dismiss | (d) CLI forget-master |
|---|---|---|---|---|
| **Pros** | 自動、決定論、既存 `monitorConductors` と対称 | surface 消失を正確に検知できる | 即時反映、ユーザーの意図が明示 | 即時反映、既存 CLI 体系と整合 |
| **Cons** | タイマー待ちが発生（~10 分） | T195 で撤廃した依存を復活、cmux deadlock 再燃 | 既存 dashboard に新しい focus area が必要で実装重い | 手動、surface ID を知っている必要がある |
| **再現性** | ◎ | ○ | △ | ○ |
| **設計整合** | ◎（Conductor 側と対称） | ✗（T195 方針違反） | ○ | ○ |
| **採用** | ★ 主 | ✗ | 次版 | ★ 副 |

## 4. 参考コード箇所

- `skills/cmux-team/manager/daemon.ts`
  - `removeMaster` — `daemon.ts:760-780`（state + ファイル + watcher 一括掃除、本タスクの中核 API）
  - `SESSION_ENDED` ハンドラの Master 分岐 — `daemon.ts:1320-1352`
  - `MASTER_REGISTERED` ハンドラ（idempotent merge）— `daemon.ts:1261-1318`
  - `SESSION_STARTED` ハンドラ Master 復活経路 — `daemon.ts:1059-1077`
  - `SESSION_STARTED` fallback 経路 — `daemon.ts:1174-1208`
  - `restoreMasters`（boot 時 pid dead discard）— `daemon.ts:663-705`
  - `__testSpawnMasterPidWatcherTick` — `daemon.ts:2024-2050`
  - `monitorConductors`（参照: 対称に設計する）— `daemon.ts:2097-2146`
  - `forceCloseDisconnectedConductor`（参照: Conductor の time-based 強制クリーンアップ）— `daemon.ts:2152-2199`
  - `DISCONNECT_TIMEOUT_SEC = 300` — `daemon.ts:2087`（Conductor 用、Master 用も同系統の定数で実装）
  - `updateTeamJson` — `daemon.ts:2225-2266`（state.masters → team.json 自動派生）
- `skills/cmux-team/manager/schema.ts`
  - `MasterStateSchema` / `MasterState` — `schema.ts:164-184`（`disconnectedAt` / `pidWatcherInterval` / `fallback` フィールド）
- `skills/cmux-team/manager/dashboard.tsx`
  - `buildMasterSection` — `dashboard.tsx:338-380`（disconnected の ⚠ YELLOW 表示）
- `skills/cmux-team/manager/main.ts`
  - `cmdLaunchMaster`（`spawn-master`）— `main.ts:1853-1906`（CLI 参照実装）
  - `registerSelf` — `main.ts:1166-1181` 周辺（`MASTER_REGISTERED` POST）
  - サブコマンド switch — `main.ts:3715-3795`（`forget-master` の追加先）
- `skills/cmux-team/manager/master.ts`
  - `deleteMasterFile` / `persistMasterFile` / `listMasterFiles`（`removeMaster` が呼ぶ低レベル API）
- `docs/spec/05-install-and-infrastructure.md`
  - `.team/masters/` セクション — L383-397（GC 挙動を追記する箇所）
  - Conductor status enum — L233-241（Master 側にも disconnected の扱いを明記する際の参考）
- `~/git/Dear/.team/team.json` / `~/git/Dear/.team/masters/surface_67.json`（実発生事例）

## 5. まとめ

- **採用**: (a) time-based GC を主、(d) `cmux-team forget-master` CLI を副として併用
- **却下**: (b) cmux tree 監視（T195 方針違反）
- **非スコープ**: (c) TUI dismiss キー（将来のエンハンス）
- **根拠**: 既存 `monitorConductors` + `forceCloseDisconnectedConductor` パターンと対称性を維持、`removeMaster` 一本で state/ファイル/TUI が整合、復帰経路は MASTER_REGISTERED / SESSION_STARTED どちらでも壊れない、surface ID は実質再利用されないため衝突リスクゼロ

詳細な決定内容・実装アウトラインは `.team/artifacts/A013-master-surface-forget-policy.md` に記載。
