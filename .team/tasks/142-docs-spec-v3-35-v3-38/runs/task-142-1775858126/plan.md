# docs/spec/ v3.35〜v3.38 同期計画書

## 概要

docs/spec/ の最終更新（7dfc8c3、2026-04-10）以降、v3.35〜v3.38（20コミット、T127〜T141）で追加された機能・修正を docs/spec/ 7ファイルに反映する。

対象コミット範囲: `afcb5bf..39e4f25`

---

## 更新対象ファイルと優先順位

| # | ファイル | 優先度 | 変更量 |
|---|---------|--------|--------|
| 1 | 05-install-and-infrastructure.md | 高 | 大 |
| 2 | 01-skill-cmux-team.md | 高 | 中 |
| 3 | 03-commands.md | 高 | 小 |
| 4 | 00-project-overview.md | 中 | 小 |
| 5 | 06-implementation-tasks.md | 中 | 中 |
| 6 | 02-skill-cmux-agent-role.md | 中 | 小 |
| 7 | 04-templates.md | 低 | なし（変更不要） |

---

## ファイル別変更内容

---

### 1. 05-install-and-infrastructure.md（高・大）

#### 1-1. CLI サブコマンド表に `resume` を追加

**場所:** `### CLI サブコマンド` セクションの表（105行目付近）

**修正:** 表に以下の行を追加。`artifacts` 行の直後に挿入。

```markdown
| `resume` | assigned タスクの Conductor セッションを `claude --resume` で再開 |
```

#### 1-2. CLI サブコマンド表: `update-task` の説明を更新

**場所:** `### CLI サブコマンド` セクションの `update-task` 行（117行目）

**修正前:**
```markdown
| `update-task` | タスク更新（`--status` / `--title` / `--body`、draft → ready で TASK_CREATED トリガー） |
```

**修正後:**
```markdown
| `update-task` | タスク更新（`--status` / `--title` / `--body` / `--depends-on`、draft → ready で TASK_CREATED トリガー） |
```

#### 1-3. CLI サブコマンド表: `artifacts` の説明を拡充

**場所:** `### CLI サブコマンド` セクションの `artifacts` 行（124行目）

**修正前:**
```markdown
| `artifacts` | アーティファクト一覧・検索 |
```

**修正後:**
```markdown
| `artifacts` | アーティファクト一覧・検索・追加（`add`）・表示（`show`）・Markdown ビューア（`open`） |
```

#### 1-4. メインループに `updateSidebarStatus()` を追加

**場所:** `### メインループ` セクション（127行目付近）

**修正前:**
```
while (state.running):
  1. processQueue()          # キューメッセージ処理
  2. scanTasks()             # ready タスクを検出 → idle Conductor に割り当て
  3. monitorConductors()     # done マーカー検出、クラッシュ検出
  4. updateTeamJson()        # team.json を最新状態に同期
  5. sleep(pollInterval)     # デフォルト10秒
```

**修正後:**
```
while (state.running):
  1. processQueue()          # キューメッセージ処理
  2. scanTasks()             # ready タスクを検出 → idle Conductor に割り当て
  3. monitorConductors()     # done マーカー検出、クラッシュ検出
  4. updateTeamJson()        # team.json を最新状態に同期
  5. updateSidebarStatus()   # cmux サイドバーにステータスを反映
  6. sleep(pollInterval)     # デフォルト10秒
```

#### 1-5. daemon 説明文に workspace 名設定・resume ロジック・サイドバーステータスを追記

**場所:** `### メインループ` 直後の説明段落（139行目付近、「daemon は起動時に〜」で始まる段落の後）

**追記内容:**

```markdown
起動時にワークスペース名を `basename(PROJECT_ROOT)`（起動フォルダ名）に自動設定する（`cmux rename-workspace`）。

#### assigned タスクの resume

daemon 起動時（boot 完了後）に `task-state.json` で `status: assigned` のタスクを検出し、以下の条件を満たす場合は idle Conductor に割り当てて `cmux-team resume <task-id>` で再開する:

1. `sessionId` が記録されている
2. `worktreePath` が存在する
3. `taskRunId` が記録されている

条件を満たさない場合は `ready` に戻して通常の再割り当てにフォールバックする。既に同じタスクを実行中の Conductor がいる場合はスキップ（多重実行防止）。

`resume` コマンドは `claude --resume <sessionId>` でセッションを再開する。設定は `cmdConductor` と同等（`--dangerously-skip-permissions`, `--settings`, `--model`）。作業ディレクトリは `worktreePath` を使用。

#### サイドバーステータスのリアルタイム更新

メインループの各 tick で `cmux set-status` / `cmux clear-status` を通じてサイドバーにステータスを表示する。差分抑制（前回値と同一なら API 呼び出しスキップ）を行う。

| カテゴリ | 条件 | 表示 | アイコン | 色 |
|---------|------|------|---------|-----|
| error | disconnected Conductor あり | `! attention` | exclamationmark.triangle | 赤 |
| throttled | 5h utilization ≥ 90% or rate_limited | `⏸ reset Xm` | pause.circle.fill | 赤 |
| running | Conductor 稼働中 | `N running` (+pending) | bolt.fill | 青 |
| done | 全タスク完了（直前が idle/done 以外） | `done` | checkmark.circle.fill | 緑 |
| idle | デフォルト | `idle` | pause.circle.fill | グレー |

daemon 停止時に `cmux clear-status` でクリアする。
```

#### 1-6. レート制限スロットリングの記載

**場所:** `### プロキシサーバー` セクション（150行目付近、レート制限ヘッダーの記載の後に追記）

**追記内容:**

```markdown
#### 5h レート制限スロットリング

5h unified utilization が閾値（`THROTTLE_5H_THRESHOLD = 0.90`、90%）以上になると、`scanTasks()` で新規タスクの Conductor への割り当てを一時停止する。既に実行中のタスクは影響を受けない。TUI ダッシュボードにもスロットリング状態とリセット残り時間を表示する。
```

#### 1-7. CMUX_CLAUDE_HOOKS_DISABLED の適用範囲拡大

**場所:** `### Plugin hooks` セクション（Plugin hooks の説明、39行目付近）

**修正前:**
```markdown
Conductor 起動時は環境変数 `CMUX_CLAUDE_HOOKS_DISABLED=1` で cmux ラッパー側の hook を無効化し、Manager が生成する `conductor-settings.json` を `claude --settings` 経由で動的に注入する（hook 設定の優先順位問題への対応）。
```

**修正後:**
```markdown
Conductor・Agent・Master 起動時は環境変数 `CMUX_CLAUDE_HOOKS_DISABLED=1` で cmux ラッパー側の hook を無効化し、Manager が生成する `conductor-settings.json` を `claude --settings` 経由で動的に注入する（hook 設定の優先順位問題への対応）。Agent spawn 時は `spawn-agent` CLI 内で、Master 起動時は `spawn-master` CLI 内でそれぞれ設定される。
```

#### 1-8. worktree への .envrc 生成

**場所:** `### メインループ` 直後の説明段落内（「Conductor が worktree を初期化する際には〜」の後）

**追記内容:**

```markdown
また、プロジェクトルートに `.envrc` が存在する場合、worktree 内に `source_up` の `.envrc` を自動生成し、direnv による OAuth トークン等の環境変数を worktree に継承する。
```

#### 1-9. task-state.json の resume 用フィールド追記

**場所:** `### メッセージング` セクションの直後に新セクションとして追加、または `### CLI サブコマンド` セクションの `abort-task` 行の直後に注記

**追記方法:** `### メッセージング` セクションの後に以下を追加:

```markdown
### タスク状態の拡張フィールド（resume 用）

`task-state.json` の各タスクエントリに、タスク割り当て時（`assignTask`）に以下のフィールドが記録される:

| フィールド | 説明 |
|-----------|------|
| `worktreePath` | git worktree の絶対パス |
| `taskRunId` | タスク実行 ID（`task-NNN-TIMESTAMP` 形式） |
| `conductorSlot` | Conductor の surface ID（例: `"surface:5"`） |
| `sessionId` | Conductor の Claude セッション ID |

これらは daemon 再起動時の resume ロジックで使用される。`sessionId` は Conductor 初回起動時に `crypto.randomUUID()` で発行され、タスク割り当てやリセットで変更されない（常駐セッションのため）。
```

#### 1-10. SESSION_CLEAR で running Conductor を abort + idle リセット

**場所:** `### メッセージング` セクション（171行目付近）のメッセージ種別表の後に補足

**追記内容:**

```markdown
`SESSION_CLEAR` は Conductor が `/clear` を実行したときに送信される。Conductor が `running` 状態のときに `SESSION_CLEAR` を受信すると、ユーザーの手動 `/clear` とみなしてタスクを `aborted` に遷移させ、Conductor を idle にリセットする（`forceCloseDisconnectedConductor` と同パターン）。`idle` 状態の場合は何もしない（TUI チラつき防止）。
```

#### 1-11. TUI ダッシュボードにスロットリング表示を追記

**場所:** `### TUI ダッシュボード` セクション（157行目付近）の箇条書き内

**追記内容（既存の箇条書きに追加）:**
```markdown
- 5h レート制限スロットリング時にダッシュボードにリセット残り時間を表示
```

---

### 2. 01-skill-cmux-team.md（高・中）

#### 2-1. CLI サブコマンド表に `resume` を追加

**場所:** `### 1. コマンド一覧` → `**CLI サブコマンド:**` の表（84行目付近）

**修正:** `cmux-team artifacts` の直後に以下を追加:

```markdown
| `cmux-team resume` | assigned タスクの Conductor セッション再開（`<task-id>` positional 引数必須。`claude --resume` で再開） |
```

#### 2-2. CLI サブコマンド表: `update-task` の説明を更新

**場所:** 同表の `cmux-team update-task` 行（77行目）

**修正前:**
```markdown
| `cmux-team update-task` | タスク状態更新（`--task-id` 必須、`--status` / `--title` / `--body` のいずれか必須） |
```

**修正後:**
```markdown
| `cmux-team update-task` | タスク状態更新（`--task-id` 必須、`--status` / `--title` / `--body` / `--depends-on` のいずれか必須） |
```

#### 2-3. CLI サブコマンド表に `artifacts add` と `artifacts open` を追加

**場所:** 同表の `cmux-team artifacts` 行（84行目）

**修正前:**
```markdown
| `cmux-team artifacts` | アーティファクト一覧・検索 |
```

**修正後:**
```markdown
| `cmux-team artifacts` | アーティファクト一覧・検索 |
| `cmux-team artifacts add` | ファイルをアーティファクトとして登録（`<file>` 必須、`--type`, `--title`, `--task`, `--tags` 任意） |
| `cmux-team artifacts open` | Markdown ビューアでアーティファクトを開く（`<id>` 必須。ビューア: `CMUX_TEAM_MD_VIEWER` → `mo` → `cat` の順で決定） |
```

#### 2-4. 環境変数テーブルに CMUX_CLAUDE_HOOKS_DISABLED を追加

**場所:** `### 3. cmux 操作リファレンス` → `**環境変数:**` の表（114行目付近）

**追記:**

```markdown
| `CMUX_CLAUDE_HOOKS_DISABLED` | `1` に設定すると cmux ラッパーの hook を無効化。Conductor・Agent・Master 起動時に自動設定 |
```

#### 2-5. 環境変数テーブルに CMUX_TEAM_MD_VIEWER を追加

**場所:** 同表

**追記:**

```markdown
| `CMUX_TEAM_MD_VIEWER` | `artifacts open` で使用する Markdown ビューアのコマンド名。未設定時は `mo` → `cat` にフォールバック |
```

---

### 3. 03-commands.md（高・小）

#### 3-1. /docs-sync の変更なし

03-commands.md は Claude 内のスラッシュコマンドを定義するファイルであり、CLI サブコマンド（`resume`, `artifacts add`, `artifacts open`）はここには記載しない。

**確認結果: 変更不要。**

ただし、正確性のために以下を確認:
- `/artifact` コマンドの説明に `add` / `open` サブコマンドの言及がないが、これは CLI サブコマンド（`cmux-team artifacts add/open`）であり、スラッシュコマンド（`/artifact`）とは別。`/artifact` の Behavior セクションには直接の変更は不要。

→ **03-commands.md は変更不要** と判定。修正対象から除外。

---

### 4. 00-project-overview.md（中・小）

#### 4-1. task-state.json の拡張フィールドを Per-Project State セクションに注記

**場所:** `## Per-Project State（cmux-team start で作成）` セクション（86行目付近）の `task-state.json` の説明

**修正前:**
```markdown
├── task-state.json     # タスク状態管理（status: draft/ready/assigned/closed/aborted/deleted/archived）
```

**修正後:**
```markdown
├── task-state.json     # タスク状態管理（status + resume 用メタデータ: sessionId, worktreePath, taskRunId, conductorSlot）
```

---

### 5. 06-implementation-tasks.md（中・中）

#### 5-1. Phase 8 セクションを追加

**場所:** `## 追加改善（Phase 7 以降）— 完了済み` セクションの直後、`## 未実装の改善候補` セクションの直前に挿入

**追記内容:**

```markdown
---

## Phase 8: 運用改善（T127〜T141）— 完了済み

v3.35〜v3.38 で実施された主要改善:

### セッション復旧・永続化
- **worktree `.envrc` 生成（T127）** — `source_up` で親の `.envrc` を継承し、direnv 環境変数（OAuth トークン等）を worktree に引き継ぐ
- **`resume` コマンド（T128）** — daemon 再起動時に `task-state.json` の assigned タスクを `claude --resume` で自動復旧
- **Conductor `--session-id`（T132）** — Conductor 起動時に `crypto.randomUUID()` でセッション ID を発行し、resume 可能にする
- **resume 多重起動防止** — 既に同一タスクを実行中の Conductor がある場合はスキップ

### レート制限・スロットリング
- **5h レート制限超過で一時停止（T133）** — 5h unified utilization が閾値以上で新規タスク割り当てを停止＋TUI 表示
- **閾値を 95% → 90% に変更（T135）** — `THROTTLE_5H_THRESHOLD = 0.90`

### CLI サブコマンド追加
- **`artifacts add`（T131）** — 既存ファイルをアーティファクトとして登録（ID 自動採番、フロントマター自動生成）
- **`artifacts open`（T140）** — Markdown ビューアでアーティファクトを開く（`CMUX_TEAM_MD_VIEWER` → `mo` → `cat`）
- **`update-task --depends-on`（T136）** — タスク更新時に依存関係を変更可能

### Conductor・Agent・Master 管理
- **`CMUX_CLAUDE_HOOKS_DISABLED=1` の適用拡大（T130/T139）** — Conductor/Agent spawn 時（T130）+ spawn-master（T139）に追加
- **ワークスペース名の自動設定（T129）** — `cmux-team start` 時に `basename(PROJECT_ROOT)` をワークスペース名に設定
- **サイドバーステータスのリアルタイム更新（T137）** — `cmux set-status` で error/throttled/running/done/idle を表示、差分抑制付き
- **SESSION_CLEAR で running Conductor を abort + idle リセット（T141）** — ユーザー手動 `/clear` 時にタスクを aborted に遷移
- **/clear 方式への復帰** — タスク割り当て時の /exit + 再起動を /clear + 新プロンプト送信に戻す

### タスク状態管理
- **`task-state.json` に resume 用フィールド追加** — `worktreePath`, `taskRunId`, `conductorSlot`, `sessionId` を `assignTask` 時に記録
```

#### 5-2. 未実装の改善候補を更新

**場所:** `## 未実装の改善候補` セクション（222行目）

**修正前:**
```markdown
- レート制限のインテリジェント制御（プロキシでの自動スロットリング）
```

**修正後:**
```markdown
- レート制限のインテリジェント制御（5h 閾値スロットリングは実装済み、7d 制限や動的閾値調整は未実装）
```

---

### 6. 02-skill-cmux-agent-role.md（中・小）

#### 6-1. CMUX_CLAUDE_HOOKS_DISABLED の記載追加

**場所:** `### 1. エージェント識別` セクション（37行目付近）の「**完了したら停止するだけ。報告は不要。上位が監視する。**」の後

**追記内容:**

```markdown
**環境変数:** Agent は `CMUX_CLAUDE_HOOKS_DISABLED=1` が設定された状態で起動される。これにより cmux ラッパーの hook（Plugin hooks）が無効化され、Manager が生成する `conductor-settings.json` の hook のみが適用される。
```

---

### 7. 04-templates.md（低・変更不要）

テンプレートファイル自体に v3.35〜v3.38 での変更はない。テンプレート変数の追加もない。

**変更不要。**

---

## 変更の依存関係

```
05-install-and-infrastructure.md（最も詳細な実装仕様）
  ↓ 参照
01-skill-cmux-team.md（CLI 一覧・環境変数はここを見る）
  ↓ 参照
00-project-overview.md（概要レベルの記述のみ）
  ↓ 並列
02-skill-cmux-agent-role.md（Agent 視点の記載）
  ↓ 並列
06-implementation-tasks.md（タスク履歴の追加）
```

推奨作業順: 05 → 01 → 00 → 02 → 06（詳細→概要の順で整合性を保つ）

---

## 注意事項

### 文体・構造の維持方針

1. **見出しレベル**: 各ファイルの既存の見出しレベル（`##`, `###`）に合わせる
2. **テーブル記法**: 既存テーブルのカラム幅・記述粒度に揃える
3. **コードブロック**: 既存の `bash` / `markdown` 言語指定に合わせる
4. **情報の重複**: 各ファイルは独立して読める必要があるが、過度な重複は避ける。詳細は 05 に、概要は 01 に書く
5. **英語/日本語**: docs/spec/ の本文は日本語で統一されている。コマンド名・オプション名・環境変数名は英語のまま

### 検証すべきポイント

- `THROTTLE_5H_THRESHOLD` の値は `0.90`（90%）であること（`schema.ts` で定義）
- `resume` コマンドの引数は `<task-id>`（`--task-id` ではなく positional argument）。`main.ts:938` の `cmdResume()` で実装
- `artifacts add` の引数は `<file>`（positional）+ `--type`, `--title`, `--task`, `--tags`（named）。`main.ts:1817` で実装
- `artifacts open` の引数は `<id>`（positional）。ビューア優先順位: `CMUX_TEAM_MD_VIEWER` → `mo` → `cat`。`main.ts:1862` で実装
- `CMUX_CLAUDE_HOOKS_DISABLED=1` は Conductor（`conductor.ts` の `launchConductorOnSurface` + `spawnConductor`）、Agent（`main.ts` の `cmdSpawnAgent`）、Master（`main.ts` の `cmdLaunchMaster`）、Resume（`main.ts` の `cmdResume`）の4箇所で設定
- `sessionId` は Conductor 初回起動時に `crypto.randomUUID()` で発行（`conductor.ts` の `spawnSingleConductor` と `launchConductorOnSurface`）。タスク割り当て（`/clear` 方式）やリセットでは変更されない。`abort-task` / `restart-task` 時は新しい session-id を発行
- `SESSION_CLEAR` で running Conductor をリセットするのは `daemon.ts` の `handleMessage` 内（`db17757`）
- `cmux rename-workspace` は `cmux.ts` の `renameWorkspace()` で実装。`cmdStart()` の Conductor スロット作成前に呼ばれる
- worktree `.envrc` 生成条件: プロジェクトルートに `.envrc` が存在する場合のみ。`conductor.ts` の `assignTask()` 内（worktree ブートストラップの直前）

### 03-commands.md を変更不要とした理由

今回追加された `resume`, `artifacts add`, `artifacts open`, `update-task --depends-on` はすべて CLI サブコマンド（`cmux-team ...`）であり、Claude セッション内のスラッシュコマンド（`/master`, `/team-task` 等）ではないため、03-commands.md の対象外。
