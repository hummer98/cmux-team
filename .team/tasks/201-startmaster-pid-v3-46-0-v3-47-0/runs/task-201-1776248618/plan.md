# Plan: T201 startMaster PID フォールバック実装

## Goal

`team.json` に `master.pid` が書かれていない既存環境（v3.46.0 → v3.47.0 マイグレーション中の Master セッション）で daemon を再起動した際、`startMaster` が surface 経由のフォールバックで既存 Master を生存と判定し、重複 spawn しないようにする。受け入れ基準: pid 不在でも surface 生存ならば `master_restored`、surface 不在ならば `master_check_failed` → spawn の挙動に戻す。

## 設計判断

### 採用: Option A — pid 未登録時は surface 検証にフォールバック

`startMaster` 内の生存判定を「pid あり → `isMasterAlive`、pid なし → cmux 経由の surface 存在確認」の二段構えにする。マイグレーション互換性のための限定経路として位置づけ、`master_alive_via_surface_fallback` という dedicated event でログを残し、後で影響を追跡できるようにする。

採用理由:

- **最小変更で互換性回復**: 変更箇所は `daemon.ts:startMaster` の 1 ブロックと、`cmux.ts` から既に export 済みのヘルパーの呼び出しのみ
- **既存マーカーフォーマットを変えない**: `.team/master.surface` の書式は維持。他のリーダーへの影響なし
- **影響範囲が限定的**: T195 で削除された `cmux tree` 依存は監視ループ（`tick()` 系）からは消えており、復活は **daemon 起動時 1 回限り** の `startMaster` 経路のみ。常時ポーリングコストは戻らない
- **意味論的に明示的**: "pid 不明だから surface で代用する" という互換経路を `if/else` で分岐して書ける。将来的に「pid 必須」に統一する際の削除ポイントが 1 箇所に集まる

### 不採用: Option B（ps による pid 発見）

- macOS / Linux で `ps` の出力フォーマットが揃わず実装が脆い
- プロンプトファイルパスや `claude` バイナリ名でのマッチングは Volta / nvm / 別 Claude 起動方式（`claude code`, `cmux-team spawn-master` ラッパー）で容易に外れる
- フォールバックなのに最も複雑で、デバッグ困難な失敗モードを増やす

### 不採用: Option C（マーカーに pid 併記）

- 既存マーカー `.team/master.surface` のフォーマット変更が必要で、書き込み箇所（`master.ts:spawnMaster`）と読み込み箇所の両方を更新する必要がある
- マイグレーション中はマーカーが古いフォーマットのまま残るので、結局「pid 無しでも生存判定する」フォールバック（= Option A）が必要になる
- 将来 PID 経路に統一できる時点で破棄したい一時的な互換コードに、永続フォーマット変更で対応するのは過剰

### 不採用: Option D（SESSION_STARTED 強制 push）

- 「Master は独立プロセスで、自分から hook を push する」という現アーキテクチャの境界を daemon 側が越える必要がある
- T201 の対象は **既に起動済みで hook 経路が無効化された Master** なので、後付けで push を発生させる手段がそもそも難しい（プロセス内に介入できない）

## 実装の要点

T195 (commit 6e44637) を読み直したところ、cmux.ts の関数名 `validateSurface` は **既に存在しない**（grep で 0 件）。代わりに `cmux.getPaneForSurface(surface, workspace)` が残っており、これは内部で `cmux tree --workspace <id>` を 1 回呼んで対象 surface を含む pane 名を返す（不在なら `undefined`）。これを「surface 生存確認」として再利用する。新しい関数を増やす必要はない。

## 変更点詳細

### 1. `skills/cmux-team/manager/daemon.ts:startMaster` の生存判定ブロック

現在の実装（daemon.ts:467-494 抜粋）:

```typescript
try {
  if (existsSync(teamJsonPath)) {
    const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
    const pid = teamJson?.master?.pid;
    if (typeof pid === "number") restoredMasterPid = pid;
  }
} catch (e: any) {
  await log("master_check_error", `team.json read failed: ${e.message}`);
}

const alive = restoredMasterPid != null && await isMasterAlive(state.projectRoot);
if (alive) { ... }
await log("master_check_failed", `${formatSurface(surface, "U")} alive=false`);
```

変更後:

```typescript
// pid あり: 通常の PID 経路（T195 以降の標準）
// pid なし: surface 生存確認にフォールバック（v3.46.0 → v3.47.0 マイグレーション互換）
let alive = false;
let aliveVia: "pid" | "surface_fallback" | null = null;
if (restoredMasterPid != null) {
  alive = await isMasterAlive(state.projectRoot);
  if (alive) aliveVia = "pid";
} else {
  const pane = await cmux.getPaneForSurface(surface, state.workspace ?? undefined);
  alive = pane !== undefined;
  if (alive) {
    aliveVia = "surface_fallback";
    await log(
      "master_alive_via_surface_fallback",
      `${formatSurface(surface, "U")} pane=${pane} reason=team_json_pid_missing`
    );
  }
}
```

そして既存の `if (alive) { ... }` ブロックの中の `master_restored` ログに `via=${aliveVia}` を付与する:

```typescript
state.masterSurface = surface;
state.masterPid = restoredMasterPid;  // フォールバック経路では undefined のまま
state.masterStatus = "idle";
if (restoredMasterPid != null) {
  spawnMasterPidWatcher(state, restoredMasterPid);
}
await log(
  "master_restored",
  `${formatSurface(surface, "U")}${restoredMasterPid != null ? ` pid=${restoredMasterPid}` : " pid=unknown"} via=${aliveVia}`
);
return;
```

注意点:

- **`state.masterPid` はフォールバック経路では埋めない**。PID が分からないため。次に Master が `SESSION_STARTED` を push した時点で `daemon.ts:744` の経路で埋まる。それまでは `state.masterPid = undefined` のまま動作する（現在の v3.47.0 環境と同じ状態）
- **`spawnMasterPidWatcher` はフォールバック経路では起動しない**。PID 不明では監視できないため。`SESSION_STARTED` 受信時に `daemon.ts:748` で起動される経路に委ねる
- **proxy ポート変化時の再 spawn 経路（`state.proxyPortChanged === true`）はそのまま**。port 変化時は alive でも closeSurface して再 spawn したいので、フォールバック経路でも従来通り fall-through する。具体的には `if (alive)` の中の既存ロジック（`if (state.proxyPortChanged)` ブランチ）は変更しない

### 2. import 確認

`daemon.ts:17` で `import * as cmux from "./cmux"` 済み。`cmux.getPaneForSurface` はそのまま呼べる。新規 import 不要。

### 3. ログ・トレース観点

新しいイベント名:

| event | 発生条件 | detail フォーマット |
|---|---|---|
| `master_alive_via_surface_fallback` | pid 無しで surface 検証 OK | `U[NN] pane=pane:NN reason=team_json_pid_missing` |
| `master_restored` (既存 + via=) | 復元成功時、経路を区別 | `U[NN] pid=<num\|unknown> via=<pid\|surface_fallback>` |

`master_alive_via_surface_fallback` がログに出るかどうかで「マイグレーション互換コードが発動した環境」を識別できる。発動が完全に消えれば、将来 Option A のフォールバック分岐を削除できる判断材料になる。

### 4. テスト追加

`skills/cmux-team/manager/daemon.test.ts` に `describe("startMaster pid fallback", ...)` ブロックを追加する。`cmux.__setTreeImpl` が既に export されている（cmux.ts:133）ので、これでモック化する。

テストケース:

| # | シナリオ | team.json master.pid | tree() の出力に surface あり | isMasterAlive | 期待結果 |
|---|---|---|---|---|---|
| 1 | pid あり + プロセス生存（既存挙動） | あり | — | true | `state.masterSurface` 設定、`master_restored` ログに `via=pid`、spawn しない |
| 2 | pid あり + プロセス死亡（既存挙動） | あり | — | false | spawn する |
| 3 | **pid なし + surface 生存（新規）** | なし | あり | — | `state.masterSurface` 設定、`master_alive_via_surface_fallback` ログ、`state.masterPid === undefined`、spawn しない |
| 4 | **pid なし + surface 不在（新規）** | なし | なし | — | spawn する |
| 5 | マーカー無し（既存） | — | — | — | spawn する |

実装ヒント:

- ケース 1, 2: `master.ts` の `isMasterAlive` を直接モックする方法が無いため、`team.json` に実際の PID（例えば `process.pid` = テストプロセス自身）を書いて生存を再現する（既存テストの慣習に合わせる）。死亡ケースは `team.json` に存在しない PID（例: `999999`）を書く
- ケース 3, 4: `cmux.__setTreeImpl((ws) => Promise.resolve(treeOutput))` で `tree()` をモック。`treeOutput` には surface 行を含める/含めないで切り替える
- `spawnMaster` 自体は cmux 操作するので、`cmux.__setTreeImpl` だけでは spawn パスを完全モックできない。spawn が「呼ばれた / 呼ばれない」の検証は **`master_spawning` ログが `manager.log` に出たかどうか** で代替する（既存テストでも `manager.log` 末尾検査の慣習がある）

新規テスト追加先:

- 既存 `daemon.test.ts` に追記（ファイルを増やさない方針）。ただし `startMaster` を直接 import する必要があるので、現在の test ファイル冒頭の dynamic import パターン（`await import("./daemon")`）に倣って `await import("./daemon").then(m => m.startMaster)` で呼び出す

### 5. 影響範囲（変更ファイル一覧）

| ファイル | 変更内容 | 行数の概算 |
|---|---|---|
| `skills/cmux-team/manager/daemon.ts` | `startMaster` の `if (alive)` 判定ブロックを if/else に分岐 + `master_alive_via_surface_fallback` ログ追加 + `master_restored` ログに `via=` 付与 + `state.masterPid` をフォールバック経路で undefined のまま維持 + `spawnMasterPidWatcher` をフォールバック経路でスキップ | +20〜30 行 |
| `skills/cmux-team/manager/daemon.test.ts` | `describe("startMaster pid fallback", ...)` 追加（5 ケース） | +120 〜 150 行 |

`master.ts`、`cmux.ts` への変更は **不要**。

### 6. ドキュメント更新

このフォールバック経路は「v3.46.0 → v3.47.0 のマイグレーション互換」という限定目的なので、CLAUDE.md やユーザー向けドキュメントへの追記は不要。コード内コメント（前述の if/else の上 1 行）でその旨を明記する。

## 検証手順

ローカル検証コマンド:

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-201-1776248618/skills/cmux-team/manager

# 1. 既存テストが壊れていないことを確認
bun test daemon.test.ts

# 2. 新規追加した startMaster pid fallback ブロックだけ実行
bun test daemon.test.ts -t "startMaster pid fallback"

# 3. cmux.test.ts も念のため通しておく（getPaneForSurface 周り）
bun test cmux.test.ts

# 4. 全テスト
bun test
```

E2E 観点（Implementer は手動でやらなくて良いが、リリース後に確認できるよう手順を残す）:

1. `team.json` をバックアップ
2. `team.json` から `master.pid` フィールドを手で削除
3. `cmux-team stop` → `cmux-team start`
4. `manager.log` を確認:
   - `master_alive_via_surface_fallback U[NN] pane=...` が出ていること
   - `master_restored U[NN] pid=unknown via=surface_fallback` が出ていること
   - `master_spawning` / `master_spawned` が **出ていないこと**（重複 spawn が起きていない）
5. `team.json` を復元

## 受け入れ基準のチェック

| タスク本文の受け入れ基準 | この plan で満たされる箇所 |
|---|---|
| v3.46.0 以前から引き継いだ Master が v3.47.0+ の daemon 再起動で重複 spawn されない | `daemon.ts:startMaster` の if/else 分岐 + ケース 3 のテスト |
| team.json の master.pid 欄が空でも既存 Master を正しく復元できる | フォールバック経路で `state.masterSurface` を設定し `return` する + ケース 3 のテスト |
| 既存 `daemon.test.ts` / `cmux.test.ts` が通る | 既存ロジックの分岐は `if (restoredMasterPid != null)` の中で従来通り。ケース 1, 2 で回帰確認 |
| 「team.json に master.pid 無し + surface 生存」のテスト追加 | ケース 3 として新規追加 |

## スコープ外（明示的に除外）

- **U[55] のゾンビ Master 掃除**: タスク本文の「副作用」セクションに「別タスクに切るか判断する」とある通り、本タスクではフォールバックの実装と既存 Master の正常復元のみを対象とする。ゾンビプロセスの kill は別タスク（必要であれば Master spawn 時に古い `.team/master.surface` の指す surface が異なれば close する処理を追加する別 PR）に切り出す
- **`state.masterPid` の埋め直し**: フォールバック経路では PID 不明のため `undefined` のまま。次回 Master が `SESSION_STARTED` を push したら自動で埋まる。ps 等で発見する仕組みは Option B として却下した通りスコープ外
- **マーカーフォーマット変更**: Option C として却下した通りスコープ外
