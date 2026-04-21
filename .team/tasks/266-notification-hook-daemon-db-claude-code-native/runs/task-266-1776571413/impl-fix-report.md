# Impl Fix Report — T266 Finding 1 [Major]

## Scope

Inspector の Major 1 件のみに対応:

- **対象**: `CLAUDE.md:532-540` の「hook_signals enrichment 列（8 列）」箇条書き
- **種別**: ドキュメント修正のみ（コード変更なし）
- **他の Minor findings**: 今回は対応しない（スコープ厳守）

## Fix Applied

### 修正前（誤った列記）

```markdown
**hook_signals enrichment 列（8 列）:**
- `role` — master / conductor / agent / unknown
- `task_id` — role=conductor / agent の場合に daemon 側で解決
- `agent_role` — role=agent の場合に conductor の assigned agent map から解決
- `notification_type` — stdin JSON の `notification_type`（例: `permission_request`）
- `message` — stdin JSON の `message`（自由文）
- `hook_event_name` — stdin JSON の `hook_event_name`（通常 `Notification`）
- `session_id` — stdin JSON の `session_id`
- `cwd` — stdin JSON の `cwd`
```

**問題点**: `hook_event_name` / `session_id` / `cwd` という実在しない列を列挙し、実装で実在する `surface_uuid` / `workspace_uuid` / `conductor_surface` の 3 列が欠落していた。

### 修正後（実装と一致）

```markdown
**hook_signals enrichment 列（8 列）:**
- `surface_uuid` — hook 送信元 surface の UUID（`CMUX_SURFACE_UUID` env 由来、空文字は undefined に正規化）
- `workspace_uuid` — hook 送信元 workspace の UUID（`CMUX_WORKSPACE_UUID` env 由来、空文字は undefined に正規化）
- `role` — master / conductor / agent / unknown
- `task_id` — role=conductor / agent の場合に daemon 側で解決
- `conductor_surface` — role=agent の場合に親 conductor の surface を解決
- `agent_role` — role=agent の場合に conductor の assigned agent map から解決
- `message` — stdin JSON の `message`（自由文）
- `notification_type` — stdin JSON の `notification_type`（例: `permission_request`）
```

### 差分サマリ

- 追加: `surface_uuid`, `workspace_uuid`, `conductor_surface`（実装の実在列を反映）
- 削除: `hook_event_name`, `session_id`, `cwd`（hook_signals テーブルに存在しない列）
- 維持: `role`, `task_id`, `agent_role`, `message`, `notification_type`
- 並び順は実装側 `required` 配列（`trace-store.ts:164-173`）と同順に揃えた
- 既存の他セクション（stdin JSON の `emptyToUndef` 正規化説明、ログ形式、`trace-hooks` 検索例、Manager が state 遷移しない理由）は変更なし

## Verification

### 1. 実装側の正準列定義

`skills/cmux-team/manager/trace-store.ts:159-173` の `ensureHookSignalsColumns` 内
`required` 配列（= hook_signals テーブルの enrichment 列）:

```
"surface_uuid",
"workspace_uuid",
"role",
"task_id",
"conductor_surface",
"agent_role",
"message",
"notification_type",
```

同じ 8 列は以下でも一致:

- `trace-store.ts:95-102` — CREATE TABLE の列定義
- `trace-store.ts:357-364` — UPDATE hook_signals の SET 句（`updateNotificationEnrichment`）
- `trace-store.ts:41-48` — TypeScript 型の optional フィールド

### 2. grep による一致確認

```
$ grep -E "surface_uuid|workspace_uuid|conductor_surface|agent_role|notification_type" \
    skills/cmux-team/manager/trace-store.ts | head -20
```

出力（抜粋）:

```
41:  surface_uuid?: string | null;
42:  workspace_uuid?: string | null;
45:  conductor_surface?: string | null;
46:  agent_role?: string | null;
48:  notification_type?: string | null;
95:  surface_uuid TEXT,
96:  workspace_uuid TEXT,
99:  conductor_surface TEXT,
100:  agent_role TEXT,
102:  notification_type TEXT
165:    "surface_uuid",
166:    "workspace_uuid",
169:    "conductor_surface",
170:    "agent_role",
172:    "notification_type",
357:       surface_uuid = ?,
358:       workspace_uuid = ?,
361:       conductor_surface = ?,
362:       agent_role = ?,
364:       notification_type = ?
```

実装の 4 つの箇所（型 / CREATE TABLE / ALTER TABLE required / UPDATE SET）すべてで 8 列が揃っていることを確認。CLAUDE.md の修正後の列記はこれと完全一致。

### 3. 誤った列が残っていないことの確認

`hook_signals` テーブルに対して `hook_event_name` / `cwd` という列は存在しない:

```
$ grep -E "hook_event_name|\\bcwd\\b" skills/cmux-team/manager/trace-store.ts
（該当なし）
```

`session_id` は `task_sessions` テーブルの列として存在するが、`hook_signals` テーブルには存在しない（grep 結果の 18 / 72 / 82 / 195-230 行はすべて `task_sessions` 側の参照）。CLAUDE.md の当該セクションは hook_signals 専用の文脈なので、ここから削除したのは正当。

### 4. CLAUDE.md の事後確認

```
$ sed -n '532,540p' CLAUDE.md
**hook_signals enrichment 列（8 列）:**
- `surface_uuid` — hook 送信元 surface の UUID（`CMUX_SURFACE_UUID` env 由来、空文字は undefined に正規化）
- `workspace_uuid` — hook 送信元 workspace の UUID（`CMUX_WORKSPACE_UUID` env 由来、空文字は undefined に正規化）
- `role` — master / conductor / agent / unknown
- `task_id` — role=conductor / agent の場合に daemon 側で解決
- `conductor_surface` — role=agent の場合に親 conductor の surface を解決
- `agent_role` — role=agent の場合に conductor の assigned agent map から解決
- `message` — stdin JSON の `message`（自由文）
- `notification_type` — stdin JSON の `notification_type`（例: `permission_request`）
```

→ 8 列ちょうど、実装と同順、禁止列（`hook_event_name` / `session_id` / `cwd`）は含まれない。

### 5. コード変更なし

`.ts` ファイルは一切変更していない（ドキュメント修正のみ）。`bun test` は不要。

## Result

**Finding 1 [Major] RESOLVED** — CLAUDE.md の hook_signals enrichment 列一覧が実装と完全一致した。
