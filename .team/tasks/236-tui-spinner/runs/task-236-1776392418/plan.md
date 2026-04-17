# T236 TUI: サブエージェント行に Spinner を実装する — 実装計画

## 1. 課題分析

### 現状の問題点

- `dashboard.tsx:489-511` の `buildConductorRow` 内 Agent ループは `ui.text(\`${icon} ${label}\`)` を静的に描画するのみ。Agent が running か idle か一見わからない。
- Conductor 側は `SPINNER_FRAMES[spinnerFrame % ...]` を `starting` / `assigning` / `running` の各状態で描画しており、稼働状況が視覚的に判別できる（`dashboard.tsx:361, 396, 407, 477`）。この対称性が Agent では欠落している。
- アニメーション駆動（`spinnerInterval` 内 `needsAnimation`, `dashboard.tsx:1319-1335`）は Master と Conductor の `status` しか見ておらず、Conductor が idle で Agent だけ running の状況では spinner フレームが前進しない。

### 根本原因

1. `AgentState`（`schema.ts:148-156`）に `status` フィールドが存在しない。`surface / role / spawnedAt / sessionId / pid / pidWatcherInterval` のみ。
2. Agent の hook シグナル経路（`AGENT_SPAWNED` → `SESSION_STARTED` → `SESSION_IDLE` → `SESSION_ENDED`、および稀に `SESSION_CLEAR`）は daemon.ts で個別にハンドルされているが、TUI 向けの状態機械（running/idle）が未構築。PID 追跡は生存確認のみで「idle になった」の検知には使えない（PID は idle のままでも生存する）。

### 影響範囲

| 層 | 影響 |
|---|---|
| schema | `AgentState` に `status` 追加（破壊ではなく拡張） |
| daemon | AGENT_SPAWNED / SESSION_STARTED / SESSION_IDLE / SESSION_CLEAR の Agent 分岐に状態遷移を追加。restoredAgents と updateTeamJson でシリアライズ対応 |
| TUI | `buildConductorRow` の Agent 描画と `spinnerInterval` の needsAnimation 条件 |
| 永続化 | `.team/team.json` の conductors[].agents[] に `status` が追加される（後方互換: 古い team.json を restore した場合は fallback 値を入れる） |
| spawn-agent / kill-agent / close-agent | 変更不要（daemon が AGENT_SPAWNED 経由で status をセット） |

非対象（task 記述より）:
- Agent の status に基づくタスク割り当てロジック変更
- 完了検知の根本改修（既存シグナルの範囲内で判定）

## 2. 技術アプローチ

### 選択したアプローチ

**「Conductor と同じ status 遷移パターンを Agent にも導入し、dashboard は Conductor と同じ spinnerFrame を流用する」**

状態遷移:

```
(AGENT_SPAWNED) ──▶ status=starting
                        │
     SESSION_STARTED    ▼
     (source=startup|resume) ──▶ status=running
                        │
     SESSION_IDLE ◀──┬──▶ status=idle
     SESSION_CLEAR   │
                     ▼
     (次の SESSION_STARTED / SESSION_ACTIVE / SESSION_STOP(ASK 以外)
      で status=running に復帰)
     SESSION_ENDED ──▶ agents 配列から削除（既存動作）
```

dashboard 側:

- `status === "running"` または `"starting"` のとき、role アイコン（⚙📝🔍 等）の代わりに `SPINNER_FRAMES[spinnerFrame % 4]` を描画。色は CYAN（Conductor の starting と同系統）で running/starting を示す。
- `status === "idle"` のとき、role アイコン + dim 表示（「idle」文字は追加しない。行が長くなりすぎるため）。
- `status === undefined`（古い team.json 復元時・restore 直後）の場合は「idle 相当」で描画してフォールバック（status が定まれば次の tick で切り替わる）。

`spinnerInterval` の `needsAnimation` 判定に `agents.some(a => a.status === "running" || a.status === "starting")` を追加する。

### 代替案とその却下理由

| 案 | 却下理由 |
|---|---|
| **PID watcher で running/idle を判定** | `cmux.isAlive(pid)` は「生存」しか返さない。idle 中も PID は生きているため識別不能。 |
| **AgentState に `active: boolean` だけ持たせる** | Conductor の `status` と型が非対称になり dashboard 側の分岐も二重化する。statring / running / idle の 3 値は Conductor と揃えるのが自然。 |
| **dashboard 側で「直近 SESSION_IDLE を受けたか」を timestamp で判定** | daemon の state が source of truth の原則に反する。複数の情報源が生まれ stale の相関デバッグがつらくなる。 |
| **Spinner を role アイコンの「隣」に表示** | 1 行の幅が伸び、ツリープレフィックス `├─` の視認性を損なう。role は running 中も `a.role` として rowの後段ラベルとして残すため、アイコン枠を spinner に置き換えるほうが省スペース。 |
| **アニメーション用に Agent 専用のフレームカウンタを別途持つ** | Conductor と位相を合わせたほうが同時に回る spinner が揃って見える。既存 `spinnerFrame` に相乗りで十分。 |

### 既存パターンとの整合性

- Conductor の状態遷移パターン（`starting` → `running` → `idle` を hook で駆動）と完全対称。コードリーディング負荷を最小化。
- dashboard 側の描画は既存の `SPINNER_FRAMES` / `spinnerFrame` を再利用。新しい state プロパティを `AppState` に追加しない。
- `formatPair` や `log` イベント（既存の `agent_done` 等）は変更しない。追加イベントのみ新設（`agent_running_changed` 等）は不要 — 既存の `session_started` / `session_idle` ログで追跡可能。
- `updateTeamJson` のシリアライズ対象に status を追加するのは既存の Conductor/Master と同じパターン。

## 3. 変更対象

### 変更するファイル

| ファイル | 変更概要 |
|---|---|
| `skills/cmux-team/manager/schema.ts` | `AgentState` に `status: "starting" \| "running" \| "idle"` を追加（必須フィールド）。 |
| `skills/cmux-team/manager/daemon.ts` | (a) `AGENT_SPAWNED` で `status: "starting"` をセット。(b) `SESSION_STARTED` Agent 分岐で `status="running"` に遷移。(c) `SESSION_IDLE` Agent 分岐で `status="idle"` に遷移。(d) `SESSION_CLEAR` に Agent 分岐を追加し `status="running"` にリセット（非 destructive）。(e) `restoredAgents` マップで status を復元（未設定時は `"idle"` フォールバック）。(f) `updateTeamJson` の agents.map に status を含める。 |
| `skills/cmux-team/manager/dashboard.tsx` | (a) `buildConductorRow` の Agent ループで status に応じて spinner / role アイコンを切り替え。(b) `spinnerInterval` の `needsAnimation` に Agent の running/starting を追加。 |

### 新規作成ファイル

なし。

### 削除ファイル

なし。

### 削除コード（Replace 部分）

- `dashboard.tsx:504-510` の Agent ループ内の `ui.row({ gap: 1 }, [ ...icon + label のみの描画 ])` は、新しい status 分岐付きの描画に **完全置換** する（旧分岐は残さない）。
- 新しい AgentState 追加後、`daemon.ts:1021-1026` の `conductor.agents.push({ ... })` は必ず `status: "starting"` を含める（push しない旧形は残さない）。

## 4. サブタスク分割

> 実装は番号順で 1 → 10 を直列に実施する（同じファイルを触るため）。旧/新並行なし。

### 4.1 実装タスク

#### 1. schema.ts: AgentState に `status` フィールド追加

- **対象ファイル**: `skills/cmux-team/manager/schema.ts`
- **変更内容**: `AgentState` interface に `status: "starting" | "running" | "idle"` を追加。
- **完了条件**: `AgentState` に `status` プロパティが定義されていること。
- **検証コマンド**:
  ```bash
  grep -n "status:" skills/cmux-team/manager/schema.ts | grep -A0 "AgentState"
  ```
  実際には以下を確認:
  ```bash
  rg -n "status:" skills/cmux-team/manager/schema.ts
  ```
- **メソッド制約**: Zod スキーマは Conductor と揃えて追加不要（AgentState は純 interface）。型定義のみで十分。

#### 2. daemon.ts: AGENT_SPAWNED で `status: "starting"` をセット

- **対象ファイル**: `skills/cmux-team/manager/daemon.ts`
- **対象箇所**: `case "AGENT_SPAWNED"` ブロック（現状 `conductor.agents.push({ ... })` している箇所、~1021 行）。
- **変更内容**: push するオブジェクトに `status: "starting"` を含める。
- **完了条件**: `conductor.agents.push` の第一引数が `status: "starting"` を含むこと。
- **検証コマンド**:
  ```bash
  rg -n "AGENT_SPAWNED" skills/cmux-team/manager/daemon.ts -A 10 | rg 'status.*"starting"'
  ```

#### 3. daemon.ts: SESSION_STARTED Agent 分岐で `status="running"` に遷移

- **対象ファイル**: `skills/cmux-team/manager/daemon.ts`
- **対象箇所**: `case "SESSION_STARTED"` 内の「Agent surface か？」ループ（~1132-1148 行）。
- **変更内容**: `agent.sessionId = message.sessionId` / `agent.pid = message.pid` のすぐ後に `agent.status = "running"` を追加。
- **完了条件**: SESSION_STARTED ハンドラの Agent 分岐で `agent.status = "running"` が明示的にセットされること。
- **検証コマンド**:
  ```bash
  rg -n 'agent\.status\s*=\s*"running"' skills/cmux-team/manager/daemon.ts
  ```

#### 4. daemon.ts: SESSION_IDLE Agent 分岐で `status="idle"` に遷移

- **対象ファイル**: `skills/cmux-team/manager/daemon.ts`
- **対象箇所**: `case "SESSION_IDLE"` 内の「Conductor にマッチしなければ Agent surface として処理」ループ（~1522-1548 行）。
- **変更内容**: `writeAgentDone` の前後どちらでもよいが、`agent.status = "idle"` を追加。既存の「agents リストからは削除しない」ポリシーは維持（コメントあり）。
- **完了条件**: SESSION_IDLE の Agent 分岐で `agent.status = "idle"` が明示的にセットされること。
- **検証コマンド**:
  ```bash
  rg -n 'agent\.status\s*=\s*"idle"' skills/cmux-team/manager/daemon.ts
  ```

#### 5. daemon.ts: SESSION_CLEAR に Agent 分岐を追加（status を "running" にリセット）

- **対象ファイル**: `skills/cmux-team/manager/daemon.ts`
- **対象箇所**: `case "SESSION_CLEAR"` ブロック（~1604-1674 行）。現状 Master / Conductor のみ扱っている。
- **変更内容**: 既存分岐の末尾に Agent 用フォールバック分岐を追加（conductor が見つからず、各 Conductor.agents を逆引きして一致する Agent があれば `agent.status = "running"` にセット、`notifyStateChanged` を呼ぶ）。destructive な処理（task-state 書き換え等）は行わない。
- **完了条件**: SESSION_CLEAR の Agent 分岐が存在し、`agent.status = "running"` がセットされること。
- **検証コマンド**:
  ```bash
  rg -n 'SESSION_CLEAR' skills/cmux-team/manager/daemon.ts -A 80 | rg 'agent\.status\s*=\s*"running"'
  ```

> 備考: Agent 向け /clear は実運用では稀だが、Conductor 側との対称性を保つため分岐を設ける。status を running にリセットするのは、/clear 後は次のターン開始を意味するため（SESSION_STARTED 相当）。

#### 6. daemon.ts: restoredAgents マップで `status` を復元

- **対象ファイル**: `skills/cmux-team/manager/daemon.ts`
- **対象箇所**: `restoredAgents: AgentState[] = (c.agents ?? []).map(...)` （~818-824 行）。
- **変更内容**: マッピング内で `status: (a.status as AgentState["status"]) ?? "idle"` を追加。古い team.json（status 無し）の場合は `"idle"` にフォールバック — PID が生存していても running かどうかは不明で、次の hook シグナル到達まで idle 扱いが安全。
- **完了条件**: restoredAgents の map に `status` プロパティが含まれていること。
- **検証コマンド**:
  ```bash
  rg -n 'restoredAgents' skills/cmux-team/manager/daemon.ts -A 8 | rg 'status'
  ```

#### 7. daemon.ts: updateTeamJson の agents.map に `status` を含める

- **対象ファイル**: `skills/cmux-team/manager/daemon.ts`
- **対象箇所**: `updateTeamJson` 内 `agents: c.agents.map((a) => ({ ... }))`（~2200-2205 行）。
- **変更内容**: map 出力オブジェクトに `status: a.status` を追加。
- **完了条件**: team.json の `conductors[].agents[]` に status が書き出されること。
- **検証コマンド**:
  ```bash
  rg -n 'updateTeamJson' skills/cmux-team/manager/daemon.ts -A 40 | rg 'status: a\.status'
  ```

#### 8. dashboard.tsx: Agent 行の描画に Spinner を追加

- **対象ファイル**: `skills/cmux-team/manager/dashboard.tsx`
- **対象箇所**: `buildConductorRow` の `// Agent サブツリー` ループ（~490-511 行）。
- **変更内容**:
  - `const isAgentRunning = a.status === "running" || a.status === "starting";`
  - running/starting のときは `icon` を `SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!` に差し替え、色を CYAN で描画。idle のときは現行通り role アイコン + dim。status undefined 時は idle 相当で描画（フォールバック）。
  - `label` 側の描画（taskTitle / role）は status に関わらず保持。
- **完了条件**:
  - running の Agent 行で Spinner フレームが描画されること（grep で `SPINNER_FRAMES` が Agent ループ内で参照されていること）。
  - idle の Agent 行で従来通り role アイコンが出ること。
- **検証コマンド**:
  ```bash
  rg -n 'agents\[i\]!' skills/cmux-team/manager/dashboard.tsx -A 20 | rg 'SPINNER_FRAMES'
  ```
- **メソッド制約**: 既存の `SPINNER_FRAMES` / `spinnerFrame` / `CYAN` 定数を使うこと。新しい色定数は導入しない。

#### 9. dashboard.tsx: `needsAnimation` に Agent の running/starting を追加

- **対象ファイル**: `skills/cmux-team/manager/dashboard.tsx`
- **対象箇所**: `spinnerInterval` の `setInterval` 内 `needsAnimation` 条件（~1321-1325 行）。
- **変更内容**: 既存条件に次を OR する:
  ```ts
  [...daemon.conductors.values()].some(c =>
    (c.agents ?? []).some(a => a.status === "running" || a.status === "starting")
  )
  ```
- **完了条件**: Conductor が idle かつ Agent のみ running/starting の状況でも spinner フレームが前進すること。
- **検証コマンド**:
  ```bash
  rg -n 'needsAnimation' skills/cmux-team/manager/dashboard.tsx -A 10 | rg 'agents'
  ```

### 4.2 配線タスク

#### 10. E2E 手動検証

- **対象ファイル**: 実行検証のみ。
- **完了条件**:
  1. `cmux-team start` で起動。
  2. `cmux-team spawn-agent --conductor-surface <s> --role researcher --prompt "echo hello && sleep 30"` 等で Agent を起動し、Agent 行に Spinner が回ることを確認。
  3. Agent のターン完了後（SESSION_IDLE 発火後）に Spinner が止まり role アイコンになることを確認。
  4. Conductor が idle のまま Agent だけ running のケースでも Spinner フレームが進むことを確認。
  5. `cmux-team kill-agent --surface <s>` で行が消えることを確認。
  6. `cmux-team stop` で daemon を落とし、`jq '.conductors[].agents[] | .status' .team/team.json` で status フィールドが persisted されていることを確認。
- **検証コマンド**:
  ```bash
  jq '.conductors[].agents[] | {surface, role, status, pid}' .team/team.json
  ```

### 4.3 削除タスク

#### 11. 旧 Agent 行描画の削除（Replace に伴う残骸除去）

- **対象ファイル**: `skills/cmux-team/manager/dashboard.tsx`
- **変更内容**: サブタスク #8 の実装で旧 `ui.row({ gap: 1 }, [ ui.text(...) , ui.text(...) , ui.text(\`${icon} ${label}\`) ])` を status 分岐付き描画で **完全置換** する。旧コードは残さない。
- **完了条件**: dashboard.tsx 内に「status を参照せず固定 `${icon} ${label}` を描画する Agent 行」が存在しないこと。
- **検証コマンド**:
  ```bash
  rg -n '\$\{icon\}\s+\$\{label\}' skills/cmux-team/manager/dashboard.tsx
  ```
  → 結果 0 件を期待（status 分岐経由の描画のみ残存）。ただし idle 分岐が `${icon} ${label}` を使う場合は OK（その場合は検証コマンドを緩和する）。

> 補足: サブタスク #8 内で旧行は Edit により置換されるため、独立した Delete ステップは発生しないが、「旧描画が残っていないか」の最終確認として 11 を設ける。

## 5. リスク

### 5.1 既存機能への影響

- **`AgentState` への必須フィールド追加**: 既存の AgentState 生成箇所（AGENT_SPAWNED / restoredAgents）が 2 箇所しかなく、どちらも本計画で更新対象。TypeScript コンパイラがそれ以外の箇所を検出する（tsc --noEmit で通ることを確認する）。
- **team.json 後方互換**: 古い daemon 由来の team.json に `status` が無い場合、restoredAgents のフォールバック `"idle"` が効く。運用中の混在は発生しない（daemon 再起動時に上書きされる）。
- **EventBus**: `notifyStateChanged` 呼び出しは既存分岐にぶら下がる形で追加する。新規 source 文字列は `"daemon.ts:handleMessage:session-clear-agent"` 等を付与し、`eventBus.ts` 外部からは `notifyStateChanged` のみを呼ぶ CLAUDE.md ポリシーを遵守する。
- **ログポリシー**: Agent の status 変化を示す新規イベント（`agent_running` / `agent_idle`）は追加しない。既存の `session_started` / `session_idle` / `agent_done` で追跡可能。ただし SESSION_CLEAR の Agent 分岐を新設するため、`session_clear_agent_reset` を **1 箇所のみ** 追加する。

### 5.2 エッジケース

| ケース | 挙動 |
|---|---|
| AGENT_SPAWNED → SESSION_STARTED → SESSION_IDLE が 1 秒以内に連続発火 | 各イベントで status 書き換えが happens-before で逐次実行されるため問題なし（handleMessage はシングルスレッド）。 |
| AGENT_SPAWNED より先に SESSION_STARTED が到達 | Agent 経路では AGENT_SPAWNED が先にあるのが契約（main.ts:cmdSpawnAgent 参照）。もし逆転した場合 SESSION_STARTED の Agent ループで `agent` が見つからず何もしない（既存動作）。AGENT_SPAWNED 到達後の SESSION_STARTED で status=running に遷移。逆転が顕在化したら別タスクで扱う。 |
| PID 死亡による spawnAgentPidWatcher 経由の削除 | 既存動作通り `agents.splice` で削除される。status フィールドは破棄される（影響なし）。 |
| SESSION_ENDED 到達 | 既存動作通り `agents.splice` で削除される（~1360 行）。status は削除と同時に破棄（影響なし）。 |
| Agent が ASK（SESSION_ASK）発火 | 本タスクでは扱わない。Agent 用 status に `asking` を追加する拡張は将来の別タスクにする（Conductor と同じ扱いにする場合）。ASK は現状 done マーカーに `status: "ask"` として書かれるだけで agents 配列は生存継続するため、status は `"running"` のまま残って Spinner が回り続ける。許容範囲（Agent が AskUserQuestion を投げた後も実質待機中）。 |
| `spinnerTick`（Master 用）と `spinnerFrame`（Conductor/Agent 用）の混在 | Master のみ spinnerTick、Conductor/Agent は state.spinnerFrame を使う既存構造を踏襲。統合はしない。 |

### 5.3 テスト戦略

- **自動テスト**: リポジトリに自動テストフレームワークはない（CLAUDE.md 記載）。`bunx tsc --noEmit` で型検証を通す。
- **E2E 手動**: サブタスク #10 の手順で検証。特に「Conductor idle + Agent running」のケースで spinner が回ることを確認する。
- **PID 死亡時**: `kill -9 $(jq '.conductors[0].agents[0].pid' .team/team.json)` で擬似クラッシュさせ、agents から削除されることを確認（既存動作の regress チェック）。

## 6. 既存型エラーの先読み

対象ファイル群: `schema.ts`, `daemon.ts`, `dashboard.tsx`, `conductor.ts`

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-236-1776392418/skills/cmux-team/manager
bunx tsc --noEmit 2>&1 | grep -E "^(dashboard\.tsx|schema\.ts|daemon\.ts|conductor\.ts)" || true
```

### 6.1 本タスクで解消するエラー

**該当なし**（実行結果: 0 件。clean baseline）。

### 6.2 後続タスクに分離するエラー

**該当なし**（上記の通り既存エラーはゼロ）。

### 6.3 本タスクで導入する可能性のあるエラー

- `AgentState.status` を必須フィールドにすると、既存の push / restore 箇所以外で AgentState を組み立てている未知の箇所があれば tsc がエラーを出す。サブタスク #1 完了後すぐに tsc を回してエラー箇所を洗い出し、必要に応じてサブタスクを追加する。現時点で grep した限り AgentState 生成箇所は `daemon.ts:1021-1026` と `daemon.ts:818-824` の 2 箇所のみ。

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | AgentState.status の値 | `"starting" \| "running" \| "idle"` | Conductor と同じ 3 値で対称性を保つ。`asking` は ASK 処理を含む別タスクで扱う。 |
| D2 | status フィールドを必須にするか optional にするか | 必須 (required) | 新規スポーンは必ず `starting` で始まり、restore でもフォールバック `"idle"` を入れるため、undefined ケースは発生しない。必須にすることで TypeScript が生成箇所を漏れなく検出。 |
| D3 | SESSION_IDLE 後も agents 配列を保持するか | 保持（既存方針踏襲） | 既存コメント「idle 中の Agent も生存扱い。SESSION_ENDED / surface_lost で削除」を尊重。TUI で idle 状態も行表示する必要があるため、むしろ好都合。 |
| D4 | Spinner 描画位置（置換 or 追加） | role アイコンの置換 | 追加にすると 1 行の幅が伸びツリープレフィックスの視認性を損なう。情報量は「running か否か」が主目的なので置換で十分。 |
| D5 | Spinner の色 | `CYAN` | Conductor の starting/assigning と同色で、Agent が「動いている」と直感的に判別できる。YELLOW は Conductor running との差別化のため避ける。 |
| D6 | アニメーション駆動の判定条件 | Conductor OR Agent の running/starting のいずれか | Conductor idle + Agent running のケースでフレームが進まない regression を防ぐ。 |
| D7 | spinnerFrame を Agent 専用に分けるか | 共有（Conductor と同じ state.spinnerFrame） | 位相を合わせたほうが Conductor と Agent の spinner が同期して回る。コード増加も抑えられる。 |
| D8 | SESSION_CLEAR の Agent 分岐を追加するか | 追加（status を "running" にリセット、非 destructive） | タスク記述（"SESSION_STARTED / SESSION_IDLE / SESSION_CLEAR"）に明記されているため対応。実運用では稀だが、対称性のため。destructive な処理（task-state 書き換え・worktree 削除等）は行わない。 |
| D9 | restoredAgents の status フォールバック値 | `"idle"` | PID alive だけでは running/idle を判定できない。次の hook シグナル到達まで idle 扱いが安全（false running による spinner 空回りを避ける）。 |
| D10 | Agent の `asking` 状態を導入するか | 今回は見送り | タスクの非対象に明記。現状 Agent の ASK は done マーカーで扱われ、spinner が回り続けるのは許容（待機中）。将来別タスクで拡張余地あり。 |
| D11 | 新規ログイベント | `session_clear_agent_reset` のみ追加 | 既存の `session_started` / `session_idle` / `agent_done` で Agent の状態変化は追跡可能。SESSION_CLEAR の Agent 分岐は新規経路のため 1 イベントだけ追加して観測性を確保。 |
| D12 | team.json シリアライズ対象 | agents[].status を追加 | daemon 再起動時の復元に必要。既存の Conductor/Master と同じパターン。 |
