---
id: A013
type: decision
title: "Master surface disconnected エントリの削除ポリシー"
created: 2026-04-17T17:30:46Z
author: surface:108
task: T245
tags: [master, tui, lifecycle, daemon]
---

> **採番メモ**: 元タスクは A012 を想定していたが、A012 は `A012-master-fallback-root-cause-t244.md`（T244）として既に採番済みのため、`ls .team/artifacts/` の最大番号 +1 ルールに従い A013 とした。以降の参照は A013 で扱う。

## 決定事項

以下の**併用**を採用する:

1. **(a) 時間ベースの自動 GC を主経路とする**
   `monitorConductors` と対称の `monitorMasters` を daemon の tick に追加し、`state.masters` の中で `status === "disconnected"` かつ `disconnectedAt` から **`MASTER_DISCONNECT_GC_SEC`（デフォルト 600 秒 = 10 分）** 経過したエントリを `removeMaster(state, surface, "gc_disconnect_timeout")` で削除する。

2. **(d) CLI escape hatch `cmux-team forget-master --surface <id>` を副経路として追加**
   手動で即座に掃除したいケース（テスト・明らかに pane が消えていると分かるとき）のため、daemon へ `FORGET_MASTER` メッセージを POST する CLI を実装。daemon 側ハンドラは対象 surface の Master が `state.masters` にあれば（status 問わず）`removeMaster` を呼ぶ。

(b) cmux tree ポーリングは**却下**。(c) TUI dismiss キーは**非スコープ**（将来の UX エンハンス）。

## 理由

### 採用理由

| 観点 | (a) + (d) の適合性 |
|------|-------------------|
| 既存パターンとの整合 | `monitorConductors` → `forceCloseDisconnectedConductor`（`daemon.ts:2097-2199`、`DISCONNECT_TIMEOUT_SEC=300s`）と同じ形。Master 側だけ GC が無い不整合を解消 |
| CLAUDE.md 設計原則 | 「上位が下位を監視する（pull 型）」「決定論的なものはコードで」「異常検知時のリカバリーは人間に委ねる」に合致。自動 GC は削除のみで復旧は試みない |
| API 再利用 | `removeMaster`（`daemon.ts:760-780`）が state + `.team/masters/<surface>.json` + pidWatcherInterval を一括掃除済み。新規ファイル操作不要 |
| team.json 反映 | `updateTeamJson` が `state.masters.values()` から派生するため、削除が自動反映される |
| 復帰安全性 | `MASTER_REGISTERED` ハンドラは existing 無ければ新規 insert、SESSION_STARTED fallback 経路も未登録 surface を仮登録する。entry 削除後に同 surface で Master が再起動しても復帰は壊れない |
| surface 衝突リスク | cmux は surface ID を単調増加で払い出し、close された番号を再利用しない運用実態（実例: Dear ワークスペース surface:62/67/72 の飛び番）。削除後に同 ID 衝突は実質ゼロ |

### 却下理由

- **(b) cmux tree ポーリング**: CLAUDE.md「T195 以降 `cmux tree` / `cmux list-status` への依存は完全撤廃。Conductor / Agent / Master の生存確認は PID ベース + hook push に一本化」と真っ向から矛盾。A011 の cmux daemon deadlock 再発リスク。監視のために撤廃した依存を復活させる退行。
- **(c) TUI dismiss キー**: `dashboard.tsx` の `focusedArea` enum（`global|tasks|journal|log|artifacts`）に `masters` セクションを追加する必要があり、(a)+(d) で解決する問題に対して費用対効果が見合わない。将来必要なら別タスクで。

## リスクと緩和策

| リスク | 発生条件 | 緩和策 |
|--------|---------|--------|
| **ユーザーが pane を一時的に閉じて後で開き直す** と、GC 後に `state.masters` エントリが消えている | 10 分以上 pane 不在が続く | SESSION_STARTED fallback 経路（`daemon.ts:1174-1208`）で `fallback:true` 仮登録 → 続く MASTER_REGISTERED で fallback 確定（`daemon.ts:1270-1285`）。**復帰する経路自体は保証されている**。ユーザー体験としては「履歴が消えて新規 Master 扱いになる」だけ |
| **surface ID が偶然再利用されて別用途で使われる** | cmux 実装が surface ID を再利用する仕様になった場合 | `removeMaster` でファイル・state・watcher まで一括削除するため古いエントリが残っていないのでむしろ衝突回避になる。**現状はリスクなし** |
| **GC 閾値が短すぎて、短時間の pane 切り替え中に削除される** | ユーザーが頻繁に pane を re-arrange する運用 | デフォルト 600 秒 = 10 分（Conductor の 300 秒より長く設定、Master はユーザーセッションで意図的再開の可能性が高いため）+ env `CMUX_TEAM_MASTER_GC_SEC` で上書き可能 |
| **master_gc_removed ログが埋もれる** | 高頻度イベントに飲み込まれる | `formatSurface` 経由の U プレフィックスログ（`master_gc_removed U[67] reason=gc_disconnect_timeout elapsed=620s`）で追跡可能。`.team/logs/manager.log` に追記されるので `grep master_gc` で十分 |
| **forget-master が生存中の Master を誤削除** | ユーザーの surface 指定ミス | CLI 側で disconnected 状態のチェックを **しない**（strict にすると deadlock 解消手段が狭まる）。ただし `state.masters.get(surface)?.pid` が生きている場合は `master_forget_warning` を WARN ログに出して続行。`--force` を要求する設計も検討可能だが MVP では不要 |

## 実装アウトライン

### 新規追加

#### 1. schema.ts: `FORGET_MASTER` メッセージ型

`.team/queue/` 経由で daemon に送る既存の Message zod union に以下を追加:

```ts
export const ForgetMasterMessage = z.object({
  type: z.literal("FORGET_MASTER"),
  surface: z.string(),
  timestamp: z.string().datetime(),
});
```

既存 `MasterStateSchema` / `MasterState` は変更なし（`disconnectedAt` は既存）。

#### 2. daemon.ts: `monitorMasters` 関数

`monitorConductors`（L2097）の直後に新規実装。

```ts
const MASTER_DISCONNECT_GC_SEC =
  Number(process.env.CMUX_TEAM_MASTER_GC_SEC) || 600;  // 10 分

export async function monitorMasters(state: DaemonState): Promise<void> {
  for (const [surface, master] of state.masters) {
    if (master.status !== "disconnected") continue;
    if (!master.disconnectedAt) continue;
    const elapsed = (Date.now() - new Date(master.disconnectedAt).getTime()) / 1000;
    if (elapsed > MASTER_DISCONNECT_GC_SEC) {
      await log(
        "master_gc_disconnect_timeout",
        `${formatSurface(surface, "U")} elapsed=${Math.round(elapsed)}s threshold=${MASTER_DISCONNECT_GC_SEC}s`,
      );
      await removeMaster(state, surface, "gc_disconnect_timeout");
    }
  }
}
```

呼び出し元: daemon tick ループ内（`monitorConductors` を呼んでいる箇所の直後）。tick 間隔は `CMUX_TEAM_POLL_INTERVAL`（デフォルト 10s）で十分。

#### 3. daemon.ts: `FORGET_MASTER` ハンドラ

`handleMessage` の switch に追加:

```ts
case "FORGET_MASTER": {
  const master = state.masters.get(message.surface);
  if (!master) {
    await log(
      "master_forget_not_found",
      `${formatSurface(message.surface, "U")} — not in state.masters`,
    );
    break;
  }
  if (typeof master.pid === "number" && cmux.isAlive(master.pid)) {
    await log(
      "master_forget_warning",
      `${formatSurface(message.surface, "U")} pid=${master.pid} is alive — forget anyway`,
    );
  }
  await removeMaster(state, message.surface, "forget_master");
  break;
}
```

#### 4. main.ts: `cmdForgetMaster` サブコマンド

`kill-agent` / `close-agent` / `spawn-master` と同じ形で追加。引数: `--surface <id>`（必須）。

```ts
async function cmdForgetMaster(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_forget_master"));
  const raw = requireArg("surface");
  const surface = await normalizeSurfaceArg(raw);
  await postMessage({
    type: "FORGET_MASTER",
    surface,
    timestamp: new Date().toISOString(),
  });
  console.log(`FORGET_MASTER sent: ${surface}`);
}
```

サブコマンド switch（`main.ts:3715-3795`）に `case "forget-master": await cmdForgetMaster(); break;` を追加。

#### 5. logger.ts のヘルプ文言（t() テンプレート）

`help_forget_master` キーを追加: 使用例・引数説明・期待動作を記載。既存の日本語ヘルプ体系に合わせる。

#### 6. docs/spec/05-install-and-infrastructure.md の更新

`.team/masters/` セクション（L383-397）に以下を追記:

> - **disconnected エントリの GC（T245）**: `monitorMasters` が tick ごとに `state.masters` の中で status=disconnected かつ `disconnectedAt` から `CMUX_TEAM_MASTER_GC_SEC`（デフォルト 600 秒）経過したエントリを `removeMaster` で削除する。`team.json.masters[]` と `.team/masters/<surface>.json` も自動的に同期される。
> - **手動 forget**: `cmux-team forget-master --surface <id>` で即時削除可能。daemon に `FORGET_MASTER` メッセージを POST し、ハンドラが `removeMaster` を呼ぶ。生存中の Master を指定した場合は WARN ログを出して削除する（生存チェックでのブロックはしない）。

### 変更不要な既存コード

- `removeMaster`: そのまま使える（watcher 停止 + state 削除 + ファイル削除 + ログ + notifyStateChanged）
- `updateTeamJson`: そのまま（state.masters から派生するため自動反映）
- `dashboard.tsx` `buildMasterSection`: 変更不要（entry が消えれば自然に表示が消える）
- SESSION_STARTED / MASTER_REGISTERED / SESSION_ENDED の各ハンドラ: 変更不要（復帰パスは既存で担保済み）

### テスト観点（Planner 向け参考）

- `monitorMasters`: disconnectedAt が閾値未満 → 何もしない、閾値超過 → `removeMaster` が呼ばれる、`status !== "disconnected"` のエントリは触らない、`disconnectedAt` undefined のエントリは触らない
- `FORGET_MASTER` ハンドラ: 存在する Master を削除、存在しない surface は no-op + ログ、生存 pid ありでも削除（WARN ログ付き）
- CLI `forget-master`: 必須引数なし → exit 1、正常系 → postMessage 呼び出し
- 既存動作の非退行: `master_session_started_fallback` 経路、MASTER_REGISTERED の fallback 確定、SESSION_ENDED → disconnected 遷移が壊れていないこと

## 非スコープ

- **(c) TUI dismiss キー**: `dashboard.tsx` の Master section にカーソル + `d` キーハンドラを追加する実装。(a)+(d) で問題は解消するため今回はやらない。将来必要になったら別タスクで追加。
- **disconnected の長期履歴保全**: 「最近削除された Master」タブや Artifact 化は不要。`.team/logs/manager.log` の `master_session_ended` / `master_gc_*` / `master_forget` ログで追跡可能。
- **閾値の自動調整**: tick ごとにアクセス頻度を見て閾値を動的に変える仕組みは過剰。環境変数 + デフォルト固定値で十分。
- **Conductor の GC 閾値変更**: Conductor 側の `DISCONNECT_TIMEOUT_SEC=300` は既存のまま（Master 側は 600 に設定して区別）。統一する必要は現時点ではない。
- **Master 再生成の自動化**: GC で削除した Master を再 spawn するロジックは入れない（CLAUDE.md「異常検知時のリカバリーは人間に委ねる」準拠）。ユーザーが必要なら `cmux-team spawn-master` で明示的に追加。
