# task-168 blog ネタ抽出 成果

`/Users/yamamoto/git/zenn-content/tips/blog-tips.md` の末尾に 11 件の新規 tip を追記した（要件: 5 件以上）。

## 追記した tips と参照ソース

1. **ロール別の長文システムプロンプトは `--append-system-prompt-file` で外部ファイル注入する**
   - `skills/cmux-team/manager/main.ts:883-889`（cmdConductor の claudeArgs 組み立て）

2. **session-id 鶏卵問題の深掘り: 子プロセスで UUID 生成 → 起動前に親に HTTP 通知する**（既存エントリ2の深掘り）
   - `skills/cmux-team/manager/main.ts:857-889`（sessionId 自己生成 + CONDUCTOR_SESSION メッセージ送信）

3. **`claude --resume <sessionId>` は「起動時と同じ cwd」でしか動かない**
   - `skills/cmux-team/manager/main.ts:943-978`（cmdResume の `cwd: ts.worktreePath`）

4. **Claude Code の hook 発火タイミングを「Idle 検出 / ターン境界検出」に流用する**
   - `skills/cmux-team/manager/main.ts:765-821`（generateConductorSettings の SessionStart/Stop/SessionEnd matcher 定義）
   - `skills/cmux-team/manager/daemon.ts:665-705`（SESSION_IDLE ハンドラの状態遷移ロジック）

5. **Proxy に「メタデータ用カスタムヘッダ」を流してセッションの素性を識別する**（既存エントリ1の深掘り）
   - `skills/cmux-team/manager/proxy.ts:169-199`（x-cmux-* header 吸い上げ + x-claude-code-session-id の取り込み）

6. **Proxy で streaming レスポンスをログする定石: `ReadableStream.tee()` + ヘッダ除去の罠**
   - `skills/cmux-team/manager/proxy.ts:206-255`（fwdHeaders から host/accept-encoding 除去、resHeaders から content-encoding/length 除去、body.tee()）

7. **Proxy に「副業としてのデバッグ HTTP API」を生やして IPC を畳み込む**
   - `skills/cmux-team/manager/proxy.ts:102-167`（GET /state, /tasks, /conductors + POST /master-state, /api/messages）

8. **デーモンの自己再起動は「特定 exit code」を親で拾って restart するだけで足りる**
   - `bin/cmux-team.js:26-47`（exit code 42 での MAX_RESTARTS 回リトライ）

9. **Claude Code 子プロセスの生存確認は `process.kill(pid, 0)` が最安**
   - `skills/cmux-team/manager/daemon.ts:886-910`（spawnPidWatcher の 1 秒 interval）

10. **worktree ブートストラップの定型: 空の `.envrc` + `source_up` で親の direnv を継承させる**
    - `skills/cmux-team/manager/conductor.ts:259-294`（settings.local.json コピー + .envrc 生成 + npm install + direnv allow）
    - `skills/cmux-team/manager/envrc-prompt.ts:57-66`（起動時の対話確認）

## 既存エントリとの関係（明記）

- tip 2 は既存エントリ 2「session-id の鶏卵問題」の深掘り（対処パターンの実装詳細）
- tip 5 は既存エントリ 1「ANTHROPIC_BASE_URL Proxy」の深掘り（トークン取得だけでなく session 識別に使う踏み込み）
- 他の tip は既存エントリと重複しない新規テーマ

## 判断に迷った点・除外した候補

- **cmux tree の結果を `includes(surface)` で解釈する罠** — Claude Code 固有というより cmux 本体の使いこなしで、blog tips のテーマ「Claude Code 外部操作」から少しズレるので除外
- **`--dangerously-skip-permissions` でも初回 Trust 確認は抜けられない** — 既存エントリ 6 の派生で語りやすいが、内容が薄い（回避策は画面読み取り＋Enter 送信のみ）ので単独の tip にはせず見送り
- **surface 別 `.team/prompts/<surface>-settings.json` の動的生成** — 既存エントリ 3 の「`--settings` で任意 JSON」の延長で、一つの tip としての独立性が弱い。hook タイミングの話（tip 4）の中で実例として触れる形にまとめた
- **`cmux send` + `send-key return` のパターン** — 既に CLAUDE.md や cmux skill で説明済みの既知テクで、Claude Code 固有の tip ではないため除外
- **PID 通知に `$PPID` を使う小技** — tip 9 の中で触れたので独立させなかった

## 成果物の保存先

- 追記先: `/Users/yamamoto/git/zenn-content/tips/blog-tips.md`（末尾）
- cmux-team 本体 worktree 側は git 変更なし（CLAUDE.md の原則に従いコミットせず）
