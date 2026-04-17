# 実装計画書: Conductor の cmux send/send-key ブロック + cmux-team send-agent 追加

関連 issue: hummer98/cmux-team#21 (乗っ取り問題), hummer98/cmux-team#22 (自己フォールバック問題)
対象ファイル:
- `skills/cmux-team/manager/main.ts`(`generateConductorSettings` 拡張 + `send-agent` サブコマンド新設)
- `skills/cmux-team/templates/ja/conductor-role.md`
- `skills/cmux-team/templates/en/conductor-role.md`
- `CHANGELOG.md`

## 1. 背景と目的

Conductor は Agent 起動・制御に `cmux-team spawn-agent` / `cmux-team kill-agent` を使うべきだが、生の `cmux send` / `cmux send-key` で他 surface を直接操作するケースが継続的に発生している（他 Conductor の乗っ取り、自分自身への再プロンプト送信など）。

これを 2 段構えで解決する:

1. **PreToolUse hook で実行時ブロック** — Bash tool が `cmux send` / `cmux send-key` を叩こうとしたら exit 2 で拒否する(task-167 の hook 設計を流用)。
2. **`cmux-team send-agent` を新設** — Conductor が Agent に正規ルートでメッセージ送信できる手段を用意する(hook だけ導入すると「Agent が API エラーで止まった時に再開させる」等の正当ユースケースが潰れるため)。

## 2. 既存実装の現状

### 2.1 `generateConductorSettings` (`main.ts` L765–822)

すでに以下の hook を注入している:

- `SessionStart`(matcher: `startup`) — `SESSION_STARTED` を送信
- `Stop`(matcher: `""`) — `SESSION_IDLE` を送信
- `SessionEnd`(matcher: `clear`) — `SESSION_CLEAR` を送信
- `SessionEnd`(matcher: `logout|prompt_input_exit`) — `SESSION_ENDED` を送信

`PreToolUse` キーは未定義。今回追加する。生成先は `.team/prompts/<surface>-settings.json`、Conductor は `claude --settings <path>` で読み込む(`cmdConductor` L880 / `cmdResume` L964)。

### 2.2 spawn-agent / kill-agent (`main.ts`)

- `spawn-agent` (L1040 付近): `--conductor-surface <s> --role <r> --prompt|--prompt-file ...` を受けて新タブ(`cmux.newSurface` → fallback `newSplit right`)で Agent を起動。`AGENT_SPAWNED` を daemon に送信し、`task_sessions` テーブルに `event=agent_spawned` を記録。stdout は `SURFACE=surface:NNN`。
- `kill-agent` (L1260 付近): `--surface <s>` を受けて `cmux closeSurface` → `SESSION_ENDED` を postMessage。

`send-agent` はこの 2 つと対称的に「conductor 発→agent 宛」の単発メッセージ送信として追加する。

### 2.3 trace DB スキーマ (`trace-store.ts` L24–39)

**`task_sessions` テーブルの列(確認済み)**:

| 列 | 型 | 備考 |
|---|---|---|
| id | INTEGER PK | |
| timestamp | TEXT NOT NULL | |
| task_id | TEXT NOT NULL | |
| task_run_id | TEXT | |
| session_id | TEXT NOT NULL | agent_spawned 時点では `""`(空文字)を入れている(L1212) |
| role | TEXT | |
| **surface** | TEXT | agent_spawned の場合は **Agent 自身の surface** |
| worktree_path | TEXT | |
| event | TEXT NOT NULL | `assigned` / `agent_spawned` / `closed` / `aborted` |

**重要**: `conductor_surface` 列は存在しない。`agent_spawned` イベントの `surface` は Agent の surface のみで、どの Conductor が spawn したかは **この DB からは直接引けない**。task_id と team.json を突き合わせれば追跡可能だが、検証ロジックを trace DB だけで完結させるのは避ける。

### 2.4 真のソース: `.team/team.json`

daemon が `AGENT_SPAWNED` を受けて `conductor.agents.push(...)` する(`daemon.ts` L520)。`team.json` の構造:

```jsonc
{
  "conductors": [
    {
      "surface": "surface:100",       // Conductor の surface
      "taskId": "169",
      "agents": [
        { "surface": "surface:382", "role": "impl", ... }
      ]
    }
  ]
}
```

send-agent の検証は **team.json 経由が最も素直** (runtime の真のソース、同期タイムラグが小さい、列不足の問題なし)。trace DB は履歴索引であり検証用途には不向き。

### 2.5 templates/ja,en/conductor-role.md

ja 版 L229–230 に「他の Conductor surface を直接操作する」禁止記述あり。en 版も同等の位置にある想定(後述 3.3 で Read して確認)。`cmux-team spawn-agent`(L111 付近)と `cmux-team kill-agent`(L163 付近)のユースケース例あり。今回 `send-agent` の用例を追記する。

## 3. 実装変更点

### 3.1 PreToolUse hook 追加(task-167 plan 4〜5 節を流用)

**場所**: `generateConductorSettings` の `conductorSettings.hooks` オブジェクトに `PreToolUse` キーを追加。既存 4 hook と同居。

```ts
PreToolUse: [
  {
    matcher: "Bash",
    hooks: [{
      type: "command",
      command: "bash -c '<下記スクリプト>'",
      timeout: 3000,
    }],
  },
],
```

**hook スクリプト本体**(task-167 plan 4.3 の bash+grep 版を流用、メッセージのみ本タスク指定に差し替え):

```bash
input="$(cat)"
cmd="$(printf "%s" "$input" | grep -oE "\"command\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed -E "s/^\"command\"[[:space:]]*:[[:space:]]*\"//; s/\"$//")"
if printf "%s" "$cmd" | grep -qE "(^|[^-[:alnum:]_])cmux[[:space:]]+(send|send-key)([[:space:]]|$)"; then
  echo "cmux send / cmux send-key は Conductor から使用禁止です。Agent へのメッセージ送信は cmux-team send-agent を使ってください。" >&2
  exit 2
fi
exit 0
```

**判定設計**(task-167 plan 4.1〜4.2 を踏襲):

| 正規表現 | 判定 |
|---|---|
| `(^\|[^-[:alnum:]_])cmux[[:space:]]+(send\|send-key)([[:space:]]\|$)` | ブロック対象 |

- `cmux-team <anything>` は `[^-[:alnum:]_]` により `-` が前置条件でマッチせず通る。
- `cmux read-screen` / `cmux tree` / `cmux list-status` / `cmux identify` / `cmux close-surface` / `cmux new-split` / `cmux new-surface` / `cmux rename-tab` など subcommand が異なるものは通る。
- `sender` のような部分一致は `(send|send-key)` 直後の space/行末条件で除外。
- `grep "cmux send" file` のような埋め込み文字列は誤検知でブロックされるが、task-167 plan 4.2 と同じく許容(代替案: `cmux-team` の grep に書き換え、または別セパレータ文字で検索)。

**エラーメッセージ**(本タスクの指定通り、句読点まで一致させる):

```
cmux send / cmux send-key は Conductor から使用禁止です。Agent へのメッセージ送信は cmux-team send-agent を使ってください。
```

Claude は hook の stderr を読んで次行動を決める。**代替手段を明示する**ことが重要。

### 3.2 `cmux-team send-agent` サブコマンドを新設

#### 3.2.1 CLI 仕様

```
cmux-team send-agent --surface <agent-surface> <message>
cmux-team send-agent --surface <agent-surface> [--no-return] <message>
```

- **必須引数**:
  - `--surface <agent-surface>`: 送信先 Agent surface(例: `surface:382`)
  - positional `<message>`: 1 個の文字列(シェルでクォート済み前提)。複数 positional の場合は `process.argv` の残余を space で join する(`cmux-team send` の既存挙動に揃えると自然)。
- **オプション**:
  - `--no-return`: 送信後の `send-key return` を抑制(通常は送信 + Enter 押下を行う)。既定は Enter 押下あり。
- **環境変数**:
  - `CMUX_SURFACE`(必須): 呼び出し側 Conductor の surface。無ければ `cmux identify` の `caller.surface_ref` にフォールバックする。両方取得不可ならエラー。
- **help**: `--help` で使い方を表示(`hasHelpFlag()` の既存パターン使用)。

#### 3.2.2 検証ロジック(team.json 参照)

task.md 原文は「traces.db の task_sessions で conductor_surface = $CMUX_SURFACE かつ surface = <target> を確認」としているが、**`task_sessions` に `conductor_surface` 列は存在しない**(§2.3 で確認)。trace-store.ts のスキーマを変えずに済み、runtime の真のソースである `.team/team.json` を使う:

```ts
const callerSurface = process.env.CMUX_SURFACE || (await cmux.getCallerSurface());
const targetSurface = requireArg("surface");

const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
if (!existsSync(teamJsonPath)) {
  console.error("Error: .team/team.json not found. cmux-team start を実行してください。");
  process.exit(1);
}
const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
const conductor = (teamJson.conductors ?? []).find((c: any) => c.surface === callerSurface);
if (!conductor) {
  console.error(`Error: caller surface ${callerSurface} は Conductor として登録されていません。`);
  process.exit(1);
}
const agent = (conductor.agents ?? []).find((a: any) => a.surface === targetSurface);
if (!agent) {
  console.error(`Error: surface ${targetSurface} はこの Conductor (${callerSurface}) が spawn した Agent ではありません。`);
  process.exit(1);
}
```

**拒否ケース**:
- `callerSurface === targetSurface`(自己送信): Conductor 一覧に Agent として自分は登録されないため `agent not found` で自然に弾ける。さらに明示チェックを冒頭に入れて親切なメッセージにしてもよい。
- 他 Conductor の surface: その Conductor の agents にしか入っていないため、呼び出し側 Conductor の agents から見つからず拒否される。
- 他 Conductor の Agent surface: 同上。
- 存在しない surface: agents から見つからず拒否。

追加の保険として送信直前に `cmux.validateSurface(targetSurface, workspace)` を呼び、cmux 側で surface 不在なら `Error: surface validation failed` で終了する(`cmdSpawnAgent` L1099 と同じパターン)。

#### 3.2.3 送信実行

```ts
const workspace = await cmux.getCallerWorkspace();
await cmux.send(targetSurface, message, { workspace });
if (!noReturn) {
  await sleep(500); // 既存 send パターンに合わせて 500ms wait
  await cmux.sendKey(targetSurface, "return", { workspace });
}
console.log(`OK sent to ${targetSurface}`);
```

- `cmux.send` / `cmux.sendKey` は `cmux.ts` の既存ラッパー(L65/L76)をそのまま使う。
- workspace 指定は CLAUDE.md「cmux API 使用上の注意」に従って必ず渡す(他 workspace の surface と混同しないため)。
- 失敗時は runCmux が stderr 付き Error を throw する(`cmux.ts` L20–33)。catch せず上位に漏らすか、catch したら `log("error", ...)` で stderr を含めて記録(ロギングポリシー)。

#### 3.2.4 ルーティング追加

`main.ts` L2170 付近の `switch (command)` に:

```ts
case "send-agent":
  await cmdSendAgent();
  break;
```

関数 `cmdSendAgent` を `cmdKillAgent`(L1260) の直下に追加する(ファイル内配置の一貫性)。

#### 3.2.5 help テキスト / i18n

`i18n.ts` に `help_send_agent` キーを追加(ja/en)。また `help_main` のサブコマンド一覧に `send-agent` を記載する(`cmdSpawnAgent` / `cmdKillAgent` と同じ粒度)。

### 3.3 templates/{ja,en}/conductor-role.md 更新箇所

**編集の鉄則**(CLAUDE.md「プロンプト編集ルール」): `skills/cmux-team/templates/` のみ編集。`.team/prompts/` は触らない。

#### 3.3.1 ja 版追記

L230 付近の「他の Conductor surface を直接操作する」禁止記述を書き換え、`send-agent` への誘導を追加:

```md
- **他の surface に cmux send / cmux send-key で直接送信する** — 禁止。hook で実行時にブロックされる。Agent 起動は `cmux-team spawn-agent`、Agent への追加指示は `cmux-team send-agent`、Agent 終了は `cmux-team kill-agent` を使う。他の Conductor surface(自分以外)は一切触らない。
```

さらに「Agent 監視ループ」(L122 付近)の直後か「Agent spawn」セクション末尾(L120 付近)に新セクションを追加:

```md
## Agent が途中で停止した場合の回復

Agent が API エラー(レート制限 / overloaded / ネットワーク断)で停止していたら、`cmux-team send-agent` で再開プロンプトを送る。`cmux send` は hook でブロックされるので使わないこと。

```bash
# 例: レート制限で止まった Agent に「続けてください」と送る
cmux-team send-agent --surface $AGENT_SURFACE "続けてください"

# 例: 明示的にタスクを指示しなおす
cmux-team send-agent --surface $AGENT_SURFACE "plan.md の 3 節から再開してください"
```

検証ルール: `send-agent` は `team.json` を参照し、**このConductor が spawn した Agent** にのみ送信を許可する。他の Conductor / 自分自身 / 存在しない surface 宛は拒否される。
```

#### 3.3.2 en 版追記

上記と同等の内容を英語化して挿入。位置は ja 版と対応する行(共通構造のはず。Impl が en/conductor-role.md を Read して該当箇所を見つけて同じ構成で追記する)。

### 3.4 ロギング(ロギングポリシー遵守)

- `cmdSendAgent` の冒頭で `log("send_agent_started", \`caller=${callerSurface} target=${targetSurface}\`)` を出す(daemon.log と同じ logger を使う)。
- 検証失敗時は `log("send_agent_rejected", \`caller=... target=... reason=...\`)` を記録してから `process.exit(1)`。
- `cmux.send` / `cmux.sendKey` の例外を catch する場合は `log("error", \`send-agent failed: caller=${callerSurface} target=${targetSurface} ${e.message} stderr=${e.stderr ?? ""}\`)` を残す。catch しない選択肢もある(runCmux が既に詳細 Error を投げる)。
- 成功時は `log("send_agent_completed", \`caller=${callerSurface} target=${targetSurface} bytes=${message.length}\`)`。
- 秘密情報回避: メッセージ本文そのものをログに載せない(bytes のみ)。

## 4. テスト方針

### 4.1 PreToolUse hook 単体テスト(task-167 plan 6.1 に準拠)

`skills/cmux-team/manager/main.test.ts` を新設(既存テストファイルの配置規約に合わせる。無ければ新規作成)し、以下を assert:

- `generateConductorSettings(projectRoot, surface)` の戻り値パスを読み JSON.parse。
- `hooks.PreToolUse` が配列として存在。
- `[0].matcher === "Bash"`。
- `[0].hooks[0].type === "command"`、`[0].hooks[0].command` に `cmux`, `send`, `exit 2` の文字列を全て含む。
- `[0].hooks[0].timeout === 3000`。
- エラーメッセージ文言 `cmux send / cmux send-key は Conductor から使用禁止です。` が command に含まれる(リテラル検索)。
- 既存の `SessionStart` / `Stop` / `SessionEnd`(2 要素)が残存(regression 防止)。

### 4.2 hook スクリプト挙動テスト(task-167 plan 6.2 を踏襲)

hook の bash スクリプトを `execFile("bash", ["-c", script])` で直接実行し、stdin に擬似 JSON を流して exit code と stderr を検証する。

| 入力 `tool_input.command` | 期待 exit | 期待 stderr |
|---|---|---|
| `cmux send surface:382 hello` | 2 | 新エラーメッセージ |
| `cmux  send surface:382 hi`(2 スペース) | 2 | 新エラーメッセージ |
| `cmux send-key surface:382 return` | 2 | 新エラーメッセージ |
| `cmux-team spawn-agent --role impl` | 0 | なし |
| `cmux-team send-agent --surface surface:382 "hi"` | 0 | なし |
| `cmux-team send SESSION_STARTED` | 0 | なし |
| `cmux read-screen --surface surface:382` | 0 | なし |
| `cmux tree` | 0 | なし |
| `cmux close-surface --surface surface:382` | 0 | なし |
| `ls -la && git status` | 0 | なし |
| `echo "cmux send demo"` | 2(誤検知、許容) | 新エラーメッセージ |

### 4.3 send-agent 単体テスト

対象: `cmdSendAgent` の検証ロジック。実装時に関数を testable に切り出す(例: 検証ロジックを `validateSendAgentTarget(teamJson, callerSurface, targetSurface): { ok: boolean; reason?: string }` として export、cmdSendAgent はその結果を受けてシェル実行)。

ケース:

| teamJson の状態 | caller | target | 期待結果 |
|---|---|---|---|
| caller が Conductor、target が caller.agents にある | surface:100 | surface:382 | ok |
| caller が Conductor、target が caller.agents にない | surface:100 | surface:999 | reject(agent not found) |
| caller が Conductor、target が 他 Conductor(surface:200) | surface:100 | surface:200 | reject |
| caller が Conductor、target が 他 Conductor の Agent | surface:100 | surface:420(surface:200 の agent) | reject |
| caller が Conductor、target == caller | surface:100 | surface:100 | reject(self) |
| caller が teamJson.conductors に無い | surface:999 | surface:382 | reject(not a conductor) |
| teamJson が存在しない | - | - | exit 1 with clear msg |

cmux.send / sendKey は Impl が最小限の動作確認(mock または dry-run オプション)で経路検証。完全なモックライブラリ導入は不要。

### 4.4 E2E(手動)

1. ローカルで `npm run build` 相当 + `cmux-team start` を実行。
2. 生成された `.team/prompts/<surface>-settings.json` に `PreToolUse` エントリが入っていることを確認。
3. Conductor Claude に `cmux send other-surface hello` を指示 → hook でブロックされ、stderr に新エラーメッセージが表示されることを確認。
4. `cmux-team spawn-agent` で Agent 起動 → `cmux-team send-agent --surface <agent> "ping"` で Agent タブに `ping` + Enter が届くことを確認。
5. 他 Conductor の surface を target に指定 → 拒否されることを確認。
6. `cmux-team kill-agent` で Agent を閉じた直後に `send-agent` → team.json から削除済みで reject されることを確認(timing によっては validateSurface でも弾かれる)。

## 5. 実装上の懸念

| 懸念 | 対応 |
|---|---|
| 既存 Conductor は起動時の settings.json を読み込むため hook は **再起動後** に効果が出る | README / CHANGELOG に明記。デプロイ手順として `cmux-team stop` → `start` を必須化 |
| hook 誤動作で全 Bash をブロックすると Conductor が詰む | テスト 4.2 で一般コマンド(`ls`, `git status`, `npm test`, `cmux tree` 等)の通過を確認 |
| grep による JSON 抽出は `\"` や改行を含む command に弱い | Bash tool が実行するコマンドに `\"` を含むケースは稀(ヒアドキュメント等)。問題化したら Node 1-liner に切替(task-167 plan 4.3 と同じ方針) |
| `team.json` が未生成の時期に send-agent が呼ばれる | `existsSync` で早期終了 + 明確なエラーメッセージ(cmux-team start 未実行) |
| `team.json` 更新は daemon 経由なので数 ms〜秒のラグ有り | spawn-agent 直後すぐに send-agent すると agents に未反映の可能性。`AGENT_SPAWNED` postMessage は spawn-agent 完了前に実行されるが、daemon queue 処理でファイル反映までラグがある。Impl は Conductor が spawn-agent の stdout を読んだ後 1 秒程度待ってから send-agent を呼ぶガイドを conductor-role.md に添える |
| CMUX_SURFACE 未設定で実行された場合 | `cmux identify` で caller.surface_ref を取得するフォールバック。両方無ければ exit 1 |
| trace DB スキーマ変更は不要 | §2.3 確認済み。`task_sessions` に `conductor_surface` 列を追加する方針は **却下**(運用 DB のマイグレーションリスク、team.json で代替可能) |
| hook ブロックが `cmux-team send-agent` 内部の `cmux send` 子プロセスに波及しないか | 波及しない。hook は Claude Code の Bash tool 起動時のみ発火。`cmux-team` バイナリ内部の execFile は対象外(task-167 plan §7 と同じ原理) |
| Master セッションへの同 hook 展開 | out of scope。必要なら別 issue |

## 6. 納品物

### 6.1 コード変更

- `skills/cmux-team/manager/main.ts`
  - `generateConductorSettings` に `PreToolUse` hook を追加
  - `cmdSendAgent` 関数を追加(kill-agent の直下)
  - switch/case に `send-agent` を追加
  - help テキスト(`help_main` / `help_send_agent`)更新
- `skills/cmux-team/manager/i18n.ts` に `help_send_agent` キー追加(ja/en)
- `skills/cmux-team/templates/ja/conductor-role.md` 更新(§3.3.1)
- `skills/cmux-team/templates/en/conductor-role.md` 更新(§3.3.2)

### 6.2 テスト

- `skills/cmux-team/manager/main.test.ts`(新規 or 既存)に §4.1・§4.2・§4.3 のテストを追加

### 6.3 CHANGELOG エントリ

```
## [未リリース]

### Added
- `cmux-team send-agent` サブコマンド追加。Conductor から自分が spawn した Agent への正規メッセージ送信手段(#21, #22)。
- Conductor の PreToolUse hook を追加。Bash tool 経由の `cmux send` / `cmux send-key` を実行時にブロックし、代替として `cmux-team send-agent` を案内する(#21)。

### Changed
- `conductor-role.md`(ja/en): 他 surface 直接操作禁止の記述を強化し、Agent 回復時の `send-agent` 使用例を追記。
```

### 6.4 コミットメッセージ(分割)

1. `feat(conductor): block cmux send/send-key via PreToolUse hook (#21)`
2. `feat(cli): add cmux-team send-agent subcommand (#21, #22)`
3. `docs(conductor-role): document send-agent usage for agent recovery`

または単一コミット: `feat(conductor): block cmux send/send-key hook + add send-agent CLI (#21, #22)`。Impl の判断で可。

## 7. 実装しないこと(out of scope)

- `task_sessions` テーブルへの `conductor_surface` 列追加(team.json で代替できるため不要)
- Master / Agent セッションへの同 hook 展開
- `cmux-team` サブコマンド側の `cmux send` 呼び出し経路の制限(内部子プロセスは hook 対象外で問題なし)
- jq を使った堅牢な JSON パース(現行 grep で実用十分、必要になってから)
- conductor-role.md の「禁止事項」記述の全面削除(hook で強制されても文書記述は残す。hook 導入後も開発者がコードを読んで意図を理解できるようにする)
- mado 等別プロジェクトの `.team/prompts/` 更新(CLAUDE.md「プロンプト編集ルール」に基づき `cmux-team start` 再生成で対応。本タスクはテンプレ側だけ)
- `cmux-team send-agent --bare` のような OAuth 関連オプション(メッセージ送信に認証は不要)
