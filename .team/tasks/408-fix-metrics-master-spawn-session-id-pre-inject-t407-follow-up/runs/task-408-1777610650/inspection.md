# T408 検品レポート

## Verdict: GO

すべての受け入れ条件 1〜9 を Inspector 自身の実行で確認し、T407 (commit b3d4734) と完全に対称な Master 経路が実装されている。スコープ外侵入なし、regression なし。

## 検品結果

### A. 受け入れ条件 (1〜9)

| # | 項目 | 結果 | 検証内容 |
|---|---|---|---|
| 1 | 新規 Master spawn で `claude --session-id <UUID>` が渡る | ✓ | `main.ts:2716-2774` `cmdLaunchMaster` で `generateSessionId()` → `buildMasterClaudeArgs({sessionId})` 経由で claude exec。`buildMasterClaudeArgs` (main.ts:2532-2545) は `["--dangerously-skip-permissions", "--settings", ..., "--model", ..., "--append-system-prompt-file", ..., "--session-id", sessionId]` を返す。`main.test.ts:3077-3138` で 5 件の単体テスト pass |
| 2 | 不一致時のみ `session_id_mismatch_at_startup_master` 出力 | ✓ | `daemon.ts:1714-1723` で `source === "startup" && prevSessionId && prevSessionId !== message.sessionId` の 3 条件 AND 時のみ log。`daemon.test.ts:6883-6913 (T-8 対称)` 一致時 warn 無し / `daemon.test.ts:6915-6946 (T-9 対称)` 不一致時 warn 1 件 + hook 上書き — 両 pass |
| 3 | 不一致時のみ `session_id_mismatch_at_register_late_master` 出力 | ✓ | `daemon.ts:2063-2069` で `existing.sessionId && existing.sessionId !== message.sessionId` 時のみ log。`daemon.test.ts:6802-6832 (T-12 対称)` で hook 確定済 sessionId 維持 + warn 確認 / `daemon.test.ts:6773-6800` で一致時 warn 無し — 両 pass |
| 4 | `master.sessionId` 永続化 | ✓ | `master.ts:23-50` `persistMasterFile` の payload に `sessionId: master.sessionId` 追加 (master.ts diff)。MasterStateSchema 検証経由で `.team/masters/<normalized>.json` に書き出し。`daemon.test.ts:6747-6750` で永続ファイルの中身が `sessionId` を含むことを直接 verify (T-2 対称テスト) |
| 5 | T407 と対称な Master テスト全 green | ✓ | schema.test.ts 64 pass / main.test.ts 231 pass / daemon.test.ts 209 pass / master.test.ts 19 pass。impl-notes の 504 と一致 |
| 6 | `bunx tsc --noEmit` で新規エラー 0 | ✓ | Inspector 実行: `tsc exit=0` (エラー / warn 0) |
| 7 | `generateSessionId()` の DRY 再利用 | ✓ | `main.ts:2472` で T407 の export を `cmdLaunchMaster` (main.ts:2726) が再利用。Master 用に独立 UUID 生成器を導入していない |
| 8 | sessionId は optional で旧バージョン互換 | ✓ | `schema.ts:106` `MasterRegisteredMessage.sessionId: z.string().optional()` / `schema.ts:340` `MasterStateSchema.sessionId: z.string().optional()`。`schema.test.ts:567-573` (sessionId 無し parse) / `schema.test.ts:596-606` (sessionId 無し state parse) で確認。さらに `daemon.test.ts:6756-6771` で sessionId 無し POST が actual handler 経路でも通る (T-2 対称後方互換テスト) |
| 9 | `task_sessions` テーブルに master 行が無い | ✓ | `cmdLaunchMaster` (main.ts:2716-2775) に `insertTaskSession` 呼び出しなし。`grep -n insertTaskSession main.ts daemon.ts` で確認した呼び出し箇所:<br>・main.ts:3165 (cmdSpawnAgent / Agent T407)<br>・main.ts:4096 (cmdCloseTask / 完了)<br>・main.ts:4594 (cmdAbortTask / 中止)<br>・daemon.ts:4064 (assigned 行 T407)<br>すべて Master 経路ではない |

### B. T407 との対称性

| 項目 | T407 (Conductor) | T408 (Master) | 対称性 |
|---|---|---|---|
| `XXX_REGISTERED` handler 既存 entry 路 | daemon.ts:1971-2014 (`session_id_mismatch_at_register_late` warn) | daemon.ts:2045-2103 (`session_id_mismatch_at_register_late_master` warn) | ✓ ロジック完全対称、`_master` suffix のみ差異 |
| `XXX_REGISTERED` handler 新規 entry 作成 + sessionId 初期化 | daemon.ts:2024-2031 (`sessionId: message.sessionId`) | daemon.ts:2104-2126 (同左 + `persistMasterFile` 呼び出し) | ✓ Master のみ persist 必要なので追加経路あり |
| MASTER_REGISTERED 既存 entry + sessionId 採用時の persist | N/A (Conductor は team.json 経由で別経路) | daemon.ts:2086-2097 `else if (sessionUpdated)` 分岐で `persistMasterFile` + `notifyStateChanged` | ✓ impl-notes 「補足対応 §2」で意図を明記、Conductor 対称ではないが受け入れ条件 #4 を満たすため必須 |
| SESSION_STARTED 整合性チェック | daemon.ts:1813-1831 (Conductor 分岐) | daemon.ts:1707-1725 (Master 分岐) | ✓ `prevSessionId` capture → `source === "startup"` 不一致なら warn → 常に上書き、構造完全一致 |
| mismatch warn ログ詳細 | `existing_session_id=X preinject_session_id=Y` / `preinject_session_id=X hook_session_id=Y` | 同形式（formatSurface "U" のみ差異） | ✓ key 名 + payload 形式とも対称 |
| `buildXxxClaudeArgs` フラグ列 | `[--dangerously-skip-permissions, --settings P, --model M, --append-system-prompt-file R, --session-id S, (taskPromptFile?)]` | `[--dangerously-skip-permissions, --settings P, --model M, --append-system-prompt-file R, --session-id S]` | ✓ Conductor から `taskPromptFile` 末尾引数を除いた形と完全一致 (main.ts:2503-2521 vs 2532-2545) |
| `task_sessions` 行 | 書く (assigned / agent_spawned) | 書かない | ✓ plan / 仕様通り |
| 後方互換 (sessionId なし POST) | optional 受理 | optional 受理 | ✓ 対称 |

### C. 検証実行結果

Inspector 自身が実行した結果:

```
$ bunx tsc --noEmit
tsc exit=0  (エラー 0)

$ bun test --timeout 60000 schema.test.ts        →  64 pass /  0 fail
$ bun test --timeout 60000 main.test.ts          → 231 pass /  0 fail
$ bun test --timeout 60000 daemon.test.ts        → 209 pass /  0 fail
$ bun test --timeout 60000 master.test.ts        →  19 pass /  0 fail
$ bun test --timeout 60000 metrics-cli.test.ts   →  18 pass /  0 fail
$ bun test --timeout 60000 trace-store-metrics.test.ts → 22 pass / 0 fail
$ bun test --timeout 60000 trace-store.test.ts   →  38 pass /  0 fail
                                                  ─────────────────
                                                   601 pass /  0 fail
```

`impl-notes.md` の plan scope 内合計 504 (schema 64 + main 231 + daemon 209) と Inspector 実測値が一致。範囲外の master / metrics-cli / trace-store* も regression 無し。

### D. T407 regression 確認

```
$ bun test --timeout 60000 daemon.test.ts -t "T407"  → 12 pass / 0 fail
$ bun test --timeout 60000 daemon.test.ts -t "T408"  → 10 pass / 0 fail
```

具体的にカバーされた T407 describe ブロック (`daemon.test.ts:6294-6710`):
- `CONDUCTOR_REGISTERED で sessionId pre-inject 受信 (T407)` — T-2 / T-12 含む
- `AGENT_SPAWNED で sessionId pre-inject 受信 (T407)`
- `SESSION_STARTED 整合性チェック (T407)` — T-8 / T-9 / R2 含む
- `task_sessions append-only 維持 (T407 Step 8)`

すべて無改変のまま全件 pass。

### E. スコープ外侵入

なし。`git diff b3d4734 -- main.ts daemon.ts schema.ts` を grep:

- `conductor.sessionId` / `agent.sessionId` への変更: 0 件
- `generateSessionId` 関数定義への変更: 0 件 (再利用のみ)
- `CONDUCTOR_REGISTERED` / `AGENT_SPAWNED` handler への変更: 0 件
- `insertTaskSession` 呼び出しの追加: 0 件
- `cmdLaunchMaster` 内の deletion: claude args の直接 spread を `buildMasterClaudeArgs` 経由に置換した部分のみ（仕様通り）
- daemon.ts / schema.ts の deletion: 0 件 (純粋追加のみ)

defensive code / 過剰 fallback / 設計判断を要する変更も検出されず。

### F. 実装品質

**良い点:**
- ログキー命名が plan.md 通り (`session_id_mismatch_at_startup_master` / `session_id_mismatch_at_register_late_master`)
- mismatch warn ログ詳細に `preinject_session_id` / `hook_session_id`（または `existing_session_id` / `preinject_session_id`）が両方含まれており T407 と完全対称 (daemon.ts:1721 / 2067)
- `buildMasterClaudeArgs` の引数型 (`{masterSettingsPath, model, rolePromptFile, sessionId}`) / フラグ順序が plan.md `Step 2` の宣言と一致
- 後方互換性が schema (zod optional) だけでなく実 handler 経路 (`daemon.test.ts:6756-6771` 等) でも検証されている
- `persistMasterFile` payload の `sessionId` 明示追加 (`master.ts:42`) は impl-notes 補足対応 §1 で意図が記録されており、テストも永続ファイル中身を直接 verify している
- TDD サイクルが impl-notes に明記されており、各 step の赤→緑が再現可能

**気になる点:**
- なし（NOGO 相当の問題は検出されず）

## Fix Required

なし (GO)。

## Minor Findings

1. **stale なコメント (main.ts:1665)**: `registerSelf` 内の `T407` コメントに「Master スコープでは渡されないため undefined のまま JSON.stringify で省略される」とあるが、T408 で Master も sessionId を渡すようになったため記述と乖離。挙動に影響なし、`if (sessionId) body.sessionId = sessionId;` の条件分岐は両 role で機能している。本タスク内で 1 行修正を推奨（別タスク化不要）。

   修正案 (例):
   ```ts
   // T407/T408: Conductor / Master とも cmdConductor / cmdLaunchMaster 側で
   //   `crypto.randomUUID()` を発行し sessionId として POST に同梱する。
   //   未指定（旧クライアント / spawn-conductor 等）の場合は JSON.stringify で省略される。
   ```

2. **受け入れ条件 #4 の永続化先表記**: タスク本文 (および plan.md) は「team.json または `.team/masters/<surface>.json`」だが、実装は後者のみ。これは "or" 表記の許容範囲で plan 通りだが、将来的に team.json への永続化も求められた場合は別途対応が必要。本タスクでは追加対応不要。
