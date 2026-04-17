# T175 実装計画 — Master の稼働中ステータス (スピナー) を TUI に反映する

## 0. 前提: タスク説明と現状実装の差分

タスクプロンプト (`task-175-1776343788-planner-1776343886.md`) に書かれている

> `skills/cmux-team/manager/main.ts:1075-1085` の Master 設定は statusLine のみ

は **古い情報** であり、現状とは一致しない。**T211 で `generateMasterSettings()` (現 `main.ts:1366`) が追加され、案 B (`POST /master-state` 経由) はすでに実装済み**である。

| プロンプトの記述 | 現状 (2026-04-16) |
|------------------|-------------------|
| Master settings は statusLine のみ | `generateMasterSettings` が `UserPromptSubmit` / `Stop` hook + statusLine を生成 (`main.ts:1366-1402`) |
| `/master-state` は呼び出し元なし | `master-hook-busy.py` / `master-hook-stop.py` が `/master-state` を POST (`main.ts:1247-1340`) |
| `daemon.ts:668` SESSION_ACTIVE で masterStatus 更新 | 現コードでは `daemon.ts:988-1011` (SESSION_ACTIVE) と `daemon.ts:1049-1057` (SESSION_IDLE) で更新 |

したがって本タスクの真の課題は「**実装済みの案 B がなぜ TUI に反映されないか**」を特定し、**案 A (SessionStart/End hook の Master 適用)** と **案 B の欠陥修正 (notifyStateChanged + ログ)** をハイブリッドで仕上げることである。

---

## 1. 課題分析

### 1.1 現状の問題点

TUI ダッシュボードの Master セクション (`dashboard.tsx:397-434`) で:

- **A**: Claude が処理中でも `▖▘▝▗` のスピナーが回らない
- **B**: 起動直後または時間経過後に `disconnected (⚠ 黄)` 表示になりやすい

### 1.2 根本原因 (3 点併存)

#### 原因 1: Master の `SessionStart` / `SessionEnd` hook が未設定 → masterPid 取得不能

- `generateMasterSettings()` (`main.ts:1366-1402`) は `UserPromptSubmit` と `Stop` のみを設定し、`SessionStart` / `SessionEnd` を含まない。
- `daemon.ts:808-817` の `SESSION_STARTED` ハンドラには Master 分岐があり、ここで `state.masterPid = message.pid` と `spawnMasterPidWatcher` を起動する設計だが、Master 用 settings に hook が無いためこの経路に **一度も入らない**。
- 結果として `state.masterPid` は `undefined` のまま、`spawnMasterPidWatcher` (`daemon.ts:1532`) も起動しない。
- `master_session_started` / `master_session_active` / `master_session_idle` ログが `manager.log` に **0 件** であることから裏取り済み (`grep -c master_session_ /Users/yamamoto/git/cmux-team/.team/logs/manager.log` → 0)。

#### 原因 2: `proxy.ts:/master-state` が `notifyStateChanged()` を呼ばない → TUI 反映が不安定

- `proxy.ts:240-258` で `state.masterStatus` を直接書き換えるだけで、`eventBus.notifyStateChanged()` を呼んでいない (`proxy.ts` には `notifyStateChanged` の import すら無い)。
- TUI の `dashboard.tsx:1370-1378` の `scheduleRefresh` は `onStateChanged` 購読 (`dashboard.tsx:1385`) で起動されるため、`notifyStateChanged` が呼ばれない限り即時 refresh が発生しない。
- スピナーアニメーションは `dashboard.tsx:1350-1366` の `spinnerInterval` (180ms) で `getState()` を取り直すため理論上は反映される **はず** だが:
  - `wasAnimating` フラグが `false` の状態で `daemon.masterStatus === "running"` を 180ms 周期でしか拾えない → 体感で「スピナーが回ってない」になる可能性
  - また `idle` → `running` → `idle` が極短時間で起きると spinner が走らないまま終わる

#### 原因 3: `proxy.ts:/master-state` がログを書かない → 動作検証ができない

- POST の成否や受信内容を `manager.log` に残していないため、動かないとき「hook が発火していない」のか「hook は発火したが POST が届いていない」のか「届いたが state 更新が TUI に伝わっていない」のかが切り分け不能。
- 結果として、本タスク完了の検証手順 (タスク文書「検証方法」4: `manager.log` に master_state イベントが残ること) が満たせない。

### 1.3 影響範囲

| 影響対象 | 影響内容 |
|---------|---------|
| TUI ダッシュボード | Master セクションの状態が体感不一致 (この issue) |
| Master の死亡検知 | `masterPid` 未確立 → `spawnMasterPidWatcher` 不在 → kill された Master を検知不能 |
| `team.json` の `master.pid` フィールド | 常に `undefined` (T195 以降の PID ベース生存確認に支障) |
| 既存 Conductor / Agent | 影響なし (修正は Master 経路のみ) |

---

## 2. 技術アプローチ

### 2.1 採用方針: 案 A + 案 B の併用

| 経路 | 担当する状態遷移 | 採用理由 |
|------|----------------|---------|
| **案 A** (SessionStart/End hook) | `SESSION_STARTED` → masterPid 確立 + `masterStatus = "idle"` + `spawnMasterPidWatcher` 起動 / `SESSION_ENDED` → `masterStatus = "disconnected"` | masterPid を取得し PID 監視を起動するため必須。Conductor と同じパターンで保守性も高い |
| **案 B** (UserPromptSubmit/Stop hook → `/master-state`) | プロンプト送信瞬間 → `masterStatus = "running"` + `masterPrompt` 表示 / Stop → `masterStatus = "idle"` | `SESSION_ACTIVE` hook event は Claude Code には存在しない (※後述) ため、busy 切り替えは proxy POST 経由が唯一の現実解 |

> **補足**: `SESSION_ACTIVE` メッセージは cmux-team の内部メッセージタイプ (`schema.ts:64`, `daemon.ts:988`) として **存在はする** が、Claude Code の hook event としては定義されていない (Claude Code が定義する hook は `SessionStart` / `Stop` / `SessionEnd` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` 等)。したがって busy 検知は `UserPromptSubmit` hook (= プロンプト送信瞬間) を通じて行うしかなく、案 B は廃止できない。

### 2.2 案 B 単独 (proxy のみ) を却下する理由

- `masterPid` が確立しないため、Master kill / セッション断を一切検知できない。
- TUI が `disconnected` に遷移する経路が消失し、ユーザーが Master の死亡に気づけなくなる (実質的に状態 = `idle` 永続化、ユーザー体験は逆に悪化)。
- 案 A の SessionStart hook は Conductor と完全に同じ仕組みであり、追加コストは settings.json 数行のみ。

### 2.3 案 A 単独 (hook のみ) を却下する理由

- `SESSION_ACTIVE` を発火する Claude Code の hook event が存在しないため、busy 切り替えのトリガーが無い。
- `Stop` hook は idle に戻すタイミングとしては使えるが、busy 切り替えには使えない (Stop 時点では応答完了済み)。
- `UserPromptSubmit` hook で `cmux-team send SESSION_ACTIVE` を呼ぶ案も技術的には可能だが、`masterPrompt` の伝達 (現状 `/master-state` の `prompt` フィールド経由で TUI に表示) を別経路で再実装する必要があり、proxy 経路を残す方が変更が小さい。

### 2.4 既存パターンとの整合性

- Master 用 SessionStart hook は **Conductor の `generateConductorSettings()` (`main.ts:1463-1535`) と同じ command 文字列構造を取る**:
  ```
  bash -c 'cmux-team send SESSION_STARTED --from-stdin --surface "${CMUX_SURFACE}" --pid "$PPID" 2>/dev/null || true'
  ```
- Master 起動時に `CMUX_SURFACE` 環境変数が設定されているか確認:
  - `cmdLaunchMaster` (`main.ts:1710-1745`) には `CMUX_SURFACE` の export が **無い**。Conductor (`main.ts:1588`) では `process.env.CMUX_SURFACE = surface` が defensive に設定されている。
  - Master は `cmux-team start` から `cmux newSplit` で作成された pane で `cmux-team spawn-master` が実行されるため、cmux pane の env 継承 (`CMUX_SURFACE`) は基本的に有効である。
  - 念のため Conductor と同じく `cmdLaunchMaster` 内で defensive に `CMUX_SURFACE` を再 export する (詳細はサブタスク 2)。
- Master 用 SessionEnd hook も Conductor と同じ matcher (`logout|prompt_input_exit|other`) + `cmux-team send SESSION_ENDED --from-stdin` 構成。`/clear` 検知 (`SESSION_CLEAR`) は Master では不要 (Master は `/clear` してもセッションを保持するロールのため)。

---

## 3. 変更対象

### 3.1 変更ファイル

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/main.ts` | (1) `generateMasterSettings()` の `hooks` に `SessionStart` / `SessionEnd` を追加 (Conductor と同じ command 文字列パターン)。(2) `cmdLaunchMaster()` 内で `process.env.CMUX_SURFACE = surface` を defensive 設定 (= `resolveCallerSurfaceOrExit()` を呼び出す) |
| `skills/cmux-team/manager/proxy.ts` | (1) `eventBus` から `notifyStateChanged` を import。(2) `/master-state` ハンドラ内で state 書き換え後に `notifyStateChanged("proxy.ts:/master-state:<status>")` を呼ぶ。(3) `logger` を import し、受信時に `master_state status=<...> [prompt=<...>]` を 1 行ログ出力 |
| `skills/cmux-team/manager/main.test.ts` | `generateMasterSettings` の既存テスト (`main.test.ts:1027-1074` 周辺) に `SessionStart` / `SessionEnd` hook の構造 assertion を追加 |
| `skills/cmux-team/manager/proxy.test.ts` | `/master-state` のテストに `notifyStateChanged` 呼び出し検証 (mock) と log 検証を追加 |

### 3.2 新規作成ファイル

なし。`master-hook-busy.py` / `master-hook-stop.py` は既存スクリプトをそのまま再利用。

### 3.3 削除ファイル

なし。

---

## 4. サブタスク分割

> 順序は依存関係順 (上から実装)。すべて `/Users/yamamoto/git/cmux-team/.worktrees/task-175-1776343788/` 内で作業する。

### サブタスク 1: `proxy.ts:/master-state` に `notifyStateChanged` + ログを追加

- **対象ファイル**: `skills/cmux-team/manager/proxy.ts`
- **変更内容**:
  1. ファイル冒頭の import に `import { notifyStateChanged } from "./eventBus";` を追加 (既存 import の並び順に合わせる)
  2. `import { log } from "./logger";` を追加 (もし無ければ)
  3. `proxy.ts:240-258` の `/master-state` ハンドラを以下のように改修:
     - `body.status === "busy"` 分岐後 → `notifyStateChanged("proxy.ts:/master-state:busy")`
     - `body.status === "idle"` 分岐後 → `notifyStateChanged("proxy.ts:/master-state:idle")`
     - prompt のみ更新 (status 不在) のケースでも `notifyStateChanged("proxy.ts:/master-state:prompt")`
     - 受信時に `await log("master_state", \`status=${body.status ?? "?"} prompt=${(body.prompt ?? "").slice(0, 40).replace(/\s+/g, " ")}\`)` を追加 (1 行ログ、prompt は 40 字でトリム)
- **完了条件**:
  - `rg "notifyStateChanged.*master-state" skills/cmux-team/manager/proxy.ts | wc -l` が **3 以上**
  - `rg "log\(\"master_state\"" skills/cmux-team/manager/proxy.ts` が **1 行ヒット**
  - `bunx tsc --noEmit --project skills/cmux-team/manager` がエラーゼロ
- **メソッド制約**:
  - `bus.emit` 直接呼び出しは禁止 (CLAUDE.md「EventBus ポリシー」)。必ず `notifyStateChanged()` 経由
  - `eventBus.ts` を `logger.ts` にも `proxy.ts` にも追加 import するが、循環依存にならないことを確認 (`eventBus.ts` → `logger.ts` への import が無いことを `rg "from \"./logger\"" skills/cmux-team/manager/eventBus.ts` で確認)
- **検証コマンド**:
  ```bash
  cd /Users/yamamoto/git/cmux-team/.worktrees/task-175-1776343788
  rg -n "notifyStateChanged|log\(\"master_state\"" skills/cmux-team/manager/proxy.ts
  ```

### サブタスク 2: `cmdLaunchMaster()` で `CMUX_SURFACE` を defensive 設定

- **対象ファイル**: `skills/cmux-team/manager/main.ts` (`cmdLaunchMaster` 関数 = 1710-1745 行付近)
- **変更内容**:
  1. `cmdLaunchMaster()` 冒頭で `const surface = await resolveCallerSurfaceOrExit();` を呼ぶ (Conductor の `cmdConductor` と同じパターン: `main.ts:1563`)
  2. `process.env.CMUX_SURFACE = surface;` を `process.env.CMUX_NO_RENAME_TAB = "1";` の直前に追加
  3. ログに `master_spawn_surface ${formatSurface(surface, "U")}` を追加 (デバッグ容易化)
- **完了条件**:
  - `rg -n "CMUX_SURFACE" skills/cmux-team/manager/main.ts | rg "cmdLaunchMaster\|spawn-master\|1[67][0-9][0-9]"` で 1 行以上ヒット
  - Master 起動時に `manager.log` に `master_spawn_surface U[...]` が記録される (実機検証時)
- **メソッド制約**:
  - `resolveCallerSurfaceOrExit()` (既存ヘルパー、`main.ts:1541`) を利用。独自実装しない
- **依存**: なし (サブタスク 1 と独立)

### サブタスク 3: `generateMasterSettings()` に `SessionStart` / `SessionEnd` hook を追加

- **対象ファイル**: `skills/cmux-team/manager/main.ts` (`generateMasterSettings` = 1366-1402 行)
- **変更内容**:
  1. `settings.hooks` オブジェクトに以下を追加 (既存 `UserPromptSubmit` / `Stop` の隣に並べる):
     ```ts
     SessionStart: [
       {
         matcher: "",
         hooks: [{
           type: "command",
           command: "bash -c 'cmux-team send SESSION_STARTED --from-stdin --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" 2>/dev/null || true'",
           timeout: 5000,
         }],
       },
     ],
     SessionEnd: [
       {
         matcher: "logout|prompt_input_exit|other",
         hooks: [{
           type: "command",
           command: "bash -c 'cmux-team send SESSION_ENDED --from-stdin --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" 2>/dev/null || true'",
           timeout: 5000,
         }],
       },
     ],
     ```
  2. command 文字列は `generateConductorSettings` (`main.ts:1478-1519`) からそのままコピー。差分は `/clear` matcher 不在のみ
- **完了条件**:
  - `rg -n "SessionStart" skills/cmux-team/manager/main.ts` が `generateMasterSettings` 内で 1 ヒット
  - `rg -n "SessionEnd" skills/cmux-team/manager/main.ts` が `generateMasterSettings` 内で 1 ヒット
  - 生成された `.team/prompts/master-settings.json` に `SessionStart` / `SessionEnd` キーが含まれる (実機検証時)
- **メソッド制約**:
  - command 文字列は **Conductor 既存パターンと完全一致** させる (`SESSION_STARTED --from-stdin --surface ${CMUX_SURFACE} --pid $PPID`)
  - matcher 文字列も Conductor の SessionEnd と完全一致 (`logout|prompt_input_exit|other`)
- **依存**: サブタスク 2 (CMUX_SURFACE 設定) — 環境変数が無いと `${CMUX_SURFACE}` が空展開して daemon 側で `session_ended_dropped` 等になる

### サブタスク 4: `main.test.ts` で新 hook の構造テストを追加

- **対象ファイル**: `skills/cmux-team/manager/main.test.ts` (既存 `describe("generateMasterSettings (T211)")` ブロック = 1029 行付近)
- **変更内容**:
  - 既存テストの隣に以下のケースを追加 (T211 既存テストパターンを踏襲):
    1. `settings.hooks.SessionStart[0].hooks[0].command` が `cmux-team send SESSION_STARTED --from-stdin` を含む
    2. `settings.hooks.SessionEnd[0].matcher` が `"logout|prompt_input_exit|other"` 完全一致
    3. `settings.hooks.SessionEnd[0].hooks[0].command` が `cmux-team send SESSION_ENDED --from-stdin` を含む
- **完了条件**:
  - `cd skills/cmux-team/manager && bun test main.test.ts -t "SessionStart\|SessionEnd"` が pass
  - `bun test main.test.ts -t "generateMasterSettings"` 既存テストも依然 pass
- **依存**: サブタスク 3

### サブタスク 5: `proxy.test.ts` で `/master-state` の notifyStateChanged + ログを検証

- **対象ファイル**: `skills/cmux-team/manager/proxy.test.ts`
- **変更内容**:
  - `/master-state` の既存テスト (現状 fixture: `proxy.test.ts:148-168` 周辺) を拡張:
    1. `eventBus.onStateChanged` に subscribe したコールバックが、`/master-state` POST 後に **1 回呼ばれる** ことを assert
    2. log capture (既存パターン: `await readFile(.team/logs/manager.log)`) で `master_state status=busy` が **1 行記録される** ことを assert
- **完了条件**:
  - `bun test proxy.test.ts -t "master-state"` が pass
- **依存**: サブタスク 1

### サブタスク 6: 実機検証 (手動)

- **対象**: `cmux-team start` で起動した実セッション (この worktree ではなく `/Users/yamamoto/git/cmux-team/` 本体)
- **手順**:
  1. `cmux-team stop && cmux-team start` で daemon と Master を再起動
  2. Master セッションに長めのプロンプトを送信 (例: 「リサーチ用に 10 個のアイデアを書き出して」)
  3. 送信直後 〜 応答完了までの間に TUI ダッシュボードを目視:
     - Master セクションが `▖` 系スピナーに切り替わる
     - 横に `masterPrompt` (40 字程度) が表示される
  4. 応答完了後、Master セクションが `● [<num>]` (緑円) に戻ることを確認
  5. `tail -f .team/logs/manager.log` で以下の 4 行が時系列に出ることを確認:
     - `master_session_started U[<num>] pid=<pid>` (起動時)
     - `master_state status=busy prompt=<...>` (UserPromptSubmit hook)
     - `master_state status=idle ...` (Stop hook)
     - (Master を kill した場合) `master_session_ended U[<num>] pid=<pid> reason=pid_watcher`
- **完了条件**: 上記 4 ログが揃う + TUI スピナーが目視で動作
- **依存**: サブタスク 1〜5 全て

---

## 5. リスク

### 5.1 既存機能への影響

| リスク | 評価 | 対策 |
|--------|------|------|
| `SessionStart` hook 追加によって既存 Master 起動時の挙動が壊れる | 低 | Conductor で同じ pattern が長期稼働中。command は `\|\| true` で fail-safe |
| `notifyStateChanged` 追加によって TUI refresh が高頻度化し負荷上昇 | 低 | `scheduleRefresh` には 100ms debounce 済み (`dashboard.tsx:1373-1378`)。proxy への POST 自体が 1 ターンに 2 回 (busy / idle) なので emit 頻度はごく低い |
| `master_state` ログが大量に出てログ膨張 | 低 | 1 ターン 2 行のみ。Conductor の `session_idle` ログと同等のオーダー |
| `CMUX_SURFACE` defensive 設定が cmdLaunchMaster で何らかの不整合を起こす | 低 | Conductor 既存パターンと同じヘルパー (`resolveCallerSurfaceOrExit`) を使うのみ。既存挙動は cmux pane env 継承で同じ surface 値が来るため等価 |

### 5.2 エッジケース

| ケース | 想定挙動 | 対応 |
|-------|---------|------|
| Master を `/clear` した直後 | Claude Code の挙動: `SessionEnd reason=clear` → `SessionStart source=clear` の連続発火。Conductor と同じく `SessionEnd matcher` は `logout\|prompt_input_exit\|other` のみで `clear` は素通し → `SessionStart` で再 idle 化 | 既存 Conductor と同じ挙動 |
| Master kill (Ctrl-C, ターミナル終了) | `SessionEnd reason=logout/other` → daemon は `masterStatus = "disconnected"` + `masterPid = undefined` | OK |
| `SessionStart` hook が遅延発火し、proxy `/master-state` POST が先に届く | `masterStatus = "running"` が一旦設定 → 直後に `SESSION_STARTED` で `masterStatus = "idle"` に戻る (`daemon.ts:812`) | TUI が一瞬チラつく可能性。実害は小さいが要観察 (検証手順 2) |
| `proxy` 死亡中にユーザーがプロンプト送信 | `master-hook-busy.py` の `urllib.urlopen` が例外 → 無視 (script 末尾 `except: pass`)。`masterStatus` 不変 | 既存挙動と同じ |
| 同一 worktree から `cmux-team start` を 2 回実行 | hook 内 `git rev-parse` は同じ root を返すため、両 daemon の `proxy-port` ファイルは後勝ち。複数 daemon 共存はそもそも非推奨 | 既知の制約 (本タスクのスコープ外) |

### 5.3 テスト戦略

- **単体テスト** (サブタスク 4, 5): `bun test` で settings.json 構造と proxy ハンドラの副作用 (notifyStateChanged + log) を検証
- **手動 E2E** (サブタスク 6): TUI 目視 + log 確認 (タスク文書「検証方法」4 項目に準拠)
- **回帰テスト**: `bun test skills/cmux-team/manager/` を全実行し、既存 `generateMasterSettings` テスト (`main.test.ts:1027-1074`) と Master pid watcher テスト (`daemon.test.ts:1620+`) が pass することを確認

---

## 6. 既存型エラーの先読み

### 6.1 実行結果

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-175-1776343788
bunx tsc --noEmit --project skills/cmux-team/manager 2>&1 \
  | grep -E "^(skills/cmux-team/manager/main\.ts|skills/cmux-team/manager/daemon\.ts|skills/cmux-team/manager/master\.ts|skills/cmux-team/manager/proxy\.ts|skills/cmux-team/manager/dashboard\.tsx)" || echo "(no errors)"
```

結果: **(no errors)** — 変更対象ファイル群に既存型エラーは **無し** (exit code 0)。

### 6.2 本タスクのスコープで解消するエラー

該当なし (既存エラーがゼロのため)。本タスクの修正で新規にエラーを発生させないことのみが要件。

### 6.3 後続タスク (cleanup) に分離するエラー

該当なし。

---

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | 案 A 単独 / 案 B 単独 / 併用 のどれを採用するか | **併用** | 案 A 単独では busy 切り替えのトリガー (Claude Code の hook event) が無い。案 B 単独では masterPid が確立せず Master 死亡を検知できない。両者は補完関係 |
| D2 | Master の `SessionEnd` matcher に `clear` を含めるか | **含めない** | Master は `/clear` してもセッション継続するロール (master.md 参照)。`SESSION_CLEAR` 経由で disconnected にすると誤検知になる。Conductor も SessionEnd matcher は `logout\|prompt_input_exit\|other` のみ |
| D3 | `cmdLaunchMaster` で `CMUX_SURFACE` を defensive 設定するか | **する** | Conductor (`main.ts:1588`) が同様の defensive 設定を持つ。env 継承が壊れた場合の guard として一貫性を保つ |
| D4 | `notifyStateChanged` の source 文字列フォーマット | `"proxy.ts:/master-state:<status>"` | CLAUDE.md「EventBus ポリシー」の規約 (`<ファイル>:<関数>:<理由>`) に準拠。proxy の HTTP ハンドラは関数化されていないためパス名で代用 |
| D5 | `master_state` ログに prompt 全文を含めるか | **40 字でトリム** | `manager.log` のログサイズ抑制 + 機密プロンプト漏洩リスク低減。dashboard の表示も 80 字でトリム済み (`proxy.ts:252`) のため整合 |
| D6 | `master-hook-busy.py` / `master-hook-stop.py` を削除して案 A に統合するか | **残す** | 案 B 経路は busy 切り替えの唯一の手段。スクリプトは既に動作実績があり、変更コストに見合うメリットなし |
| D7 | `SessionStart` hook の matcher を `""` (全捕捉) にするか | **`""` にする** | Conductor (`main.ts:1481`) と同じ。`startup\|resume\|clear\|compact` の 4 値を個別指定するより `""` 一発で全捕捉する方が漏れがなく、Claude Code 仕様変更にも強い |
| D8 | `master_state` ログを書く位置 (`proxy.ts` ハンドラ内 vs. daemon `handleMessage`) | **proxy ハンドラ内** | `/master-state` POST は QueueMessage 経路を通らず proxy 内で完結するため、daemon ハンドラ介入は不可能。proxy 内ログ + notifyStateChanged の組み合わせが最短 |

---

## 完了条件 (planner 観点)

- [x] 本ファイル (`plan.md`) が `/Users/yamamoto/git/cmux-team/.team/tasks/175-master-tui/runs/task-175-1776343788/plan.md` に存在する
- [x] §1〜§7 の 7 項目が全て埋まっている
- [x] §6 の型エラー先読みを実行し、結果を記載した (errors=0)
