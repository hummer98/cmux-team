---
id: 203
title: sessionId を SessionStart hook 経由で一元化し /clear 後の resume を回復する
priority: high
created_at: 2026-04-15T06:35:19.167Z
---

## タスク
## 背景

`cmux-team resume <task-id>` が `No conversation found with session ID: <UUID>` で失敗する事例が発生（KDG-discord-listner で task 030）。原因調査で以下が判明した:

- Conductor 常駐セッション方式（`9fe8d6c`）は「sessionId は初回起動時に発行し以降不変」を前提にしているが、Claude Code の `/clear` は内部で新 session-id を発行する仕様
- daemon 側は `/clear` 後の新 sessionId を受け取っていない（`daemon.ts:742` SESSION_STARTED ハンドラは pid のみ更新、sessionId は触らない）
- 結果として task-state.json には初回の UUID1 が凍結記録され続け、`/clear` で破棄された後の UUID1 を resume しようとして失敗する
- Agent 側は `0fb4ec1` (#16) で proxy 経由の session-id 取得が実装されているが、Conductor 側には一度も proxy 経由の取得ルートが存在しなかった

議論の結論:
- proxy 経由は「通信の副作用」で semantic でない、タイミング遅延、依存（proxy 必須）の問題がある
- **SessionStart hook 経由に一本化するのが筋**。Claude Code の SessionStart hook 入力 JSON には `session_id` と `source: startup|resume|clear|compact` が含まれるため、起動直後に確定・`/clear` 判定も可能
- T181 で導入済みの `cmux-team send --from-stdin` 汎用パイプライン（`main.ts:686-716`）を使えば shell で jq せずに本体側で JSON を解釈できる
- Conductor/Agent 両方の sessionId 取得を hook ルートに揃えることで「方針のブレ」を解消する

## ゴール

- `/clear` 後も daemon が常に最新の sessionId を把握している状態にする
- `cmux-team resume <task-id>` が `/clear` を経たタスクでも成功する
- Conductor/Agent で sessionId 取得経路を **SessionStart hook 経由に統一**（proxy/CONDUCTOR_SESSION message は廃止）

## 変更対象（概要）

いずれも `skills/cmux-team/manager/` 配下。

### 1. SessionStart hook からの送信経路を整備

**`main.ts:686-716` `--from-stdin` ハンドラ拡張**
- 現在: stdin JSON をそのまま QueueMessage として Zod validate
- 変更: type 引数が指定されている場合、stdin JSON を Claude Code hook 入力形式（`{hook_event_name, session_id, transcript_path, cwd, source}`）として解釈し、引数（`--surface`, `--pid`）と組み合わせて対応する QueueMessage を組み立てる
- 対象 type は少なくとも `SESSION_STARTED`（将来的に他の hook event にも拡張可）
- 既存の「stdin JSON をそのまま QueueMessage として受け取る」パスは T189 SESSION_STOP forwarder が使っているので破壊しないこと

**`main.ts:1074-1080` Agent settings の SessionStart hook 生成**
**`main.ts:1132-1138` Conductor settings の SessionStart hook 生成**
- 現在: `cmux-team send SESSION_STARTED --surface "${CMUX_SURFACE}" --pid "$PPID"` を直接実行
- 変更: stdin pipe 方式に変更する。例:
  ```bash
  cmux-team send SESSION_STARTED --from-stdin --surface "${CMUX_SURFACE}" --pid "$PPID"
  ```
- Claude Code hook は stdin に JSON を渡す仕様なので、`--from-stdin` フラグを立てれば自動で stdin から読み取り、`session_id` を `sessionId` にマップできる

### 2. daemon 側で最新 sessionId を保持

**`daemon.ts:742-795` SESSION_STARTED ハンドラ**
- 現在: `conductor.pid = message.pid` のみ、sessionId は触らない
- 変更: `if (message.sessionId) conductor.sessionId = message.sessionId;` を追加（Conductor 分岐・Agent 分岐の両方）
- 既存の「初回 session 固定」前提のコメント (`conductor.ts:470, 557`) も修正し、「最新値に追従する」旨に書き換える

### 3. proxy / CONDUCTOR_SESSION 経路の廃止

**`proxy.ts:246-265`** — Agent 用の `agent.sessionId = sessionId` 代入ロジックを削除
- #16 で追加されたコードだが、hook ルートに統一するので不要
- `sessionId = req.headers.get("x-claude-code-session-id")` 自体は trace/ログ用に残してよい（state mutation のみ撤去）

**`main.ts:1216-1235, 1249` cmdConductor**
- 現在: `crypto.randomUUID()` で sessionId を自己生成し、`CONDUCTOR_SESSION` message で daemon に通知し、`--session-id` で Claude に渡して固定
- 変更: これら一切を撤廃。Claude に自己生成させて SessionStart hook で拾う（Agent と同じ方式）
- Claude 起動コマンドから `--session-id sessionId` を削除
- `CONDUCTOR_SESSION` POST 処理を削除

**`daemon.ts:811-827` CONDUCTOR_SESSION ハンドラ削除**
**`schema.ts:105-110` ConductorSessionMessage 定義削除**
**`schema.ts:117-` QueueMessage discriminatedUnion から ConductorSessionMessage を除外**
**`main.ts:831-841` CONDUCTOR_SESSION の send case 削除**
**`main.ts:845` Usage 文字列から CONDUCTOR_SESSION 削除**

**`conductor.ts:246-280` あたりの resume/fallback で `sessionId: resumeItem.sessionId` を使っている箇所**
- CONDUCTOR_SESSION 経路を削除しても `ConductorState.sessionId` フィールドは残す（hook 経由で更新されるため）

### 4. 仕様書の修正

**`docs/spec/05-install-and-infrastructure.md:163, 250`**
- `:250` の「`sessionId` は Conductor 初回起動時に `crypto.randomUUID()` で発行され、タスク割り当てやリセットで変更されない（常駐セッションのため）。」を書き換える
- 新方針: 「`sessionId` は Claude 自身が発行する。SessionStart hook 経由で daemon に届き、`/clear` 等で新 session が開始されるたびに最新化される。task-state.json に記録されるのは assignTask 時点の最新 sessionId。」
- `:163` 付近の resume 条件「`sessionId` が記録されている」はそのまま有効

**`docs/spec/06-implementation-tasks.md:229, 263`**
- `:229` の T132「Conductor `--session-id`（T132）— Conductor 起動時に `crypto.randomUUID()` でセッション ID を発行し、resume 可能にする」を撤回
- `:263` の「Conductor `--session-id` 引数を撤廃し自己生成方式に」も撤回
- 代わりに「SessionStart hook 経由で sessionId を追従する方式に再設計（本タスクで実施）」を追記

## 調査・確認事項（実装前に必要）

1. **Claude Code SessionStart hook 入力 JSON の正確な形式** — フィールド名 `session_id`, `source`, その他のフィールド。公式 docs または hook 実行時の実測で確認する
2. **`source` フィールドの値による条件分岐** — 全 source (`startup`, `resume`, `clear`, `compact`) で追従してよいか、特定の source のみにすべきか検討
3. **CMUX_CLAUDE_HOOKS_DISABLED=1** が設定されている場合の挙動 — cmux の hook を無効化しているが、自作の settings.json hook は動くはず。要確認
4. **Agent 側 settings.json 生成** (`main.ts:1074` 付近) で SessionStart hook がすでに設定されているか、追加が必要か確認
5. **既存 resume が成功しているプロジェクト** での回帰テスト（cmux-team 自身の `.team/task-state.json` で動作確認）

## テスト計画

1. **単体**: `main.ts:686` の `--from-stdin` + type 指定パスを、ダミー Claude Code hook JSON を stdin に流して HTTP POST までのパスが動くことを確認
2. **統合**: cmux-team を `cmux-team start` → タスク割り当て → `/clear` → 再度タスク割り当て → `cmux-team stop` → `cmux-team start` で再起動 → resume が成功することを確認
3. **回帰**: KDG-discord-listner など実運用プロジェクトでも resume が動くこと
4. **ログ確認**: `.team/logs/manager.log` で `session_started` イベントに sessionId が含まれていること、`/clear` 後の SESSION_STARTED で異なる sessionId が記録されていること

## 参考情報（Master が議論中に確認済みの位置情報）

- `skills/cmux-team/manager/main.ts:686-716` — `--from-stdin` 汎用パイプライン（T181）
- `skills/cmux-team/manager/main.ts:1039-1041` — SESSION_STOP hook の stdin pipe 実装例
- `skills/cmux-team/manager/main.ts:1074-1080` — Agent SessionStart hook コマンド生成
- `skills/cmux-team/manager/main.ts:1132-1138` — Conductor SessionStart hook コマンド生成
- `skills/cmux-team/manager/main.ts:1216-1249` — cmdConductor の sessionId 自己生成 + CONDUCTOR_SESSION 通知 + `--session-id` 指定
- `skills/cmux-team/manager/main.ts:1264` — cmdConductor の cwd=PROJECT_ROOT
- `skills/cmux-team/manager/main.ts:1338` — cmdResume の cwd=worktreePath（仕様上の別問題だがこのタスクでは触らない）
- `skills/cmux-team/manager/daemon.ts:742-795` — SESSION_STARTED ハンドラ
- `skills/cmux-team/manager/daemon.ts:811-827` — CONDUCTOR_SESSION ハンドラ（削除対象）
- `skills/cmux-team/manager/proxy.ts:243-265` — Agent 用 session-id 拾い（state mutation 部分のみ削除対象）
- `skills/cmux-team/manager/conductor.ts:443-471, 546-557` — sessionId 関連コメント（修正対象）
- `skills/cmux-team/manager/schema.ts:105-110` — ConductorSessionMessage 定義（削除対象）

## 歴史的経緯（参考）

1. **T128 (`d45482b`)** — assignTask 時に `/exit` + Claude 再起動 + 新 `--session-id` 指定。resume 可能だが常駐セッション毎回破棄
2. **`9fe8d6c`** — `/clear` 方式に戻す。「sessionId は初回起動時に発行し Conductor のライフタイム中維持」という誤った前提を導入（Claude Code の /clear 挙動を見落とし）
3. **`d67e57c`** — `--session-id` CLI 引数を cmdConductor 内の自己生成に統合
4. **#16 (`0fb4ec1`)** — Agent 用に proxy 経由の session-id 拾いを追加（Conductor には未適用）
5. **本タスク** — 上記の「方針のブレ」を解消し、Conductor/Agent とも hook 経由に統一する

## 非目標（このタスクではやらない）

- `cmdResume` の cwd 問題（`main.ts:1338` で worktreePath を使う件）は別の話。このタスクの修正で resume は動くようになるはずだが、cwd/project dir の整合性は別タスクで改めて確認する
- KDG-discord-listner の task 030 の個別救済（別途ユーザー判断で ready 戻し or close する）
- トレース DB の session_id 記録変更（trace 側は proxy 経由のままで問題ない）
